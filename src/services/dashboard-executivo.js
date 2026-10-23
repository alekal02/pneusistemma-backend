/**
 * Visão executiva do presidente (admin total).
 * Somente leitura. Reusa o motor de alertas da operação e a janela de 7 dias
 * do relatório semanal. Não grava dado e não cria limiar novo.
 */
import { filialForaDoIndicadorExecutivo } from './saude-desgaste-relatorio.js';
import { avaliarPneuPainel, bucketKpi, contarAcaoLegada, veiculoCombinaTipo } from './indicadores-frota.js';
import { getLimites, limitesDoVeiculo } from '../limites.js';
import { LAYOUTS_PNEU, papelPosicao, labelPosicao } from '../pneus-layouts.js';
import {
  filtrarFiliaisPorSituacao,
  labelSituacaoExecutiva,
  limparCacheDiagnosticoExecutivo,
  montarDiagnosticoExecutivo,
  situacaoMedicaoExecutiva as situacaoMedicao,
} from './diagnostico-executivo.js';
import { especificacaoMedicao } from '../medicao-perfil.js';
import { resolverTipoEquipamento } from '../equipamento-tipos.js';
import {
  VALIDADE_SNAPSHOT_EXECUTIVO_MS,
  agoraCacheExecutivo,
  filaUnica,
  limparCacheFrotaExecutiva,
  obterFrotaExecutiva,
} from './frota-executiva-compartilhada.js';

/** Validade da medição: o mês corrente (America/Sao_Paulo). Fora do mês, ou sem data, não está atualizada. */
export const VALIDADE_MEDICAO = 'mes_corrente';
export const HISTORICO_INDISPONIVEL = 'Histórico indisponível';
export const DADOS_INSUFICIENTES = 'Dados insuficientes para decisão';

const SITUACOES = {
  ok: 'ok',
  monitorar: 'monitorar',
  critico: 'critico',
  sem_medicao: 'sem_dado',
};

const cache = new Map();
const voosSnapshot = new Map();
let geracaoSnapshot = 0;

export function limparCacheExecutivo() {
  geracaoSnapshot += 1;
  cache.clear();
  voosSnapshot.clear();
  limparCacheFrotaExecutiva();
  limparCacheDiagnosticoExecutivo();
}

export function isoHoje(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
}

export function addDiasIso(iso, dias) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

