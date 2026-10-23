/**
 * Painel de várias filiais numa única leitura.
 * A última medição segue por pneu (LATERAL), apoiada em idx_medicoes_pneu_recente.
 *
 * A chave é só a lista de filiais que a rota já autorizou. Admin e gerente
 * não compartilham entrada. Um pedido menor pode fatiar uma entrada maior,
 * e a resposta devolve apenas os ids pedidos.
 *
 * A frota do diagnóstico executivo não alimenta este mapa: o painel exige
 * cadastro completo, conta descarte e monta a recapagem pelas movimentações.
 * Reusar aquelas linhas mudaria os totais.
 *
 * Validade curta, a mesma da frota executiva. Gravação confirmada chama
 * invalidarPainelFiliais. Duas chamadas simultâneas da mesma chave esperam
 * a mesma ida ao banco: a lista pede a base e o consolidado pede a base
 * mais as recapagens.
 */
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import {
  VALIDADE_SNAPSHOT_EXECUTIVO_MS,
  agoraCacheExecutivo,
  filaUnica,
} from './frota-executiva-compartilhada.js';
import { filtroCadastroCompleto } from '../schema-colunas.js';
import { classificarSulco, limitesDoVeiculo, menorSulco } from '../limites.js';
import {
  acumularAlerta,
  avaliarPneuPainel,
  contarAcaoLegada,
  indicadoresUso,
  novoAcumulador,
  statusPainel,
  unidadeUsoVeiculo,
  veiculoCombinaTipo,
} from './indicadores-frota.js';
import { labelPosicao } from '../pneus-layouts.js';

function bucketVazio() {
  return {
    veiculos: [],
    counts: { em_recapagem: 0, em_descarte: 0, em_estoque: 0 },
    montados: [],
    recaps: [],
  };
}

