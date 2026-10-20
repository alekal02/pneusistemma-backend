/**
 * Monta o relatório de saúde e desgaste a partir do que já está gravado.
 * Somente leitura.
 */
import { getLimites, limitesDoVeiculo } from '../limites.js';
import { dataISOBrasil } from '../dia-medicao.js';
import { especificacaoMedicao, normalizarInspecao } from '../medicao-perfil.js';
import { papelPosicao } from '../pneus-layouts.js';
import { resolverTipoEquipamento } from '../equipamento-tipos.js';
import { separarPorCiclo } from './pneu-ciclo.js';
import {
  FAIXAS,
  LIMITACOES_FIXAS,
  aplicarComparacao,
  cicloMensalDe,
  montarAnalisePneu,
  montarParecerExecutivo,
  leituraSulco,
  montarPrevisaoFilial,
  normalizarMedida,
  resumirFaixas,
} from './saude-desgaste.js';

const RANK_FAIXA = {
  critico: 0,
  critico_equipamento: 1,
  programar_recapagem: 2,
  monitoramento_preventivo: 3,
  monitoramento_equipamento: 4,
  sem_medicao: 5,
  acompanhamento_normal: 6,
  acompanhamento_equipamento: 7,
  sem_regua: 8,
};

function piorFaixa(atual, proxima) {
  if (!proxima) return atual;
  if (!atual) return proxima;
  return (RANK_FAIXA[atual] ?? 9) <= (RANK_FAIXA[proxima] ?? 9) ? atual : proxima;
}

function danosDaMedicao(valor) {
  const insp = normalizarInspecao(valor);
  if (insp.erro) return { danos: [], legivel: false };
  return { danos: insp.dados?.itens || [], legivel: true };
}

/**
 * Unidade Matriz e filiais E2E desligadas ficam fora do executivo.
 * O cadastro delas não é apagado.
 */
export function filialForaDoIndicadorExecutivo(filial) {
  const codigo = String(filial?.codigo || '').trim().toUpperCase();
  if (codigo === 'MATRIZ') return true;
  const ativa = Number(filial?.ativo) === 1;
  if (ativa) return false;
  const nome = String(filial?.nome || '').toUpperCase();
  return codigo.startsWith('E2E') || nome.includes('E2E');
}

export function alertaCompraIncompleta(montadosSemMedida) {
  const qtd = Number(montadosSemMedida) || 0;
  if (qtd <= 0) {
    return { definitivo: true, montados_sem_medida: 0, texto: null };
  }
  return {
    definitivo: false,
    montados_sem_medida: qtd,
    texto: `${qtd} pneu(s) montado(s) estão sem dimensão comercial. A necessidade técnica continua visível. A quantidade de compra não é definitiva: sem a especificação, o estoque compatível não foi conferido.`,
  };
}

/**
 * Sulco ilegível. Dimensão comercial ausente, medição antiga e equipamento
 * sem a régua de caminhão não entram aqui: cada um tem contagem própria.
 */
export function montadoIncompleto(pneu) {
  if (pneu?.status_pneu !== 'montado') return false;
  const leitura = pneu.leitura_sulco || leituraSulco(pneu);
  return leitura === 'sem_historico' || leitura === 'invalida' || leitura === 'parcial';
}

export function resumirLeituraSulco(montados, ciclo) {
  const acc = {
    sem_historico: 0,
    invalida: 0,
    parcial: 0,
    vencida: 0,
    ciclo_anterior: 0,
    no_ciclo: 0,
    nao_exigivel: 0,
  };
  for (const pneu of montados || []) {
    const leitura = pneu.leitura_sulco || leituraSulco(pneu, ciclo);
    if (acc[leitura] != null) acc[leitura] += 1;
  }
  return acc;
}