export function diasEntreIso(inicio, fim) {
  const a = Date.parse(`${String(inicio).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(fim).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Fora da validade mensal. Ausência de data não vira 0 mm: só indica medição não vigente. */
export function medicaoAtrasada(dataMedicao, hoje) {
  if (!dataMedicao) return false;
  const d = String(dataMedicao).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return d.slice(0, 7) !== String(hoje).slice(0, 7);
}

function numeroOuNulo(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function erroStatus(mensagem, status) {
  const err = new Error(mensagem);
  err.status = status;
  return err;
}

export function resolverPeriodo({ periodo, de, ate } = {}, hoje = isoHoje()) {
  const p = String(periodo || '30');
  let inicio;
  let fim;
  let modo;
  if (p === '7' || p === '30' || p === '90') {
    const n = Number(p);
    fim = hoje;
    inicio = addDiasIso(hoje, -(n - 1));
    modo = p;
  } else if (p === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de || '') || !/^\d{4}-\d{2}-\d{2}$/.test(ate || '')) {
      throw erroStatus('Informe o início e o fim do período.', 400);
    }
    if (de > ate) throw erroStatus('A data inicial não pode ser posterior à final.', 400);
    const amplitude = diasEntreIso(de, ate) + 1;
    if (amplitude > 366) throw erroStatus('O período personalizado aceita no máximo 366 dias.', 400);
    inicio = de;
    fim = ate;
    modo = 'custom';
  } else {
    throw erroStatus('Período inválido.', 400);
  }
  const dias = diasEntreIso(inicio, fim) + 1;
  const fimAnt = addDiasIso(inicio, -1);
  const inicioAnt = addDiasIso(fimAnt, -(dias - 1));
  let granularidade = 'dia';
  if (dias > 31 && dias <= 120) granularidade = 'semana';
  else if (dias > 120) granularidade = 'mes';
  return {
    modo,
    de: inicio,
    ate: fim,
    dias,
    granularidade,
    anterior: { de: inicioAnt, ate: fimAnt, dias },
  };
}

export function montarBuckets(de, ate, granularidade) {
  const buckets = [];
  if (granularidade === 'dia') {
    for (let d = de; d <= ate; d = addDiasIso(d, 1)) {
      buckets.push({
        chave: d,
        label: `${d.slice(8, 10)}/${d.slice(5, 7)}`,
        inicio: d,
        fim: d,
      });
    }
    return buckets;
  }
  if (granularidade === 'semana') {
    let cursor = de;
    while (cursor <= ate) {
      let fim = addDiasIso(cursor, 6);
      if (fim > ate) fim = ate;
      buckets.push({
        chave: cursor,
        label: `${cursor.slice(8, 10)}/${cursor.slice(5, 7)}`,
        inicio: cursor,
        fim,
      });
      cursor = addDiasIso(fim, 1);
    }
    return buckets;
  }
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  let cursor = de;
  while (cursor <= ate) {
    const [y, m] = cursor.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const fim = ultimo < ate ? ultimo : ate;
    buckets.push({
      chave: `${y}-${String(m).padStart(2, '0')}`,
      label: `${nomes[m - 1]}/${String(y).slice(2)}`,
      inicio: cursor,
      fim,
    });
    cursor = addDiasIso(fim, 1);
  }
  return buckets;
}

export function filialEntraNoEscopo(filial, { incluirMatriz = false, filialId = null } = {}) {
  if (filialId && Number(filial?.id) !== Number(filialId)) return false;
  const codigo = String(filial?.codigo || '').trim().toUpperCase();
  const fora = filialForaDoIndicadorExecutivo(filial);
  if (fora && codigo === 'MATRIZ') {
    return Boolean(incluirMatriz || (filialId && Number(filialId) === Number(filial.id)));
  }
  if (fora) return false;
  return true;
}

/**
 * Vermelho: pneu crítico no motor operacional (menor sulco válido ≤ limite homologado).
 * Cinza: veículos ativos sem pneu, ou sem base para decidir. Nunca verde por falta de registro.
 * Amarelo: monitoramento (limite de atenção) ou medição fora do mês, sem crítico.
 * Verde: há pneu montado, nenhum crítico, nenhum fora do mês e nenhum veículo sem pneu.
 */
export function situacaoOperacional({
  montados = 0,
  criticos = 0,
  atrasados = 0,
  monitorar = 0,
  veiculos = 0,
  veiculosSemPneu = 0,
} = {}) {
  if (criticos > 0) {
    return { codigo: 'critica', label: 'Substituição prioritária', cor: 'vermelho' };
  }
  if ((veiculos > 0 && montados === 0) || veiculosSemPneu > 0) {
    return { codigo: 'insuficiente', label: DADOS_INSUFICIENTES, cor: 'cinza' };
  }
  if (!montados) {
    return { codigo: 'insuficiente', label: DADOS_INSUFICIENTES, cor: 'cinza' };
  }
  if (atrasados > 0 || monitorar > 0) {
    return { codigo: 'atencao', label: 'Requer acompanhamento', cor: 'amarelo' };
  }
  return { codigo: 'ok', label: 'Boa condição', cor: 'verde' };
}

export function percentualAtualizados(atualizados, montados) {
  if (!montados) return null;
  return Math.round((atualizados / montados) * 1000) / 10;
}

export function deltaConjunto(atual, anterior, amostra) {
  if (!amostra) return null;
  return { atual, anterior, delta: atual - anterior, amostra };
}

export function classificarLinha(row) {
  try {
    const aval = avaliarPneuPainel(row, { limites: limitesDoVeiculo(row) });
    return {
      kpi: bucketKpi(aval),
      acao: contarAcaoLegada(aval?.acao?.codigo),
      menor_sulco: aval?.menor_sulco ?? null,
    };
  } catch {
    return { kpi: 'sem_dado', acao: null, menor_sulco: null };
  }
}

function rotuloTipo(veiculo) {
  const cat = resolverTipoEquipamento(veiculo?.tipo_codigo || veiculo?.tipo);
  return cat?.label || veiculo?.tipo || '—';
}

function codigoTipo(veiculo) {
  const cat = resolverTipoEquipamento(veiculo?.tipo_codigo || veiculo?.tipo);
  return cat?.codigo || String(veiculo?.tipo_codigo || veiculo?.tipo || '').trim();
}

function passaTipo(row, tipo) {
  if (!tipo) return true;
  return veiculoCombinaTipo(row?.tipo_codigo || row?.tipo, tipo);
}

function layoutPosicoes(layoutId) {
  if (!layoutId || !LAYOUTS_PNEU[layoutId]) return null;
  return LAYOUTS_PNEU[layoutId].posicoes || null;
}

export const CAMPOS_VEICULO_FROTA = [
  'id', 'placa', 'apelido', 'tipo', 'layout_id', 'layout_nome', 'posicoes',
  'pneus', 'medicao_label', 'sem_layout', 'sem_pneu',
];

export const CAMPOS_PNEU_FROTA = [
  'id', 'posicao', 'posicao_label', 'numero_fogo', 'kpi', 'condicao',
  'menor_sulco', 'sulco_externo', 'sulco_central', 'sulco_interno', 'sulco_auxiliar',
  'sulco_mm', 'pressao_psi', 'data_medicao', 'sem_medicao', 'situacao_medicao',
  'risco_imediato', 'perfil_sulco', 'atrasada',
];

function detalhePneuFrota(p) {
  const semMedicao = p.situacao_medicao
    ? p.situacao_medicao === 'sem_medicao'
    : !p.data_medicao;
  const atrasada = semMedicao
    ? false
    : (p.situacao_medicao ? p.situacao_medicao === 'atrasada' : Boolean(p.data_medicao && p.atrasada));
  return {
    id: p.id,
    posicao: p.posicao || '',
    posicao_label: p.posicao ? labelPosicao(p.posicao) : '',
    numero_fogo: p.numero_fogo || '',
    kpi: p.kpi,
    condicao: p.condicao || kpiLabel(p.kpi),
    menor_sulco: p.menor_sulco ?? null,
    sulco_externo: p.sulco_externo ?? null,
    sulco_central: p.sulco_central ?? null,
    sulco_interno: p.sulco_interno ?? null,
    sulco_auxiliar: p.sulco_auxiliar ?? null,
    sulco_mm: p.sulco_mm ?? null,
    pressao_psi: p.pressao_psi ?? null,
    data_medicao: p.data_medicao || null,
    sem_medicao: semMedicao,
    situacao_medicao: p.situacao_medicao || (semMedicao ? 'sem_medicao' : null),
    risco_imediato: Boolean(p.risco_imediato),
    perfil_sulco: p.perfil_sulco || null,
    atrasada,
  };
}

function rotuloMedicaoVeiculo(pneus) {
  if (!pneus.length) return 'Sem pneus montados';
  if (pneus.every((p) => p.sem_medicao)) return 'Sem medição';
  if (pneus.some((p) => p.atrasada)) return 'Medição vencida';
  return 'Medição em dia';
}

function kpiLabel(kpi) {
  if (kpi === 'ok') return 'Boa condição';
  if (kpi === 'monitorar') return 'Acompanhamento';
  if (kpi === 'critico') return 'Substituição prioritária';
  if (kpi === 'sem_dado') return 'Sem medição';
  return '—';
}

function ordenarSituacao(a, b) {
  const rank = { critica: 0, atencao: 1, ok: 2, insuficiente: 3 };
  const d = (rank[a.situacao?.codigo] ?? 9) - (rank[b.situacao?.codigo] ?? 9);
  if (d) return d;
  return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt');
}

export function agregarVisao({
  hoje,
  periodo,
  prazoRecapDias,
  filiais,
  veiculos,
  pneus,
  tipo = '',
  situacao = null,
  vagas = [],
  comparacao = null,
}) {
  const prazo = Number(prazoRecapDias);
  const prazoOk = Number.isFinite(prazo) && prazo > 0 ? prazo : null;
  const filtroEstrutural = Boolean(tipo);
  const filtroSituacao = Boolean(situacao);

  const veiculosTipo = (veiculos || []).filter((v) => passaTipo(v, tipo));
  const idsVeiculo = new Set(veiculosTipo.map((v) => Number(v.id)));

  const pneusEstruturais = (pneus || []).filter((p) => {
    if (!passaTipo(p, tipo)) return false;
    if (tipo && p.veiculo_id && !idsVeiculo.has(Number(p.veiculo_id)) && p.status_pneu === 'montado') {
      return false;
    }
    return true;
  });

  const agoraRef = new Date(`${String(hoje).slice(0, 10)}T15:00:00-03:00`);
  const diagnosticoCheio = montarDiagnosticoExecutivo({
    filiais,
    veiculos: veiculosTipo,
    pneus: pneusEstruturais.filter((p) => p.status_pneu === 'montado'),
    incluirMatriz: true,
    agora: agoraRef,
  });
  const diagnosticoVisivel = filtrarFiliaisPorSituacao(diagnosticoCheio, situacao);
  const diagPorId = new Map(diagnosticoCheio.filiais.map((f) => [Number(f.id), f]));
  const idsVisiveis = new Set(diagnosticoVisivel.filiais.map((f) => Number(f.id)));

  let filiaisBase = filiais || [];
  if (filtroSituacao) {
    filiaisBase = filiaisBase.filter((f) => idsVisiveis.has(Number(f.id)));
  } else if (filtroEstrutural) {
    const idsComDado = new Set(pneusEstruturais.map((p) => Number(p.filial_id)));
    for (const v of veiculosTipo) idsComDado.add(Number(v.filial_id));
    filiaisBase = filiaisBase.filter((f) => idsComDado.has(Number(f.id)));
  }
  const idsFilial = new Set(filiaisBase.map((f) => Number(f.id)));
  const veiculosRecorte = veiculosTipo.filter((v) => idsFilial.has(Number(v.filial_id)));
  const pneusRecorte = pneusEstruturais.filter((p) => idsFilial.has(Number(p.filial_id)));
  const montados = pneusRecorte.filter((p) => p.status_pneu === 'montado');

  const porFilialPneu = new Map();
  for (const p of pneusRecorte) {
    const id = Number(p.filial_id);
    if (!porFilialPneu.has(id)) porFilialPneu.set(id, []);
    porFilialPneu.get(id).push(p);
  }
  const porFilialVeiculo = new Map();
  for (const v of veiculosRecorte) {
    const id = Number(v.filial_id);
    if (!porFilialVeiculo.has(id)) porFilialVeiculo.set(id, []);
    porFilialVeiculo.get(id).push(v);
  }

  const posicoesPorVeiculo = new Map();
  for (const p of pneusEstruturais) {
    if (p.status_pneu !== 'montado' || !p.veiculo_id || !p.posicao) continue;
    const id = Number(p.veiculo_id);
    if (!posicoesPorVeiculo.has(id)) posicoesPorVeiculo.set(id, new Set());
    posicoesPorVeiculo.get(id).add(String(p.posicao));
  }

  const frota = [];
  const incompletos = [];
  for (const v of veiculosRecorte) {
    const id = Number(v.id);
    const doVeiculo = montados.filter((p) => Number(p.veiculo_id) === id);
    const criticos = doVeiculo.filter((p) => p.kpi === 'critico').length;
    const monitorar = doVeiculo.filter((p) => p.kpi === 'monitorar').length;
    const atrasados = doVeiculo.filter((p) => p.atrasada).length;
    const semPneu = doVeiculo.length === 0;
    const situacaoV = situacaoOperacional({
      montados: doVeiculo.length,
      criticos,
      atrasados,
      monitorar,
      veiculos: 1,
      veiculosSemPneu: semPneu ? 1 : 0,
    });
    const esperadas = layoutPosicoes(v.layout_pneus);
    const ocupadas = posicoesPorVeiculo.get(id) || new Set();
    const faltantes = esperadas ? esperadas.filter((pos) => !ocupadas.has(pos)) : [];
    const semLayout = !v.layout_pneus || !LAYOUTS_PNEU[v.layout_pneus];
    const incompleto = semPneu || semLayout || faltantes.length > 0;
    const doVeiculoDesenho = (pneusEstruturais || []).filter((p) => (
      p.status_pneu === 'montado' && Number(p.veiculo_id) === id
    ));
    const pneusDesenho = doVeiculoDesenho.map(detalhePneuFrota);
    const item = {
      id,
      placa: v.placa || '—',
      apelido: v.apelido || '',
      filial_id: Number(v.filial_id),
      filial: v.filial_nome || '',
      tipo: rotuloTipo(v),
      tipo_codigo: codigoTipo(v),
      montados: doVeiculo.length,
      criticos,
      monitorar,
      atrasados,
      incompleto,
      faltantes: faltantes.length,
      sem_pneu: semPneu,
      sem_layout: semLayout,
      situacao: situacaoV,
      layout_id: LAYOUTS_PNEU[v.layout_pneus]?.id || null,
      layout_nome: LAYOUTS_PNEU[v.layout_pneus]?.nome || null,
      posicoes: LAYOUTS_PNEU[v.layout_pneus]?.posicoes
        ? [...LAYOUTS_PNEU[v.layout_pneus].posicoes]
        : [],
      pneus: pneusDesenho,
      medicao_label: rotuloMedicaoVeiculo(pneusDesenho),
    };
    frota.push(item);
    if (semPneu) {
      incompletos.push({
        id: `veiculo-sem-${id}`,
        prioridade: 'alta',
        filial_id: item.filial_id,
        filial: item.filial,
        tipo: 'Veículo sem pneu',
        titulo: item.apelido ? `${item.placa} · ${item.apelido}` : item.placa,
        detalhe: DADOS_INSUFICIENTES,
        destino: { painel: 'frota', veiculo_id: id, filial_id: item.filial_id },
      });
    } else if (semLayout || faltantes.length > 0) {
      incompletos.push({
        id: `veiculo-${id}`,
        prioridade: 'media',
        filial_id: item.filial_id,
        filial: item.filial,
        tipo: semLayout ? 'Sem layout conhecido' : 'Posições do layout sem pneu',
        titulo: item.apelido ? `${item.placa} · ${item.apelido}` : item.placa,
        detalhe: semLayout
          ? 'O layout não está no catálogo do sistema.'
          : `${faltantes.length} posição(ões) do layout sem pneu montado.`,
        destino: { painel: 'frota', veiculo_id: id, filial_id: item.filial_id },
      });
    }
  }

  const veiculosComPneu = new Set(
    pneusEstruturais
      .filter((p) => p.status_pneu === 'montado' && p.veiculo_id)
      .map((p) => Number(p.veiculo_id)),
  );

  const filiaisVisao = filiaisBase.map((f) => {
    const id = Number(f.id);
    const lista = porFilialPneu.get(id) || [];
    const mont = lista.filter((p) => p.status_pneu === 'montado');
    const criticos = mont.filter((p) => p.kpi === 'critico').length;
    const monitorar = mont.filter((p) => p.kpi === 'monitorar').length;
    const semMedicao = mont.filter((p) => p.kpi === 'sem_dado').length;
    const atrasados = mont.filter((p) => p.atrasada).length;
    const atualizados = mont.length - atrasados;
    const veiculosFilial = veiculosTipo.filter((v) => Number(v.filial_id) === id);
    const veiculosSemPneu = veiculosFilial.filter((v) => !veiculosComPneu.has(Number(v.id))).length;
    const situacaoF = situacaoOperacional({
      montados: mont.length,
      criticos,
      atrasados,
      monitorar,
      veiculos: veiculosFilial.length,
      veiculosSemPneu,
    });
    const diag = diagPorId.get(id);
    return {
      id,
      nome: f.nome,
      codigo: f.codigo,
      teste: String(f.codigo || '').trim().toUpperCase() === 'MATRIZ',
      veiculos: (porFilialVeiculo.get(id) || []).length,
      montados: mont.length,
      criticos,
      monitorar,
      sem_medicao: semMedicao,
      atrasados,
      atualizados,
      veiculos_sem_pneu: veiculosSemPneu,
      percentual_atualizado: mont.length ? percentualAtualizados(atualizados, mont.length) : null,
      situacao: situacaoF,
      situacao_executiva: diag?.situacao || 'nao_avaliada',
      situacao_executiva_label: diag?.sem_frota
        ? 'Sem frota cadastrada'
        : (diag?.situacao_label || labelSituacaoExecutiva(diag?.situacao)),
      sem_frota: Boolean(diag?.sem_frota),
      pct_critico: diag?.pct_critico ?? null,
      pct_atencao: diag?.pct_atencao ?? null,
      pct_sem_alerta: diag?.pct_sem_alerta ?? null,
      pct_sem_dados: diag?.pct_sem_dados ?? null,
      pneus_ok: diag?.pneus_sem_alerta ?? 0,
      pneus_atencao: diag?.pneus_atencao ?? 0,
      pneus_criticos: diag?.pneus_criticos ?? 0,
      pneus_sem_dados: diag?.pneus_sem_dados ?? 0,
      veiculos_ativos: diag?.veiculos_ativos ?? veiculosFilial.length,
      riscos_imediatos: diag?.riscos_imediatos ?? 0,
    };
  }).sort(ordenarSituacao);

  const contagem = { ok: 0, monitorar: 0, critico: 0, sem_dado: 0 };
  let vencidas = 0;
  let foraDoMes = 0;
  let semData = 0;
  for (const p of montados) {
    if (contagem[p.kpi] != null) contagem[p.kpi] += 1;
    else contagem.sem_dado += 1;
    const semMedicao = p.situacao_medicao === 'sem_medicao' || !p.data_medicao;
    if (semMedicao) semData += 1;
    else if (p.fora_do_mes || medicaoAtrasada(p.data_medicao, hoje)) foraDoMes += 1;
    if (!semMedicao && (p.situacao_medicao === 'atrasada' || p.atrasada)) vencidas += 1;
  }
  const estoque = pneusRecorte.filter((p) => p.status_pneu === 'estoque').length;
  const recapagem = pneusRecorte.filter((p) => p.status_pneu === 'recapagem').length;
  const filiaisPendentes = filiaisVisao.filter((f) => f.situacao_executiva !== 'controlada').length;
  const filiaisCriticas = filiaisVisao.filter((f) => f.situacao_executiva === 'critica').length;

  const rotuloFilial = filtroSituacao || filtroEstrutural ? 'Filiais no recorte' : 'Filiais';
  const cards = [
    card('filiais', rotuloFilial, filiaisVisao.length, 'neutro', { painel: 'filiais' }),
    card('veiculos', 'Veículos', veiculosRecorte.length, 'neutro', { painel: 'frota' }),
    card('montados', 'Pneus montados', montados.length, 'neutro', { painel: 'pneus', foco: 'montados' }),
    card('criticos', 'Substituição prioritária', contagem.critico, contagem.critico > 0 ? 'critico' : 'ok', {
      painel: 'pneus',
      foco: 'critico',
      comparacao: comparacao?.criticos || null,
      sentido: 'menor_melhor',
    }),
    card('atrasadas', 'Medição vencida', vencidas, vencidas > 0 ? 'atencao' : 'ok', {
      painel: 'pneus',
      foco: 'atrasadas',
      comparacao: comparacao?.atrasadas || null,
      sentido: 'menor_melhor',
    }),
    card('pendentes', 'Filiais com pendência', filiaisPendentes, filiaisCriticas > 0 ? 'critico' : (filiaisPendentes > 0 ? 'atencao' : 'ok'), {
      painel: 'filiais',
      foco: 'pendentes',
    }),
  ];

  const grupos = montarAlertas({
    hoje,
    prazoOk,
    filiaisVisao,
    frota,
    montados,
    pneusRecorte,
    incompletos,
    vagas: filtroSituacao ? [] : (vagas || []),
    tipo,
  });

  const listasPneus = pneusRecorte.map((p) => ({
    id: p.id,
    fogo: p.numero_fogo || `ID ${p.id}`,
    filial_id: Number(p.filial_id),
    filial: p.filial_nome || '',
    veiculo_id: p.veiculo_id ? Number(p.veiculo_id) : null,
    placa: p.placa || '',
    apelido: p.apelido || '',
    posicao: p.posicao || '',
    status_pneu: p.status_pneu,
    kpi: p.kpi || null,
    acao: p.acao || null,
    kpi_label: p.status_pneu === 'montado' ? kpiLabel(p.kpi) : rotuloStatus(p.status_pneu),
    data_medicao: p.data_medicao || null,
    atrasada: Boolean(p.atrasada),
    menor_sulco: p.menor_sulco ?? null,
    tipo: rotuloTipo(p),
  }));

  return {
    gerado_em: new Date().toISOString(),
    filtros: {
      tipo: tipo || null,
      situacao: situacao || null,
      periodo,
      recorte_label: filtroSituacao || filtroEstrutural ? 'recorte' : 'producao',
    },
    regras: {
      condicao: 'Condição física: menor sulco válido entre os pontos medidos, no motor operacional (atenção 8 mm, crítico 3 mm).',
      atualizacao: 'Medição vigente só no mês corrente. Sem data não entra como 0 mm.',
      filial: 'A condição da unidade usa a distribuição dos pneus montados. Alta necessidade de intervenção exige ao menos 2 pneus e 20% na faixa oficial de substituição. Abaixo de 10% nessa faixa, a unidade pode permanecer em boa condição, com esses pneus listados à parte. Requer acompanhamento quando o acompanhamento chega a 20%, a substituição prioritária chega a 10%, ou a base sem medição chega a 20%. Dados insuficientes quando não há frota ou a maior parte dos veículos não tem medição utilizável. Intervenção imediata em posição direcional é destacada sem rebaixar a unidade inteira.',
      matriz: 'A unidade Matriz fica fora da produção, salvo inclusão explícita.',
      periodo: 'O período altera a evolução e a comparação. Os cards mostram a situação atual.',
      comparacao: 'A comparação usa só o conjunto que já tinha medição antes do período.',
      financeiro: 'Esta visão não inclui valores financeiros.',
    },
    resumo: { cards },
    filiais: filiaisVisao,
    saude: {
      condicao: [
        { id: 'ok', label: 'Boa condição', valor: contagem.ok, cor: 'ok' },
        { id: 'monitorar', label: 'Acompanhamento', valor: contagem.monitorar, cor: 'atencao' },
        { id: 'critico', label: 'Substituição prioritária', valor: contagem.critico, cor: 'critico' },
        { id: 'sem_dado', label: 'Sem medição', valor: contagem.sem_dado, cor: 'cinza' },
      ],
      atualizacao: [
        { id: 'atualizada', label: 'No mês', valor: Math.max(0, montados.length - foraDoMes - semData), cor: 'ok' },
        { id: 'atrasada', label: 'Fora do mês', valor: foraDoMes, cor: 'atencao' },
        { id: 'sem_medicao', label: 'Sem medição', valor: semData, cor: 'cinza' },
      ],
      localizacao: [
        { id: 'montado', label: 'Montado', valor: montados.length, cor: 'ok' },
        { id: 'estoque', label: 'Estoque', valor: estoque, cor: 'neutro' },
        { id: 'recapagem', label: 'Recapagem', valor: recapagem, cor: 'atencao' },
      ],
    },
    alertas: { grupos },
    listas: {
      frota,
      pneus: listasPneus,
    },
  };
}

function rotuloStatus(status) {
  if (status === 'estoque') return 'Estoque';
  if (status === 'recapagem') return 'Recapagem';
  if (status === 'montado') return 'Montado';
  return status || '—';
}

function card(id, rotulo, valor, cor, destino = {}) {
  return {
    id,
    rotulo,
    valor,
    cor,
    comparacao: destino.comparacao || null,
    sentido: destino.sentido || null,
    destino: { painel: destino.painel, foco: destino.foco || null },
  };
}

function montarAlertas({ hoje, prazoOk, filiaisVisao, montados, pneusRecorte, incompletos, vagas }) {
  const semAtualizacao = filiaisVisao
    .filter((f) => f.montados > 0 && f.atualizados === 0)
    .map((f) => ({
      id: `filial-sem-${f.id}`,
      prioridade: 'alta',
      filial_id: f.id,
      filial: f.nome,
      tipo: 'Filial sem atualização',
      titulo: f.nome,
      detalhe: `${f.montados} pneu(s) montado(s) fora do mês corrente.`,
      destino: { painel: 'filial', filial_id: f.id },
    }));

  const porVeiculoCritico = new Map();
  for (const p of montados) {
    if (p.kpi !== 'critico' || !p.veiculo_id) continue;
    const id = Number(p.veiculo_id);
    if (!porVeiculoCritico.has(id)) {
      porVeiculoCritico.set(id, {
        id: `crit-${id}`,
        prioridade: 'critica',
        filial_id: Number(p.filial_id),
        filial: p.filial_nome || '',
        tipo: 'Substituição prioritária',
        titulo: p.apelido ? `${p.placa || 'Veículo'} · ${p.apelido}` : (p.placa || `Veículo ${id}`),
        qtd: 0,
        destino: { painel: 'pneus', foco: 'critico', veiculo_id: id, filial_id: Number(p.filial_id) },
      });
    }
    porVeiculoCritico.get(id).qtd += 1;
  }
  const veiculosCriticos = [...porVeiculoCritico.values()].map((v) => ({
    ...v,
    detalhe: `${v.qtd} pneu(s) em substituição prioritária no motor operacional.`,
  }));

  const vencidas = montados.filter((p) => p.atrasada).map((p) => ({
    id: `med-${p.id}`,
    prioridade: 'alta',
    filial_id: Number(p.filial_id),
    filial: p.filial_nome || '',
    tipo: 'Medição vencida',
    titulo: p.numero_fogo ? `Fogo ${p.numero_fogo}` : `Pneu ${p.id}`,
    detalhe: p.data_medicao
      ? `${p.placa || 'Sem placa'} · ${p.posicao || 's/ posição'} · ${String(p.data_medicao).slice(0, 10)}`
      : `${p.placa || 'Sem placa'} · sem medição`,
    destino: { painel: 'pneus', foco: 'atrasadas', filial_id: Number(p.filial_id) },
  }));

  const recap = [];
  for (const p of pneusRecorte) {
    if (p.status_pneu === 'montado' && p.acao === 'recap') {
      recap.push({
        id: `recap-acao-${p.id}`,
        prioridade: 'media',
        filial_id: Number(p.filial_id),
        filial: p.filial_nome || '',
        tipo: 'Recapagem indicada',
        titulo: p.numero_fogo ? `Fogo ${p.numero_fogo}` : `Pneu ${p.id}`,
        detalhe: `${p.placa || 'Montado'} · ação do motor operacional`,
        destino: { painel: 'pneus', foco: 'recap_indicada', filial_id: Number(p.filial_id) },
      });
    }
    if (p.status_pneu === 'recapagem' && prazoOk && p.recap_enviado_em) {
      const dias = diasEntreIso(p.recap_enviado_em, hoje);
      if (dias != null && dias >= prazoOk) {
        recap.push({
          id: `recap-prazo-${p.id}`,
          prioridade: 'alta',
          filial_id: Number(p.filial_id),
          filial: p.filial_nome || '',
          tipo: 'Recapagem além do prazo',
          titulo: p.numero_fogo ? `Fogo ${p.numero_fogo}` : `Pneu ${p.id}`,
          detalhe: `${dias} dias desde o envio. Prazo configurado: ${prazoOk} dias.`,
          destino: { painel: 'pneus', foco: 'recapagem', filial_id: Number(p.filial_id) },
        });
      }
    }
  }

  const divergencias = [];
  for (const p of pneusRecorte) {
    if (p.status_pneu !== 'montado') continue;
    const semVeiculo = !p.veiculo_id || Number(p.veiculo_ativo) === 0;
    const filialDiverge = p.veiculo_id && p.veiculo_filial_id != null
      && Number(p.veiculo_filial_id) !== Number(p.filial_id);
    const semPosicao = !p.posicao;
    if (!semVeiculo && !filialDiverge && !semPosicao) continue;
    const tipoDiv = semVeiculo
      ? 'Montado sem veículo ativo'
      : (filialDiverge ? 'Filial do pneu diferente do veículo' : 'Montado sem posição');
    divergencias.push({
      id: `div-${p.id}`,
      prioridade: 'critica',
      filial_id: Number(p.filial_id),
      filial: p.filial_nome || '',
      tipo: tipoDiv,
      titulo: p.numero_fogo ? `Fogo ${p.numero_fogo}` : `Pneu ${p.id}`,
      detalhe: tipoDiv,
      destino: { painel: 'pneus', foco: 'divergencia', filial_id: Number(p.filial_id) },
    });
  }
  for (const vaga of vagas || []) {
    divergencias.push({
      id: `vaga-${vaga.id}`,
      prioridade: 'alta',
      filial_id: Number(vaga.filial_id),
      filial: vaga.filial_nome || '',
      tipo: 'Posição vaga',
      titulo: vaga.apelido ? `${vaga.placa} · ${vaga.apelido}` : (vaga.placa || 'Veículo'),
      detalhe: vaga.posicao ? `Posição ${vaga.posicao}` : 'Posição em aberto',
      destino: { painel: 'frota', veiculo_id: Number(vaga.veiculo_id), filial_id: Number(vaga.filial_id) },
    });
  }

  const ordem = { critica: 0, alta: 1, media: 2 };
  const grupos = [
    grupo('filiais_sem_atualizacao', 'Filiais sem atualização', 'alta', semAtualizacao),
    grupo('veiculos_criticos', 'Veículos com substituição prioritária', 'critica', veiculosCriticos),
    grupo('medicoes_vencidas', 'Medições vencidas', 'alta', vencidas),
    grupo('cadastros_incompletos', 'Cadastros incompletos', 'media', incompletos),
    grupo('pendencias_recapagem', 'Pendências de recapagem', 'media', recap),
    grupo('divergencias', 'Divergências', 'critica', divergencias),
  ];
  for (const g of grupos) {
    g.itens.sort((a, b) => (ordem[a.prioridade] ?? 9) - (ordem[b.prioridade] ?? 9));
  }
  return grupos;
}

function grupo(id, titulo, prioridade, itens) {
  return { id, titulo, prioridade, total: itens.length, itens };
}

function serieDisponivel(pontos) {
  return { disponivel: true, motivo: null, pontos };
}

function serieIndisponivel() {
  return { disponivel: false, motivo: HISTORICO_INDISPONIVEL, pontos: [] };
}

export function montarSerie({
  periodo,
  diasMedicao = [],
  movimentos = [],
  criticos = null,
  historicoMedicoes = false,
  historicoRecap = false,
  historicoDescarte = false,
}) {
  const buckets = montarBuckets(periodo.de, periodo.ate, periodo.granularidade);
  const base = buckets.map((b) => {
    const dias = (diasMedicao || []).filter((d) => d.dia >= b.inicio && d.dia <= b.fim);
    const filiais = new Set();
    let medicoes = 0;
    for (const d of dias) {
      medicoes += Number(d.medicoes) || 0;
      for (const id of d.filiais || []) filiais.add(id);
    }
    let recapagens = 0;
    let descartes = 0;
    for (const m of movimentos || []) {
      if (m.dia < b.inicio || m.dia > b.fim) continue;
      if (m.tipo === 'recap') recapagens += Number(m.qtd) || 0;
      if (m.tipo === 'descarte') descartes += Number(m.qtd) || 0;
    }
    const crit = (criticos || []).find((c) => c.chave === b.chave);
    return {
      chave: b.chave,
      label: b.label,
      inicio: b.inicio,
      fim: b.fim,
      medicoes,
      filiais_com_medicao: filiais.size,
      recapagens,
      descartes,
      criticos: crit && crit.amostra > 0 ? crit.criticos : null,
    };
  });
  const temMedicao = historicoMedicoes || base.some((p) => p.medicoes > 0);
  const temRecap = historicoRecap || base.some((p) => p.recapagens > 0);
  const temDescarte = historicoDescarte || base.some((p) => p.descartes > 0);
  const temCritico = Array.isArray(criticos) && criticos.some((c) => c.amostra > 0);
  const faixa = (campo) => base.map((p) => ({
    chave: p.chave,
    label: p.label,
    inicio: p.inicio,
    fim: p.fim,
    valor: p[campo],
  }));
  return {
    granularidade: periodo.granularidade,
    de: periodo.de,
    ate: periodo.ate,
    series: {
      medicoes: temMedicao ? serieDisponivel(faixa('medicoes')) : serieIndisponivel(),
      criticos: temCritico ? serieDisponivel(faixa('criticos')) : serieIndisponivel(),
      filiais: temMedicao ? serieDisponivel(faixa('filiais_com_medicao')) : serieIndisponivel(),
      recapagens: temRecap ? serieDisponivel(faixa('recapagens')) : serieIndisponivel(),
      descartes: temDescarte ? serieDisponivel(faixa('descartes')) : serieIndisponivel(),
      conformidade: serieIndisponivel(),
    },
  };
}

export function serieCriticos(ids, anterior, eventos, buckets) {
  const estado = new Map();
  for (const row of anterior || []) {
    if (row.kpi) estado.set(Number(row.pneu_id), row.kpi);
  }
  const ordenados = [...(eventos || [])].sort((a, b) => String(a.data).localeCompare(String(b.data)));
  let i = 0;
  const pontos = [];
  for (const b of buckets) {
    while (i < ordenados.length && String(ordenados[i].data).slice(0, 10) <= b.fim) {
      if (ordenados[i].kpi) estado.set(Number(ordenados[i].pneu_id), ordenados[i].kpi);
      i += 1;
    }
    let criticos = 0;
    let amostra = 0;
    for (const id of ids) {
      if (!estado.has(Number(id))) continue;
      amostra += 1;
      if (estado.get(Number(id)) === 'critico') criticos += 1;
    }
    pontos.push({ chave: b.chave, criticos, amostra });
  }
  return pontos;
}

export function recortar(snapshot, { recorte = 'pneus', foco = '', filialId = null, veiculoId = null, pagina = 1, limite = 50 } = {}) {
  let itens = [];
  if (recorte === 'frota') itens = snapshot.listas?.frota || [];
  else if (recorte === 'filiais') itens = snapshot.filiais || [];
  else if (recorte === 'alertas') {
    const g = (snapshot.alertas?.grupos || []).find((x) => x.id === foco);
    itens = g?.itens || [];
  } else {
    itens = snapshot.listas?.pneus || [];
    if (foco === 'critico') itens = itens.filter((p) => p.kpi === 'critico');
    else if (foco === 'monitorar') itens = itens.filter((p) => p.kpi === 'monitorar');
    else if (foco === 'ok') itens = itens.filter((p) => p.kpi === 'ok');
    else if (foco === 'sem_dado' || foco === 'sem_medicao') itens = itens.filter((p) => p.kpi === 'sem_dado');
    else if (foco === 'atrasadas') itens = itens.filter((p) => p.atrasada && p.status_pneu === 'montado');
    else if (foco === 'estoque') itens = itens.filter((p) => p.status_pneu === 'estoque');
    else if (foco === 'recapagem') itens = itens.filter((p) => p.status_pneu === 'recapagem');
    else if (foco === 'montados') itens = itens.filter((p) => p.status_pneu === 'montado');
    else if (foco === 'atualizada') itens = itens.filter((p) => p.status_pneu === 'montado' && !p.atrasada);
    else if (foco === 'recap_indicada') itens = itens.filter((p) => p.acao === 'recap');
  }
  if (recorte === 'filiais' && (foco === 'pendentes' || foco === 'nao_ok')) {
    itens = itens.filter((f) => f.situacao_executiva !== 'controlada');
  }
  if (filialId && recorte === 'filiais') {
    itens = itens.filter((f) => Number(f.id) === Number(filialId));
  } else if (filialId) {
    itens = itens.filter((i) => Number(i.filial_id) === Number(filialId));
  }
  if (veiculoId && recorte !== 'filiais') {
    itens = itens.filter((i) => Number(i.veiculo_id || i.id) === Number(veiculoId));
  }
  const total = itens.length;
  const pag = Math.max(1, Number(pagina) || 1);
  const lim = Math.min(100, Math.max(1, Number(limite) || 50));
  const start = (pag - 1) * lim;
  return { total, pagina: pag, limite: lim, itens: itens.slice(start, start + lim) };
}

function paraCliente(snapshot, evolucao) {
  const { listas, ...resto } = snapshot;
  return {
    ...resto,
    alertas: {
      grupos: (resto.alertas?.grupos || []).map((g) => ({
        ...g,
        itens: g.itens.slice(0, 4),
        tem_mais: g.itens.length > 4,
      })),
    },
    evolucao: evolucao === undefined ? { pendente: true } : evolucao,
    _sem_listas: listas ? true : false,
  };
}

export function lerFiltrosQuery(query = {}, hoje = isoHoje()) {
  let filialId = null;
  if (query.filial_id != null && query.filial_id !== '') {
    filialId = Number(query.filial_id);
    if (!Number.isInteger(filialId) || filialId <= 0) throw erroStatus('Filial inválida.', 400);
  }
  const situacaoRaw = String(query.situacao || '').trim();
  if (situacaoRaw && !SITUACOES[situacaoRaw]) throw erroStatus('Situação inválida.', 400);
  const tipo = String(query.tipo || '').trim().slice(0, 40);
  const incluirMatriz = query.incluir_matriz === '1' || query.incluir_matriz === 'true';
  const periodo = resolverPeriodo({
    periodo: query.periodo || '30',
    de: query.de,
    ate: query.ate,
  }, hoje);
  return {
    filialId,
    situacao: situacaoRaw ? SITUACOES[situacaoRaw] : null,
    situacaoQuery: situacaoRaw,
    tipo,
    incluirMatriz,
    periodo,
  };
}

function chaveCache(filtros) {
  // Só a leitura executiva monta este agregado. Gerente não passa por aqui.
  // Admin e presidente enxergam a mesma frota; o recorte é que separa as entradas.
  return JSON.stringify({
    audiencia: 'leitura-executiva',
    filialId: filtros.filialId,
    situacao: filtros.situacao,
    tipo: filtros.tipo,
    incluirMatriz: filtros.incluirMatriz,
    de: filtros.periodo.de,
    ate: filtros.periodo.ate,
    modo: filtros.periodo.modo,
  });
}

async function emLotes(ids, fn, tamanho = 1500) {
  const out = [];
  for (let i = 0; i < ids.length; i += tamanho) {
    const parte = ids.slice(i, i + tamanho);
    const rows = await fn(parte);
    out.push(...(rows || []));
  }
  return out;
}

function mapPneu(row, hoje) {
  const montado = row.status_pneu === 'montado';
  const classe = montado ? classificarLinha(row) : { kpi: null, acao: null, menor_sulco: null };
  const agora = new Date(`${String(hoje).slice(0, 10)}T15:00:00-03:00`);
  const medicao = montado
    ? situacaoMedicao({
      dataMedicao: row.data_medicao,
      diaVeiculo: row.dia_medicao,
      diaFilial: row.filial_dia_medicao,
      agora,
    })
    : null;
  return {
    id: Number(row.id),
    filial_id: Number(row.filial_id),
    filial_nome: row.filial_nome,
    veiculo_id: row.veiculo_id ? Number(row.veiculo_id) : null,
    veiculo_filial_id: row.veiculo_filial_id != null ? Number(row.veiculo_filial_id) : null,
    veiculo_ativo: row.veiculo_ativo != null ? Number(row.veiculo_ativo) : null,
    posicao: row.posicao || '',
    numero_fogo: row.numero_fogo || '',
    status_pneu: row.status_pneu,
    placa: row.placa || '',
    apelido: row.apelido || '',
    tipo: row.tipo_codigo || row.tipo || '',
    tipo_codigo: row.tipo_codigo || row.tipo || '',
    data_medicao: row.data_medicao || null,
    dia_medicao: row.dia_medicao ?? null,
    filial_dia_medicao: row.filial_dia_medicao ?? null,
    situacao_medicao: medicao?.situacao || null,
    sem_medicao: medicao?.situacao === 'sem_medicao',
    atrasada: medicao?.situacao === 'atrasada',
    fora_do_mes: montado ? medicaoAtrasada(row.data_medicao, hoje) : false,
    kpi: classe.kpi,
    condicao: montado ? kpiLabel(classe.kpi) : null,
    acao: classe.acao,
    menor_sulco: classe.menor_sulco,
    sulco_externo: numeroOuNulo(row.sulco_externo),
    sulco_central: numeroOuNulo(row.sulco_central),
    sulco_interno: numeroOuNulo(row.sulco_interno),
    sulco_auxiliar: numeroOuNulo(row.sulco_auxiliar),
    sulco_mm: numeroOuNulo(row.sulco_mm),
    pressao_psi: numeroOuNulo(row.pressao_psi),
    perfil_sulco: montado
      ? especificacaoMedicao(row.tipo_codigo || row.tipo, row.layout_pneus).sulco
      : null,
    risco_imediato: montado && classe.kpi === 'critico' && papelPosicao(row.posicao) === 'direcional',
    recap_enviado_em: row.recap_enviado_em ? String(row.recap_enviado_em).slice(0, 10) : null,
  };
}

async function montarSnapshot(db, filtros, hoje) {
  const bruta = await obterFrotaExecutiva(db, {
    escopo: null,
    filialId: filtros.filialId,
  });
  const filiaisTodas = bruta.filiais;

  const escopo = filiaisTodas.filter((f) => filialEntraNoEscopo(f, filtros));
  const ids = escopo.map((f) => Number(f.id));
  const opcoesFiliais = filiaisTodas
    .filter((f) => {
      const codigo = String(f.codigo || '').trim().toUpperCase();
      if (codigo === 'MATRIZ') return true;
      return !filialForaDoIndicadorExecutivo(f);
    })
    .map((f) => ({
      id: Number(f.id),
      nome: f.nome,
      codigo: f.codigo,
      teste: String(f.codigo || '').trim().toUpperCase() === 'MATRIZ',
    }));

  if (!ids.length) {
    const vazio = agregarVisao({
      hoje,
      periodo: filtros.periodo,
      prazoRecapDias: getLimites().prazo_recap_dias,
      filiais: [],
      veiculos: [],
      pneus: [],
      tipo: filtros.tipo,
      situacao: filtros.situacao,
      vagas: [],
      comparacao: null,
    });
    vazio.opcoes = { filiais: opcoesFiliais, tipos: [] };
    vazio.matriz_incluida = Boolean(filtros.incluirMatriz || filtros.filialId);
    return { snapshot: vazio, ids: [], pneuIds: [] };
  }

  const idSet = new Set(ids);
  const veiculosRows = bruta.veiculos.filter((v) => idSet.has(Number(v.filial_id)));
  const pneusRows = bruta.pneus.filter((p) => idSet.has(Number(p.filial_id)));
  const vagas = await lerVagas(db, ids);

  const pneus = (pneusRows || []).map((row) => mapPneu(row, hoje));
  const veiculos = (veiculosRows || []).map((v) => ({
    ...v,
    id: Number(v.id),
    filial_id: Number(v.filial_id),
  }));

  const comparacao = await compararConjunto(db, filtros, hoje, pneus.filter((p) => p.status_pneu === 'montado' && passaTipo(p, filtros.tipo)));

  const snapshot = agregarVisao({
    hoje,
    periodo: filtros.periodo,
    prazoRecapDias: getLimites().prazo_recap_dias,
    filiais: escopo.map((f) => ({ ...f, id: Number(f.id) })),
    veiculos,
    pneus,
    tipo: filtros.tipo,
    situacao: filtros.situacao,
    vagas: (vagas?.itens || []).filter((v) => !filtros.tipo || passaTipo(v, filtros.tipo)),
    comparacao,
  });

  const tiposMap = new Map();
  for (const v of veiculos) {
    const codigo = codigoTipo(v);
    if (!codigo || tiposMap.has(codigo)) continue;
    tiposMap.set(codigo, rotuloTipo(v));
  }
  snapshot.opcoes = {
    filiais: opcoesFiliais,
    tipos: [...tiposMap.entries()]
      .map(([codigo, label]) => ({ codigo, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt')),
  };
  snapshot.matriz_incluida = escopo.some((f) => String(f.codigo || '').trim().toUpperCase() === 'MATRIZ');
  snapshot.vagas_indisponiveis = Boolean(vagas?.erro);
  const pneuIds = (snapshot.listas?.pneus || [])
    .filter((p) => p.status_pneu === 'montado')
    .map((p) => p.id);
  return { snapshot, ids, pneuIds };
}

async function lerVagas(db, ids) {
  try {
    const itens = await db.prepare(`
      SELECT a.id, a.filial_id, a.veiculo_id, a.posicao, a.motivo, a.numero_fogo,
             v.placa, v.apelido, v.tipo, v.tipo_codigo, f.nome AS filial_nome
      FROM alertas_posicao_vaga a
      JOIN veiculos v ON v.id = a.veiculo_id AND v.ativo = 1
      JOIN filiais f ON f.id = a.filial_id
      WHERE a.aberto = 1 AND a.filial_id = ANY(?::bigint[])
    `).all([ids]);
    return { itens: itens || [] };
  } catch (err) {
    console.error('[presidente] posições vagas indisponíveis:', err.message);
    return { erro: true, itens: [] };
  }
}

async function compararConjunto(db, filtros, hoje, montados) {
  const ids = montados.map((p) => p.id);
  if (!ids.length) return { criticos: null, atrasadas: null };
  const rows = await emLotes(ids, (parte) => db.prepare(`
    SELECT DISTINCT ON (m.pneu_id)
      m.pneu_id, m.data_medicao,
      m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.sulco_mm,
      m.inspecao_danos,
      p.vida_recap, p.posicao,
      v.tipo, v.tipo_codigo, v.layout_pneus, v.km_atual, v.hr_atual
    FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE m.pneu_id = ANY(?::bigint[])
      AND m.data_medicao < ?
    ORDER BY m.pneu_id, m.data_medicao DESC, m.id DESC
  `).all(parte, filtros.periodo.de));

  if (!rows.length) return { criticos: null, atrasadas: null };
  const porId = new Map(montados.map((p) => [p.id, p]));
  let critAntes = 0;
  let critAgora = 0;
  let atrAntes = 0;
  let atrAgora = 0;
  let amostra = 0;
  for (const row of rows) {
    const atual = porId.get(Number(row.pneu_id));
    if (!atual || atual.kpi !== (filtros.situacao || atual.kpi)) continue;
    if (filtros.situacao && atual.kpi !== filtros.situacao) continue;
    const classe = classificarLinha(row);
    amostra += 1;
    if (classe.kpi === 'critico') critAntes += 1;
    if (atual.kpi === 'critico') critAgora += 1;
    if (medicaoAtrasada(row.data_medicao, filtros.periodo.de)) atrAntes += 1;
    if (atual.atrasada) atrAgora += 1;
  }
  return {
    criticos: deltaConjunto(critAgora, critAntes, amostra),
    atrasadas: deltaConjunto(atrAgora, atrAntes, amostra),
  };
}

async function montarEvolucao(db, filtros, snapshot) {
  const todos = (snapshot.listas?.pneus || []).map((p) => Number(p.id));
  const montados = (snapshot.listas?.pneus || [])
    .filter((p) => p.status_pneu === 'montado')
    .map((p) => Number(p.id));
  const periodo = filtros.periodo;
  if (!todos.length) {
    return {
      ...montarSerie({ periodo }),
      comparacao: null,
      historico: false,
    };
  }

  const inicioBusca = periodo.anterior.de < periodo.de ? periodo.anterior.de : periodo.de;
  const semLinhas = Promise.resolve([]);
  const [diasRows, movRows, existeAntes, anteriorRows, eventosRows] = await Promise.all([
    montados.length ? emLotes(montados, (parte) => db.prepare(`
      SELECT LEFT(m.data_medicao, 10) AS dia,
             COUNT(*)::int AS medicoes,
             array_agg(DISTINCT m.pneu_id) AS pneus,
             array_agg(DISTINCT p.filial_id) AS filiais
      FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      WHERE m.pneu_id = ANY(?::bigint[])
        AND m.data_medicao >= ?
        AND m.data_medicao <= ?
      GROUP BY 1
    `).all(parte, periodo.de, periodo.ate)) : semLinhas,
    emLotes(todos, (parte) => db.prepare(`
      SELECT LEFT(mv.data_evento, 10) AS dia, mv.tipo, COUNT(*)::int AS qtd
      FROM movimentacoes mv
      WHERE mv.pneu_id = ANY(?::bigint[])
        AND mv.tipo IN ('recap', 'descarte')
        AND mv.data_evento >= ?
        AND mv.data_evento <= ?
      GROUP BY 1, 2
    `).all(parte, inicioBusca, periodo.ate)),
    montados.length ? emLotes(montados, (parte) => db.prepare(`
      SELECT 1 AS ok
      FROM medicoes m
      WHERE m.pneu_id = ANY(?::bigint[])
        AND m.data_medicao < ?
      LIMIT 1
    `).all(parte, periodo.de)) : semLinhas,
    montados.length ? emLotes(montados, (parte) => db.prepare(`
      SELECT DISTINCT ON (m.pneu_id)
        m.pneu_id, m.data_medicao,
        m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.sulco_mm,
        m.inspecao_danos,
        p.vida_recap, p.posicao,
        v.tipo, v.tipo_codigo, v.layout_pneus, v.km_atual, v.hr_atual
      FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      LEFT JOIN veiculos v ON v.id = p.veiculo_id
      WHERE m.pneu_id = ANY(?::bigint[])
        AND m.data_medicao < ?
      ORDER BY m.pneu_id, m.data_medicao DESC, m.id DESC
    `).all(parte, periodo.de)) : semLinhas,
    montados.length ? emLotes(montados, async (parte) => {
      const contagem = await db.prepare(`
        SELECT COUNT(*)::int AS c
        FROM medicoes m
        WHERE m.pneu_id = ANY(?::bigint[])
          AND m.data_medicao >= ?
          AND m.data_medicao <= ?
      `).get(parte, periodo.de, periodo.ate);
      if (Number(contagem?.c || 0) > 40000) return [{ _volume: true }];
      return db.prepare(`
        SELECT m.id, m.pneu_id, m.data_medicao,
               m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.sulco_mm,
               m.inspecao_danos,
               p.vida_recap, p.posicao,
               v.tipo, v.tipo_codigo, v.layout_pneus, v.km_atual, v.hr_atual
        FROM medicoes m
        JOIN pneus p ON p.id = m.pneu_id
        LEFT JOIN veiculos v ON v.id = p.veiculo_id
        WHERE m.pneu_id = ANY(?::bigint[])
          AND m.data_medicao >= ?
          AND m.data_medicao <= ?
        ORDER BY m.data_medicao ASC, m.id ASC
      `).all(parte, periodo.de, periodo.ate);
    }) : semLinhas,
  ]);

  const diasMedicao = mesclarDias(diasRows);
  const movimentosPeriodo = (movRows || []).filter((m) => m.dia >= periodo.de && m.dia <= periodo.ate);
  const movimentosAntes = (movRows || []).filter((m) => m.dia >= periodo.anterior.de && m.dia <= periodo.anterior.ate);
  const volumeAlto = (eventosRows || []).some((r) => r._volume);
  let criticos = null;
  let avisoCriticos = null;
  if (volumeAlto) {
    avisoCriticos = 'O volume de medições do período não permite reconstruir a curva de críticos.';
  } else if ((anteriorRows || []).length || (eventosRows || []).length) {
    const buckets = montarBuckets(periodo.de, periodo.ate, periodo.granularidade);
    const anterior = (anteriorRows || []).map((row) => ({
      pneu_id: Number(row.pneu_id),
      kpi: classificarLinha(row).kpi,
    }));
    const eventos = (eventosRows || []).filter((r) => !r._volume).map((row) => ({
      pneu_id: Number(row.pneu_id),
      data: String(row.data_medicao).slice(0, 10),
      kpi: classificarLinha(row).kpi,
    }));
    criticos = serieCriticos(montados, anterior, eventos, buckets);
  } else {
    avisoCriticos = 'Não há histórico de medição para a curva de críticos.';
  }

  const historico = (existeAntes || []).length > 0;
  const soma = (lista, tipo) => lista.filter((m) => !tipo || m.tipo === tipo).reduce((s, m) => s + (Number(m.qtd) || 0), 0);
  const serie = montarSerie({
    periodo,
    diasMedicao,
    movimentos: movimentosPeriodo,
    criticos,
    historicoMedicoes: historico,
    historicoRecap: (movRows || []).some((m) => m.tipo === 'recap' && Number(m.qtd) > 0),
    historicoDescarte: (movRows || []).some((m) => m.tipo === 'descarte' && Number(m.qtd) > 0),
  });
  if (!serie.series.criticos.disponivel && avisoCriticos) {
    serie.series.criticos.motivo = HISTORICO_INDISPONIVEL;
  }
  const medicoesAtual = diasMedicao.reduce((s, d) => s + (Number(d.medicoes) || 0), 0);
  const medicoesAnterior = historico
    ? await contarMedicoes(db, montados, periodo.anterior.de, periodo.anterior.ate)
    : null;
  const recapAntes = soma(movimentosAntes, 'recap');
  const descarteAntes = soma(movimentosAntes, 'descarte');
  serie.comparacao = {
    medicoes: serie.series.medicoes.disponivel && historico
      ? deltaConjunto(medicoesAtual, medicoesAnterior || 0, 1)
      : null,
    recapagens: serie.series.recapagens.disponivel && recapAntes > 0
      ? deltaConjunto(soma(movimentosPeriodo, 'recap'), recapAntes, 1)
      : null,
    descartes: serie.series.descartes.disponivel && descarteAntes > 0
      ? deltaConjunto(soma(movimentosPeriodo, 'descarte'), descarteAntes, 1)
      : null,
  };
  serie.historico = historico;
  return serie;
}

function mesclarDias(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row?.dia || row._volume) continue;
    const dia = String(row.dia).slice(0, 10);
    if (!map.has(dia)) map.set(dia, { dia, medicoes: 0, pneus: new Set(), filiais: new Set() });
    const acc = map.get(dia);
    acc.medicoes += Number(row.medicoes) || 0;
    for (const id of row.pneus || []) acc.pneus.add(Number(id));
    for (const id of row.filiais || []) acc.filiais.add(Number(id));
  }
  return [...map.values()].map((d) => ({
    dia: d.dia,
    medicoes: d.medicoes,
    pneus: [...d.pneus],
    filiais: [...d.filiais],
  }));
}

async function contarMedicoes(db, ids, de, ate) {
  let total = 0;
  const partes = await emLotes(ids, (parte) => db.prepare(`
    SELECT COUNT(*)::int AS c
    FROM medicoes m
    WHERE m.pneu_id = ANY(?::bigint[])
      AND m.data_medicao >= ?
      AND m.data_medicao <= ?
  `).all(parte, de, ate));
  for (const row of partes) total += Number(row.c) || 0;
  return total;
}

function guardarSnapshot(chave, entry, marca) {
  if (marca !== geracaoSnapshot) return;
  cache.set(chave, entry);
  if (cache.size <= 12) return;
  const antigo = [...cache.entries()].sort((a, b) => a[1].em - b[1].em)[0];
  if (antigo) cache.delete(antigo[0]);
}

async function obterEntrada(db, filtros, hoje) {
  const chave = chaveCache(filtros);
  const hit = cache.get(chave);
  if (hit && agoraCacheExecutivo() - hit.em < VALIDADE_SNAPSHOT_EXECUTIVO_MS) return hit;
  const marca = geracaoSnapshot;
  return filaUnica(voosSnapshot, chave, async () => {
    const montado = await montarSnapshot(db, filtros, hoje);
    const entry = {
      em: agoraCacheExecutivo(),
      snapshot: montado.snapshot,
      evolucao: undefined,
      evolucaoErro: null,
    };
    guardarSnapshot(chave, entry, marca);
    return entry;
  });
}

export async function obterResumoExecutivo(db, filtros, hoje = isoHoje()) {
  const entry = await obterEntrada(db, filtros, hoje);
  const corpo = paraCliente(entry.snapshot, entry.evolucao);
  delete corpo._sem_listas;
  return corpo;
}

export async function obterEvolucaoExecutiva(db, filtros, hoje = isoHoje()) {
  const entry = await obterEntrada(db, filtros, hoje);
  if (entry.evolucao === undefined) {
    try {
      entry.evolucao = await montarEvolucao(db, filtros, entry.snapshot);
    } catch (err) {
      console.error('[presidente] evolução', err);
      entry.evolucao = { erro: 'Não foi possível montar a evolução operacional.', pontos: [] };
    }
  }
  return { evolucao: entry.evolucao, periodo: filtros.periodo };
}

export async function obterDetalheExecutivo(db, filtros, extra, hoje = isoHoje()) {
  const entry = await obterEntrada(db, filtros, hoje);
  return recortar(entry.snapshot, extra);
}

export async function obterSnapshotCompleto(db, filtros, hoje = isoHoje()) {
  const entry = await obterEntrada(db, filtros, hoje);
  if (entry.evolucao === undefined) {
    try {
      entry.evolucao = await montarEvolucao(db, filtros, entry.snapshot);
    } catch (err) {
      console.error('[presidente] evolução pdf', err);
      entry.evolucao = { erro: 'Evolução indisponível.', pontos: [] };
    }
  }
  return { snapshot: entry.snapshot, evolucao: entry.evolucao };
}