function normalizarIds(filialIds) {
  const ids = [];
  const vistos = new Set();
  for (const bruto of filialIds || []) {
    const id = Number(bruto);
    if (!Number.isInteger(id) || id <= 0 || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  return ids;
}

function marcas(ids) {
  return ids.map(() => '?').join(',');
}

function sqlMontados(cadVeiculoAlias, lista) {
  return `
    SELECT
      v.filial_id,
      p.id,
      p.id as pneu_id,
      p.vida_recap,
      p.posicao,
      p.numero_fogo,
      p.marca as pneu_marca,
      p.tipo_pneu,
      p.condicao,
      p.sulco_inicial_mm,
      v.id as veiculo_id,
      v.tipo,
      v.tipo as veiculo_tipo,
      v.layout_pneus,
      v.km_atual,
      v.hr_atual,
      v.placa,
      v.apelido,
      um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar, um.sulco_mm,
      um.inspecao_danos, um.data_medicao, um.diagnostico, um.km_veiculo
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND ${cadVeiculoAlias}
    ${SQL_LATERAL_ULTIMA_MEDICAO}
    WHERE p.ativo = 1 AND p.status_pneu = 'montado'
      AND v.filial_id IN (${lista})
  `;
}

function sqlRecaps(lista) {
  return `
    SELECT
      p.filial_id,
      p.id as pneu_id,
      p.numero_fogo,
      p.marca as pneu_marca,
      p.tipo_pneu,
      p.condicao,
      p.vida_recap,
      p.sulco_inicial_mm,
      um.sulco_externo,
      um.sulco_central,
      um.sulco_interno,
      um.sulco_auxiliar,
      um.data_medicao,
      env.data_evento as data_envio,
      ret.veiculo_placa as placa_origem,
      ret.posicao as posicao_origem
    FROM pneus p
    LEFT JOIN LATERAL (
      SELECT sulco_externo, sulco_central, sulco_interno, sulco_auxiliar, data_medicao
      FROM medicoes
      WHERE pneu_id = p.id
      ORDER BY data_medicao DESC, id DESC
      LIMIT 1
    ) um ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.data_evento
      FROM movimentacoes m
      WHERE m.pneu_id = p.id AND m.tipo IN ('recap', 'retirada')
      ORDER BY m.id DESC
      LIMIT 1
    ) env ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.veiculo_placa, m.posicao
      FROM movimentacoes m
      WHERE m.pneu_id = p.id AND m.tipo = 'retirada'
      ORDER BY m.id DESC
      LIMIT 1
    ) ret ON TRUE
    WHERE p.filial_id IN (${lista})
      AND p.ativo = 1
      AND p.status_pneu = 'recapagem'
    ORDER BY p.filial_id, COALESCE(env.data_evento, '1970-01-01') DESC, p.numero_fogo
  `;
}

/**
 * Consultas agrupadas do painel, para medição e EXPLAIN.
 * Os filtros de cadastro são os mesmos fragmentos já usados nas rotas.
 */
export function sqlsDoPainel({
  cadVeiculo,
  cadVeiculoAlias,
  cadPneu,
  quantidade,
  comPendencias = false,
}) {
  const lista = Array.from({ length: quantidade }, () => '?').join(',');
  const saida = {
    veiculos: `
      SELECT id, filial_id, tipo, layout_pneus, km_atual, hr_atual
      FROM veiculos
      WHERE ativo = 1 AND ${cadVeiculo} AND filial_id IN (${lista})
    `,
    contagens: `
      SELECT
        filial_id,
        COUNT(*) FILTER (WHERE ativo = 1 AND status_pneu = 'recapagem') as em_recapagem,
        COUNT(*) FILTER (WHERE status_pneu = 'descarte') as em_descarte,
        COUNT(*) FILTER (WHERE ativo = 1 AND status_pneu = 'estoque' AND ${cadPneu}) as em_estoque
      FROM pneus
      WHERE filial_id IN (${lista})
      GROUP BY filial_id
    `,
    montados: sqlMontados(cadVeiculoAlias, lista),
  };
  if (comPendencias) saida.recaps = sqlRecaps(lista);
  return saida;
}

const MAX_PAINEL = 8;
let geracaoPainel = 0;
let pisoGlobal = 0;
const pisoFilial = new Map();
const cachePainel = new Map();
const voosBase = new Map();
const voosRecap = new Map();
const seloPainel = new Map();
const contagemPainel = { leituras: 0, reusos: 0, recaps: 0 };

export function limparCachePainelFiliais() {
  geracaoPainel += 1;
  pisoGlobal = 0;
  pisoFilial.clear();
  cachePainel.clear();
  voosBase.clear();
  voosRecap.clear();
  seloPainel.clear();
  contagemPainel.leituras = 0;
  contagemPainel.reusos = 0;
  contagemPainel.recaps = 0;
}

function marcaPainel(chave) {
  return `${geracaoPainel}:${seloPainel.get(chave) || 0}`;
}

function chaveIds(ids) {
  return ids.join(',');
}

function idsDaChave(chave) {
  return String(chave || '').split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

function chaveCobreFilial(chave, filialId) {
  return idsDaChave(chave).includes(Number(filialId));
}

/** filialId numérico: só as chaves que incluem a unidade. Sem id: todas. */
export function invalidarPainelFiliais(filialId = null) {
  const id = Number(filialId);
  const todas = !Number.isInteger(id) || id <= 0;
  if (todas) pisoGlobal += 1;
  else pisoFilial.set(id, (pisoFilial.get(id) || 0) + 1);
  const chaves = new Set([...cachePainel.keys(), ...voosBase.keys(), ...voosRecap.keys()]);
  for (const chave of chaves) {
    if (!todas && !chaveCobreFilial(chave, id)) continue;
    seloPainel.set(chave, (seloPainel.get(chave) || 0) + 1);
    cachePainel.delete(chave);
    voosBase.delete(chave);
    voosRecap.delete(chave);
  }
}

/**
 * Selo barato, sem SQL. Escopo null é a leitura irrestrita (admin).
 * Uma lista de ids só muda quando o piso global muda ou uma dessas filiais muda.
 */
export function revisaoPainelFiliais(escopo) {
  if (escopo == null) {
    let soma = pisoGlobal;
    for (const valor of pisoFilial.values()) soma += valor;
    return `irrestrito:${soma}`;
  }
  const ids = normalizarIds(escopo);
  const partes = ids.map((id) => `${id}.${pisoFilial.get(id) || 0}`);
  return `${pisoGlobal}|${partes.join(',')}`;
}

export function estatisticasPainelFiliais() {
  return {
    leituras: contagemPainel.leituras,
    reusos: contagemPainel.reusos,
    recaps: contagemPainel.recaps,
    entradas: cachePainel.size,
    emVoo: voosBase.size + voosRecap.size,
  };
}

function fresca(hit) {
  return Boolean(hit) && (agoraCacheExecutivo() - hit.em < VALIDADE_SNAPSHOT_EXECUTIVO_MS);
}

function guardarPainel(chave, mapa, ids, temRecaps, marca) {
  if (marca !== marcaPainel(chave)) return;
  cachePainel.set(chave, {
    em: agoraCacheExecutivo(),
    mapa,
    ids,
    temRecaps,
  });
  if (cachePainel.size <= MAX_PAINEL) return;
  const antigo = [...cachePainel.entries()].sort((a, b) => a[1].em - b[1].em)[0];
  if (antigo && antigo[0] !== chave) cachePainel.delete(antigo[0]);
}

function fatiarMapa(mapa, ids) {
  const saida = new Map();
  for (const id of ids) {
    const bucket = mapa.get(id);
    if (!bucket) {
      saida.set(id, bucketVazio());
      continue;
    }
    saida.set(id, {
      veiculos: bucket.veiculos,
      counts: bucket.counts,
      montados: bucket.montados,
      recaps: bucket.recaps.slice(),
    });
  }
  return saida;
}

function lerExato(ids, comPendencias) {
  const hit = cachePainel.get(chaveIds(ids));
  if (!fresca(hit)) return null;
  if (comPendencias && !hit.temRecaps) return null;
  contagemPainel.reusos += 1;
  return hit.mapa;
}

function lerSuperset(ids, comPendencias) {
  let melhor = null;
  for (const hit of cachePainel.values()) {
    if (!fresca(hit)) continue;
    if (comPendencias && !hit.temRecaps) continue;
    if (hit.ids.length <= ids.length) continue;
    if (!ids.every((id) => hit.ids.includes(id))) continue;
    if (!melhor || hit.ids.length < melhor.ids.length) melhor = hit;
  }
  if (!melhor) return null;
  contagemPainel.reusos += 1;
  return fatiarMapa(melhor.mapa, ids);
}

function distribuir(mapa, veiculos, contagens, montados, recaps) {
  for (const veiculo of veiculos || []) {
    const bucket = mapa.get(Number(veiculo.filial_id));
    if (bucket) bucket.veiculos.push(veiculo);
  }
  for (const linha of contagens || []) {
    const bucket = mapa.get(Number(linha.filial_id));
    if (!bucket) continue;
    bucket.counts = {
      em_recapagem: Number(linha.em_recapagem || 0),
      em_descarte: Number(linha.em_descarte || 0),
      em_estoque: Number(linha.em_estoque || 0),
    };
  }
  for (const pneu of montados || []) {
    const bucket = mapa.get(Number(pneu.filial_id));
    if (bucket) bucket.montados.push(pneu);
  }
  for (const recap of recaps || []) {
    const bucket = mapa.get(Number(recap.filial_id));
    if (bucket) bucket.recaps.push(recap);
  }
  return mapa;
}

async function filtrosDoPainel(db) {
  const cadVeiculo = await filtroCadastroCompleto(db, 'veiculos');
  const cadVeiculoAlias = await filtroCadastroCompleto(db, 'veiculos', 'v.cadastro_completo');
  const cadPneu = await filtroCadastroCompleto(db, 'pneus');
  return { cadVeiculo, cadVeiculoAlias, cadPneu };
}

async function preencherBase(db, ids) {
  const filtros = await filtrosDoPainel(db);
  const sql = sqlsDoPainel({ ...filtros, quantidade: ids.length, comPendencias: false });
  contagemPainel.leituras += 1;
  const [veiculos, contagens, montados] = await Promise.all([
    db.prepare(sql.veiculos).all(...ids),
    db.prepare(sql.contagens).all(...ids),
    db.prepare(sql.montados).all(...ids),
  ]);
  return distribuir(new Map(ids.map((id) => [id, bucketVazio()])), veiculos, contagens, montados);
}

async function consultarRecaps(db, ids) {
  const filtros = await filtrosDoPainel(db);
  const sql = sqlsDoPainel({ ...filtros, quantidade: ids.length, comPendencias: true });
  contagemPainel.recaps += 1;
  return db.prepare(sql.recaps).all(...ids);
}

async function garantirBase(db, ids) {
  const chave = chaveIds(ids);
  const hit = cachePainel.get(chave);
  if (fresca(hit)) return hit.mapa;
  const amplo = lerSuperset(ids, false);
  if (amplo) return amplo;
  const marca = marcaPainel(chave);
  return filaUnica(voosBase, chave, async () => {
    const ja = cachePainel.get(chave);
    if (fresca(ja)) return ja.mapa;
    const carregado = await preencherBase(db, ids);
    guardarPainel(chave, carregado, ids, false, marca);
    return carregado;
  });
}

async function carregarComRecaps(db, ids) {
  const cheio = lerExato(ids, true) || lerSuperset(ids, true);
  if (cheio) return cheio;
  const chave = chaveIds(ids);
  const marca = marcaPainel(chave);
  return filaUnica(voosRecap, chave, async () => {
    const ja = lerExato(ids, true) || lerSuperset(ids, true);
    if (ja) return ja;
    const base = await garantirBase(db, ids);
    const hit = cachePainel.get(chave);
    const proprio = Boolean(hit && hit.mapa === base && fresca(hit));
    const destino = proprio ? base : fatiarMapa(base, ids);
    const recaps = await consultarRecaps(db, ids);
    if (marca !== marcaPainel(chave)) return distribuir(destino, [], [], [], recaps);
    distribuir(destino, [], [], [], recaps);
    if (proprio) {
      hit.temRecaps = true;
      hit.em = agoraCacheExecutivo();
    } else {
      guardarPainel(chave, destino, ids, true, marca);
    }
    return destino;
  });
}

export async function carregarPainelFiliais(db, filialIds, { comPendencias = false } = {}) {
  const ids = normalizarIds(filialIds);
  if (!ids.length) return new Map();
  if (comPendencias) return carregarComRecaps(db, ids);
  const exato = lerExato(ids, false);
  if (exato) return exato;
  const amplo = lerSuperset(ids, false);
  if (amplo) return amplo;
  return garantirBase(db, ids);
}

export function calcularResumoFilial(painel, tipoFiltro = null) {
  const dados = painel || bucketVazio();
  const veiculosLista = dados.veiculos.filter((v) => veiculoCombinaTipo(v.tipo, tipoFiltro));
  const veiculos = veiculosLista.length;
  const emRecapagem = Number(dados.counts?.em_recapagem || 0);
  const emDescarte = Number(dados.counts?.em_descarte || 0);
  const emEstoque = Number(dados.counts?.em_estoque || 0);

  const acc = novoAcumulador();
  const accKm = novoAcumulador();
  const accHoras = novoAcumulador();
  let ultimaMedicao = null;

  for (const p of dados.montados) {
    if (!veiculoCombinaTipo(p.tipo, tipoFiltro)) continue;
    const aval = avaliarPneuPainel({
      vida_recap: p.vida_recap,
      posicao: p.posicao,
      tipo: p.tipo,
      layout_pneus: p.layout_pneus,
      km_atual: p.km_atual,
      hr_atual: p.hr_atual,
      sulco_externo: p.sulco_externo,
      sulco_central: p.sulco_central,
      sulco_interno: p.sulco_interno,
      sulco_auxiliar: p.sulco_auxiliar,
      sulco_mm: p.sulco_mm,
      inspecao_danos: p.inspecao_danos,
    }, { limites: limitesDoVeiculo(p) });
    const unidade = unidadeUsoVeiculo(p.tipo, p.layout_pneus);
    acumularAlerta(acc, aval);
    acumularAlerta(unidade === 'horas' ? accHoras : accKm, aval);

    if (p.data_medicao && (!ultimaMedicao || p.data_medicao > ultimaMedicao)) {
      ultimaMedicao = p.data_medicao;
    }
  }

  let diasSemMedicao = null;
  if (ultimaMedicao) {
    const diff = Date.now() - new Date(`${ultimaMedicao}T12:00:00`).getTime();
    diasSemMedicao = Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  return {
    veiculos_ativos: veiculos,
    pneus_total: acc.ok + acc.monitorar + acc.critico + acc.sem_dado,
    pneus_ok: acc.ok,
    pneus_alerta: acc.monitorar,
    pneus_critico: acc.critico,
    pneus_sem_dado: acc.sem_dado,
    pneus_em_recapagem: emRecapagem,
    pneus_em_descarte: emDescarte,
    pneus_em_estoque: emEstoque,
    acoes: { troca: acc.troca, recap: emRecapagem, monitorar: acc.acao_monitorar, recap_sugerido: acc.recap },
    compras: {
      pneus_para_comprar: acc.troca,
      pneus_para_recap: emRecapagem,
      pneus_monitorar: acc.acao_monitorar,
    },
    indicadores_uso: indicadoresUso(veiculosLista, accKm, accHoras),
    filtro_tipo: tipoFiltro || null,
    ultima_medicao: ultimaMedicao,
    dias_sem_medicao: diasSemMedicao,
    precisa_medir_semana: diasSemMedicao == null ? veiculos > 0 : diasSemMedicao >= 7,
  };
}

function formatarRecap(p) {
  const menor = menorSulco(p);
  return {
    pneu_id: p.pneu_id,
    veiculo_id: null,
    placa: p.placa_origem || '—',
    apelido: 'Em recapagem',
    veiculo_tipo: null,
    km_atual: null,
    posicao: p.posicao_origem || null,
    posicao_label: p.posicao_origem ? labelPosicao(p.posicao_origem) : '—',
    numero_fogo: p.numero_fogo,
    pneu_marca: p.pneu_marca,
    tipo_pneu: p.tipo_pneu,
    condicao: p.condicao,
    vida_recap: p.vida_recap,
    menor_sulco: menor,
    status_sulco: classificarSulco(menor),
    sulcos: {
      m1: p.sulco_externo,
      m2: p.sulco_central,
      m3: p.sulco_interno,
      m4: p.sulco_auxiliar,
    },
    data_medicao: p.data_envio || p.data_medicao,
    diagnostico: 'recapagem',
    diagnostico_label: 'Em processo',
    acao_sugerida: 'recap',
    acao_label: 'Em recapagem',
    acao_motivo: `Enviado à recap (${p.vida_recap || 1}ª vida). Quando voltar, devolva ao estoque (WhatsApp *6* ou aba Pneus).`,
    em_recapagem: true,
  };
}

export function calcularPendenciasFilial(painel, tipoFiltro = null) {
  const dados = painel || bucketVazio();
  const itens = dados.montados
    .filter((p) => veiculoCombinaTipo(p.veiculo_tipo, tipoFiltro))
    .map((p) => {
      const limV = limitesDoVeiculo({ tipo: p.veiculo_tipo, layout_pneus: p.layout_pneus });
      const aval = avaliarPneuPainel({ ...p, tipo: p.veiculo_tipo }, { limites: limV });
      const menor = aval.menor_sulco;
      const status = statusPainel(aval);
      const diag = aval.diagnostico || {};
      const acao = aval.acao || {};
      const unidade = unidadeUsoVeiculo(p.veiculo_tipo, p.layout_pneus);
      return {
        pneu_id: p.pneu_id,
        veiculo_id: p.veiculo_id,
        placa: p.placa,
        apelido: p.apelido,
        veiculo_tipo: p.veiculo_tipo,
        km_atual: unidade === 'km' ? p.km_atual : null,
        hr_atual: unidade === 'horas' ? p.hr_atual : null,
        unidade_uso: unidade,
        posicao: p.posicao,
        posicao_label: labelPosicao(p.posicao),
        numero_fogo: p.numero_fogo,
        pneu_marca: p.pneu_marca,
        tipo_pneu: p.tipo_pneu,
        condicao: p.condicao,
        vida_recap: p.vida_recap,
        menor_sulco: menor,
        status_sulco: status,
        sulcos: {
          m1: p.sulco_externo,
          m2: p.sulco_central,
          m3: p.sulco_interno,
          m4: p.sulco_auxiliar,
        },
        data_medicao: p.data_medicao,
        diagnostico: diag.codigo,
        diagnostico_label: diag.label,
        diagnostico_desc: diag.descricao || '',
        acao_sugerida: acao.codigo,
        acao_label: acao.label,
        acao_motivo: acao.motivo,
      };
    });

  const pendentesMontados = itens
    .filter((i) => {
      const leg = contarAcaoLegada(i.acao_sugerida);
      return leg === 'troca' || leg === 'monitorar' || leg === 'rodizio';
    })
    .sort((a, b) => {
      const ordem = { troca: 0, substituir: 0, corte: 0, dano_lateral: 0, monitorar: 1, rodizio: 2 };
      return (ordem[a.acao_sugerida] ?? 9) - (ordem[b.acao_sugerida] ?? 9)
        || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99);
    });

  const emRecapagem = (dados.recaps || []).map(formatarRecap);
  const troca = pendentesMontados.filter((i) => contarAcaoLegada(i.acao_sugerida) === 'troca');
  const monitorar = pendentesMontados.filter((i) => {
    const leg = contarAcaoLegada(i.acao_sugerida);
    return leg === 'monitorar' || leg === 'rodizio';
  });
  const todos = [...troca, ...emRecapagem, ...monitorar];
  const ordemDiag = {
    critico: 0, falta_calib: 1, excesso_calib: 2, irregular: 3, desgaste_progressivo: 4,
  };
  const diagnosticos = itens
    .filter((i) => i.diagnostico && i.diagnostico !== 'ok' && i.diagnostico !== 'sem_dado')
    .sort((a, b) => (ordemDiag[a.diagnostico] ?? 9) - (ordemDiag[b.diagnostico] ?? 9)
      || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99));

  return {
    troca,
    recap: emRecapagem,
    monitorar,
    todos,
    diagnosticos,
  };
}