function diaIso(valor) {
  if (!valor) return null;
  const s = String(valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Entrada em operação: última montagem, ou a data de instalação. Não cria medição. */
export function dataEntradaOperacao(pneu, movimentacoes = []) {
  const montagens = (movimentacoes || [])
    .filter((movimento) => movimento?.tipo === 'montagem')
    .map((movimento) => diaIso(movimento.data_evento))
    .filter(Boolean)
    .sort();
  if (montagens.length) return montagens[montagens.length - 1];
  return diaIso(pneu?.data_instalacao);
}

export function contagemCondicao(faixas) {
  const item = faixas || {};
  return {
    bom: (Number(item.acompanhamento_normal) || 0) + (Number(item.acompanhamento_equipamento) || 0),
    atencao: (Number(item.monitoramento_preventivo) || 0)
      + (Number(item.monitoramento_equipamento) || 0)
      + (Number(item.programar_recapagem) || 0),
    criticos: (Number(item.critico) || 0) + (Number(item.critico_equipamento) || 0),
  };
}

/**
 * Ciclo mensal da medição. Ausência de data não vira medição do mês.
 * Medição do mês anterior ainda no prazo não é atraso.
 */
export function situacaoAtualizacaoMensal(montados, ciclo) {
  const lista = montados || [];
  const leitura = resumirLeituraSulco(lista, ciclo);
  const datas = lista.map((pneu) => pneu.data_medicao).filter(Boolean).sort();
  const ultima = datas.length ? datas[datas.length - 1] : null;
  let situacao = 'sem_medicao';
  if (!lista.length) situacao = 'sem_pneu';
  else if (leitura.vencida > 0) situacao = 'vencida';
  else if (
    leitura.sem_historico > 0
    && leitura.no_ciclo + leitura.ciclo_anterior + leitura.nao_exigivel === 0
    && leitura.parcial + leitura.invalida === 0
  ) situacao = 'sem_medicao';
  else if (leitura.sem_historico > 0 || leitura.parcial > 0 || leitura.invalida > 0) situacao = 'parcial';
  else if (leitura.ciclo_anterior > 0) situacao = 'ciclo_anterior';
  else if (leitura.no_ciclo > 0) situacao = 'no_ciclo';
  else if (leitura.nao_exigivel === lista.length) situacao = 'nao_exigivel';
  return {
    ultima_medicao: ultima,
    situacao_mes: situacao,
    medidos_no_ciclo: leitura.no_ciclo,
    leitura_sulco: leitura,
  };
}

/** Tipo real (tipo_codigo) define perfil, recapagem e se o uso é km ou horas. */
export function contextoEquipamento(pneu) {
  const tipoReal = pneu.tipo_codigo || pneu.tipo;
  const catalogo = resolverTipoEquipamento(tipoReal);
  const spec = especificacaoMedicao(tipoReal, pneu.layout_pneus);
  const perfil = catalogo?.perfil_medicao || spec.codigo || 'caminhao';
  const unidadeCatalogo = catalogo?.unidade_uso;
  const unidade = unidadeCatalogo === 'horas' || unidadeCatalogo === 'km'
    ? unidadeCatalogo
    : (spec.unidade === 'horas' ? 'horas' : 'km');
  const permiteRecap = catalogo ? catalogo.permite_recap === true : perfil === 'caminhao';
  return { perfil, unidade, permiteRecap, catalogo };
}

export async function carregarRelatorioSaude(db, { filialId = null } = {}) {
  const limites = getLimites();
  const filtroFilial = filialId != null && Number.isFinite(Number(filialId)) ? Number(filialId) : null;
  const whereFilial = filtroFilial ? ' AND p.filial_id = ?' : '';
  const args = filtroFilial ? [filtroFilial] : [];

  const [filiais, pneusRows, medicoes, movimentacoes, descartesRows, movimentosDescarte, veiculosAtivos] = await Promise.all([
    db.prepare(`
      SELECT id, nome, codigo, ativo
      FROM filiais
      ${filtroFilial ? 'WHERE id = ?' : ''}
      ORDER BY nome
    `).all(...(filtroFilial ? [filtroFilial] : [])),
    db.prepare(`
      SELECT
        p.id, p.filial_id, p.veiculo_id, p.posicao, p.marca, p.modelo, p.medida,
        p.numero_fogo, p.tipo_pneu, p.condicao, p.vida_recap, p.status_pneu,
        p.data_instalacao,
        v.placa, v.apelido, v.tipo, v.tipo_codigo, v.layout_pneus,
        f.nome AS filial_nome, f.codigo AS filial_codigo
      FROM pneus p
      JOIN filiais f ON f.id = p.filial_id
      LEFT JOIN veiculos v ON v.id = p.veiculo_id
      WHERE p.ativo = 1
        AND p.status_pneu IS DISTINCT FROM 'descarte'
        ${whereFilial}
    `).all(...args),
    db.prepare(`
      SELECT
        m.id, m.pneu_id, m.data_medicao, m.created_at, m.km_veiculo, m.hr_veiculo,
        m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar,
        m.inspecao_danos, m.ciclo, m.posicao, m.veiculo_id
      FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      WHERE p.ativo = 1
        AND p.status_pneu IS DISTINCT FROM 'descarte'
        ${whereFilial}
    `).all(...args),
    db.prepare(`
      SELECT
        mv.id, mv.pneu_id, mv.tipo, mv.data_evento, mv.created_at, mv.ciclo,
        mv.km_veiculo, mv.hr_veiculo, mv.sulco_mm, mv.sulco_antes, mv.sulco_depois,
        mv.detalhes, mv.posicao, mv.veiculo_id
      FROM movimentacoes mv
      JOIN pneus p ON p.id = mv.pneu_id
      WHERE p.ativo = 1
        AND p.status_pneu IS DISTINCT FROM 'descarte'
        ${whereFilial}
    `).all(...args),
    db.prepare(`
      SELECT
        p.id, p.filial_id, p.numero_fogo, p.medida,
        p.tratamento_descarte_obs, p.tratamento_descarte_em,
        f.nome AS filial_nome, f.codigo AS filial_codigo
      FROM pneus p
      JOIN filiais f ON f.id = p.filial_id
      WHERE p.status_pneu = 'descarte'
        ${whereFilial}
    `).all(...args),
    db.prepare(`
      SELECT mv.pneu_id, mv.data_evento, mv.motivo, mv.detalhes
      FROM movimentacoes mv
      JOIN pneus p ON p.id = mv.pneu_id
      WHERE mv.tipo = 'descarte'
        ${whereFilial}
      ORDER BY mv.data_evento DESC, mv.id DESC
    `).all(...args),
    db.prepare(`
      SELECT filial_id, COUNT(*)::int AS n
      FROM veiculos
      WHERE ativo = 1
      ${filtroFilial ? 'AND filial_id = ?' : ''}
      GROUP BY filial_id
    `).all(...(filtroFilial ? [filtroFilial] : [])),
  ]);

  const excluidas = filiais.filter(filialForaDoIndicadorExecutivo);
  const idsFora = new Set(excluidas.map((f) => f.id));
  const filiaisExec = filiais.filter((f) => !idsFora.has(f.id));
  const pneusExec = pneusRows.filter((p) => !idsFora.has(p.filial_id));
  const idsPneu = new Set(pneusExec.map((p) => p.id));

  const medPorPneu = new Map();
  const movPorPneu = new Map();
  for (const m of medicoes) {
    if (!idsPneu.has(m.pneu_id)) continue;
    if (!medPorPneu.has(m.pneu_id)) medPorPneu.set(m.pneu_id, []);
    medPorPneu.get(m.pneu_id).push(m);
  }
  for (const mv of movimentacoes) {
    if (!idsPneu.has(mv.pneu_id)) continue;
    if (!movPorPneu.has(mv.pneu_id)) movPorPneu.set(mv.pneu_id, []);
    movPorPneu.get(mv.pneu_id).push(mv);
  }

  const analisados = pneusExec.map((row) => {
    const meds = medPorPneu.get(row.id) || [];
    const movs = movPorPneu.get(row.id) || [];
    const equip = contextoEquipamento(row);
    const limV = limitesDoVeiculo(row);
    const ultima = [...meds].sort((a, b) => {
      const da = String(a.data_medicao || '');
      const db = String(b.data_medicao || '');
      if (da !== db) return da.localeCompare(db);
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    }).at(-1);
    const insp = danosDaMedicao(ultima?.inspecao_danos);
    const papel = row.posicao ? papelPosicao(row.posicao) : null;
    return montarAnalisePneu({
      id: row.id,
      filial_id: row.filial_id,
      filial: row.filial_nome,
      filial_codigo: row.filial_codigo,
      veiculo_id: row.veiculo_id,
      placa: row.placa || null,
      apelido: row.apelido || null,
      tipo: row.tipo || null,
      tipo_codigo: equip.catalogo?.codigo || row.tipo_codigo || null,
      posicao: row.posicao || null,
      numero_fogo: row.numero_fogo || null,
      medida: row.medida || null,
      marca: row.marca || null,
      modelo: row.modelo || null,
      condicao: row.condicao || null,
      vida_recap: row.vida_recap || 0,
      status_pneu: row.status_pneu,
      data_entrada: dataEntradaOperacao(row, movs),
    }, {
      medicoes: meds,
      separacao: separarPorCiclo({ movimentacoes: movs, medicoes: meds }),
      perfil: equip.perfil,
      unidade: equip.unidade,
      permiteRecap: equip.permiteRecap,
      papel,
      limites: limV,
      tolerancia: limV.diagnostico_tolerancia_mm,
      maxRecaps: limites.max_recaps,
      danos: insp.danos,
      inspecaoLegivel: insp.legivel,
    });
  });

  const comparacao = aplicarComparacao(analisados);
  const ciclo = cicloMensalDe(dataISOBrasil());
  for (const pneu of analisados) {
    pneu.leitura_sulco = leituraSulco(pneu, ciclo);
    pneu.reavaliar = pneu.leitura_sulco === 'vencida';
    pneu.dimensao_comercial = Boolean(normalizarMedida(pneu.medida));
  }
  const montados = analisados.filter((p) => p.status_pneu === 'montado');
  const faixas = resumirFaixas(analisados);
  const compras = montarPrevisaoFilial(analisados);

  const cadastradosPorFilial = new Map(veiculosAtivos.map((row) => [row.filial_id, Number(row.n) || 0]));
  const porFilial = filiaisExec.map((f) => {
    const lista = montados.filter((p) => p.filial_id === f.id);
    const faixasFilial = resumirFaixas(lista);
    const mesFilial = situacaoAtualizacaoMensal(lista, ciclo);
    return {
      filial_id: f.id,
      filial: f.nome,
      codigo: f.codigo,
      ativo: !!f.ativo,
      veiculos_cadastrados: cadastradosPorFilial.get(f.id) || 0,
      veiculos: new Set(lista.map((p) => p.veiculo_id).filter(Boolean)).size,
      pneus_montados: lista.length,
      faixas: faixasFilial,
      irregulares: lista.filter((p) => p.desgaste?.padrao === 'irregular').length,
      acima_da_media: lista.filter((p) => p.comparacao?.acima).length,
      criticos: (faixasFilial.critico || 0) + (faixasFilial.critico_equipamento || 0),
      programar_recapagem: faixasFilial.programar_recapagem || 0,
      candidatos_recap: lista.filter((p) => p.elegibilidade?.candidato_programacao).length,
      avaliacao_urgente: lista.filter((p) => p.elegibilidade?.encaminhamento === 'retirada_avaliacao_urgente').length,
      incompletos: lista.filter((pneu) => montadoIncompleto(pneu)).length,
      sem_dimensao_comercial: lista.filter((pneu) => !pneu.dimensao_comercial).length,
      evolucao_mensal: {
        com_historico: lista.filter((pneu) => pneu.evolucao_mensal?.disponivel).length,
        insuficientes: lista.filter((pneu) => pneu.evolucao_mensal && !pneu.evolucao_mensal.disponivel).length,
      },
      ...mesFilial,
    };
  });

  const veiculosMap = new Map();
  for (const pneu of montados) {
    if (!pneu.veiculo_id) continue;
    if (!veiculosMap.has(pneu.veiculo_id)) {
      veiculosMap.set(pneu.veiculo_id, {
        veiculo_id: pneu.veiculo_id,
        placa: pneu.placa,
        apelido: pneu.apelido,
        filial_id: pneu.filial_id,
        filial: pneu.filial,
        tipo: pneu.tipo,
        unidade: pneu.unidade,
        pneus: 0,
        menor_sulco: null,
        pior_faixa: null,
        irregulares: 0,
        acima_da_media: 0,
      });
    }
    const v = veiculosMap.get(pneu.veiculo_id);
    v.pneus += 1;
    if (pneu.menor_sulco != null) {
      v.menor_sulco = v.menor_sulco == null ? pneu.menor_sulco : Math.min(v.menor_sulco, pneu.menor_sulco);
    }
    v.pior_faixa = piorFaixa(v.pior_faixa, pneu.faixa);
    if (pneu.desgaste?.padrao === 'irregular') v.irregulares += 1;
    if (pneu.comparacao?.acima) v.acima_da_media += 1;
  }
  const porVeiculo = [...veiculosMap.values()]
    .map((v) => ({ ...v, pior_faixa_label: FAIXAS[v.pior_faixa] || v.pior_faixa }))
    .sort((a, b) => (RANK_FAIXA[a.pior_faixa] ?? 9) - (RANK_FAIXA[b.pior_faixa] ?? 9)
      || String(a.filial || '').localeCompare(String(b.filial || ''), 'pt-BR')
      || String(a.placa || '').localeCompare(String(b.placa || ''), 'pt-BR'));

  const semProjecao = montados.filter((p) => p.regua_recap && !p.consumo?.projecao?.disponivel).length;
  const cicloAberto = montados.filter((p) => !p.ciclo_confiavel).length;
  const semMedida = analisados.filter((p) => !normalizarMedida(p.medida)).length;
  const semMedidaPorFilial = new Map();
  for (const pneu of montados) {
    if (normalizarMedida(pneu.medida)) continue;
    semMedidaPorFilial.set(pneu.filial_id, (semMedidaPorFilial.get(pneu.filial_id) || 0) + 1);
  }
  const montadosSemMedida = [...semMedidaPorFilial.values()].reduce((s, n) => s + n, 0);
  const comprasAlerta = alertaCompraIncompleta(montadosSemMedida);

  const idsExec = new Set(filiaisExec.map((f) => f.id));
  const movimentoPorPneu = new Map();
  for (const movimento of movimentosDescarte) {
    if (movimentoPorPneu.has(movimento.pneu_id)) continue;
    movimentoPorPneu.set(movimento.pneu_id, movimento);
  }
  const descartesPorFilial = new Map();
  for (const row of descartesRows) {
    if (!idsExec.has(row.filial_id)) continue;
    if (!descartesPorFilial.has(row.filial_id)) {
      descartesPorFilial.set(row.filial_id, []);
    }
    const movimento = movimentoPorPneu.get(row.id);
    descartesPorFilial.get(row.filial_id).push({
      numero_fogo: row.numero_fogo || null,
      medida: row.medida || null,
      data: movimento?.data_evento || row.tratamento_descarte_em || null,
      motivo: movimento?.motivo || row.tratamento_descarte_obs || null,
    });
  }
  const descartes = [...descartesPorFilial.entries()].map(([filialId, itens]) => {
    const ordenados = [...itens].sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
    return {
      filial_id: filialId,
      quantidade: ordenados.length,
      itens: ordenados.slice(0, 12),
    };
  });
  const descartesTotal = descartes.reduce((soma, item) => soma + item.quantidade, 0);

  const comprasPorFilial = new Map();
  for (const linha of compras) {
    if (!comprasPorFilial.has(linha.filial_id)) {
      comprasPorFilial.set(linha.filial_id, {
        filial_id: linha.filial_id,
        estoque_novo: 0,
        estoque_recapado: 0,
        em_recapagem: 0,
        necessidade_pneu_novo: 0,
        candidatos_recap: 0,
        avaliacao_urgente: 0,
        comprar_novo: 0,
        previsao_novo_90d: 0,
        previsao_recap_90d: 0,
      });
    }
    const acc = comprasPorFilial.get(linha.filial_id);
    for (const k of Object.keys(acc)) {
      if (k === 'filial_id') continue;
      acc[k] += linha[k] || 0;
    }
  }
  for (const f of filiaisExec) {
    const item = comprasPorFilial.get(f.id);
    if (!item) continue;
    const faltam = semMedidaPorFilial.get(f.id) || 0;
    item.filial = f.nome;
    item.montados_sem_medida = faltam;
    item.recomendacao_definitiva = faltam === 0;
  }
  for (const linha of compras) {
    const faltam = semMedidaPorFilial.get(linha.filial_id) || 0;
    linha.montados_sem_medida = faltam;
    linha.recomendacao_definitiva = linha.medida_informada === true;
  }

  for (const unidade of porFilial) {
    const compra = comprasPorFilial.get(unidade.filial_id);
    const condicao = contagemCondicao(unidade.faixas);
    const conferido = compra
      ? compra.recomendacao_definitiva === true
      : unidade.sem_dimensao_comercial === 0;
    unidade.parecer = montarParecerExecutivo({
      ...condicao,
      montados: unidade.pneus_montados,
      necessidade: compra?.necessidade_pneu_novo || 0,
      estoqueNovo: compra?.estoque_novo || 0,
      comprarNovo: conferido ? (compra?.comprar_novo || 0) : 0,
      estoqueConferido: conferido,
      candidatos: unidade.candidatos_recap || 0,
      veiculosSemCobertura: Math.max(0, (unidade.veiculos_cadastrados || 0) - (unidade.veiculos || 0)),
      vencidas: unidade.leitura_sulco?.vencida || 0,
      semHistorico: unidade.leitura_sulco?.sem_historico || 0,
      parciais: (unidade.leitura_sulco?.parcial || 0) + (unidade.leitura_sulco?.invalida || 0),
    });
  }

  return {
    titulo: 'Saúde e desgaste dos pneus',
    perfil: 'presidente',
    gerado_em: new Date().toISOString(),
    somente_leitura: true,
    consultivo: true,
    ciclo,
    regras: {
      acima_de_8: 'Acompanhamento normal',
      acima_de_5_ate_8: 'Monitoramento preventivo',
      acima_de_3_ate_5: 'Programar recapagem',
      ate_3: 'Crítico — retirada e avaliação urgente de recapagem, sem aptidão automática',
      menor_sulco: 'Menor valor válido entre externo, central, interno e auxiliar',
    },
    consolidado: {
      filiais: filiaisExec.length,
      veiculos_cadastrados: filiaisExec.reduce((soma, filial) => soma + (cadastradosPorFilial.get(filial.id) || 0), 0),
      veiculos: porVeiculo.length,
      pneus_montados: montados.length,
      faixas,
      irregulares: montados.filter((p) => p.desgaste?.padrao === 'irregular').length,
      uniformes: montados.filter((p) => p.desgaste?.padrao === 'uniforme' || p.desgaste?.padrao === 'uniforme_parcial').length,
      acima_da_media: comparacao.acima_da_media,
      candidatos_recap: montados.filter((p) => p.elegibilidade?.candidato_programacao).length,
      avaliacao_urgente: montados.filter((p) => p.elegibilidade?.encaminhamento === 'retirada_avaliacao_urgente').length,
      sem_projecao_caminhao: semProjecao,
      ciclo_nao_separado: cicloAberto,
      montados_sem_medida: montadosSemMedida,
      compra_definitiva: comprasAlerta.definitivo,
    },
    unidades_excluidas: excluidas.map((f) => ({
      id: f.id,
      nome: f.nome,
      codigo: f.codigo,
      preserva_dados: true,
    })),
    compras_alerta: comprasAlerta,
    por_unidade: porFilial,
    por_veiculo: porVeiculo,
    compras_por_filial: [...comprasPorFilial.values()],
    compras_por_medida: compras,
    pneus: analisados,
    descartes,
    limitacoes: [
      ...LIMITACOES_FIXAS,
      `${descartesTotal} pneu(s) em descarte ficam fora da régua de sulco e aparecem só na lista de descartes.`,
      `${semProjecao} pneu(s) de caminhão sem projeção de 5 mm e 3 mm por histórico insuficiente ou pouco confiável.`,
      `${cicloAberto} pneu(s) montado(s) com ciclo de recapagem não separado. O consumo desses pneus não foi calculado.`,
      `${semMedida} pneu(s) sem dimensão comercial. A necessidade técnica desses pneus continua visível. A quantidade de compra não fecha sem a especificação e o estoque dessa dimensão.`,
      'A medição dos sulcos é mensal. Medição do mês anterior ainda dentro de um mês da última leitura não é atraso. Medição vencida não apaga a necessidade técnica e pede reavaliação.',
      'A evolução usa o menor sulco mês a mês quando há pelo menos dois meses no mesmo ciclo. Sem isso, não há prazo de substituição.',
      ...(comprasAlerta.texto ? [comprasAlerta.texto] : []),
      comparacao.grupos_insuficientes
        ? `${comparacao.grupos_insuficientes} grupo(s) comparável(is) com menos de 3 pneus. Nesses grupos não há alerta de consumo acima da média.`
        : 'Grupos comparáveis com amostra mínima não ficaram de fora por tamanho.',
    ],
  };
}
