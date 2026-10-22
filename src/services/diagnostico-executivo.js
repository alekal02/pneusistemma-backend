/**
 * Diagnóstico executivo das filiais. Somente leitura.
 * A classe de cada pneu vem de avaliarPneuPainel / bucketKpi.
 * Os cortes de 2 veículos, 20% e 50% são provisórios.
 */
import { bucketKpi, avaliarPneuPainel, veiculoCombinaTipo } from './indicadores-frota.js';
import { especificacaoMedicao } from '../medicao-perfil.js';
import { posicoesDoLayout, situacaoMedicao } from './diagnostico-frota.js';
import { labelPosicao } from '../pneus-layouts.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { limitesDoVeiculo } from '../limites.js';

export const CORTES_EXECUTIVOS = {
  min_veiculos_criticos: 2,
  pct_criticos: 20,
  pct_sem_dados_nao_avaliada: 50,
  pct_sem_dados_atencao: 20,
  pct_vencida_atencao: 50,
};

const PONTOS_QUATRO = ['sulco_externo', 'sulco_central', 'sulco_interno', 'sulco_auxiliar'];

const ORDEM_CLASSE = { critico: 0, monitoramento: 1, sem_dados: 2, sem_risco: 3 };

export function ehMatriz(codigo) {
  return String(codigo || '').trim().toUpperCase() === 'MATRIZ';
}

export function labelSituacaoExecutiva(situacao) {
  if (situacao === 'controlada') return 'Controlada';
  if (situacao === 'atencao') return 'Atenção';
  if (situacao === 'critica') return 'Crítica';
  if (situacao === 'nao_avaliada') return 'Não avaliada';
  return situacao || '—';
}

export function labelClasseVeiculo(classe) {
  if (classe === 'critico') return 'Com pneus críticos';
  if (classe === 'monitoramento') return 'Com pneus em monitoramento';
  if (classe === 'sem_dados') return 'Sem dados suficientes';
  if (classe === 'sem_risco') return 'Sem risco crítico identificado';
  return classe || '—';
}

function percentual(parte, total) {
  if (!total) return null;
  return Math.round((1000 * parte) / total) / 10;
}

function sulcoInformado(valor) {
  if (valor == null || valor === '') return false;
  const n = Number(valor);
  return Number.isFinite(n);
}

export function medicaoPerfilCompleta(pneu, tipo, layout) {
  const spec = especificacaoMedicao(tipo, layout);
  if (spec.sulco === 'quatro_pontos') {
    return PONTOS_QUATRO.every((campo) => sulcoInformado(pneu?.[campo]));
  }
  return sulcoInformado(pneu?.sulco_mm);
}

function dataIso(valor) {
  if (!valor) return null;
  const s = String(valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cadastroIncompleto(flag) {
  return Number(flag ?? 1) !== 1;
}

function kpiClassificavel(kpi) {
  return kpi === 'critico' || kpi === 'monitorar' || kpi === 'ok';
}

/**
 * @returns classe exclusiva do veículo e os pneus que justificam o detalhe.
 */
export function classificarVeiculoExecutivo(veiculo, pneusMontados, { diaFilial = null, agora = new Date() } = {}) {
  const layout = posicoesDoLayout(veiculo.layout_pneus);
  const obrigatorias = layout.disponivel
    ? layout.posicoes.filter((codigo) => codigo !== 'ESTEPE')
    : [];
  const montados = Array.isArray(pneusMontados) ? pneusMontados : [];
  const porPosicao = new Set(montados.map((p) => p.posicao).filter(Boolean));
  const vazias = layout.disponivel
    ? obrigatorias.filter((codigo) => !porPosicao.has(codigo))
    : [];

  let temCritico = false;
  let temMonitor = false;
  let semClassificacao = !layout.disponivel || montados.length === 0 || vazias.length > 0;
  let integral = layout.disponivel && obrigatorias.length > 0 && vazias.length === 0;
  let medicaoVencida = false;
  let sulcoIncompleto = false;
  const pneus = [];

  for (const pneu of montados) {
    const aval = avaliarPneuPainel(
      { ...pneu, tipo: veiculo.tipo, layout_pneus: veiculo.layout_pneus },
      { limites: limitesDoVeiculo({ tipo: veiculo.tipo, layout_pneus: veiculo.layout_pneus }) },
    );
    const kpi = bucketKpi(aval);
    const completa = medicaoPerfilCompleta(pneu, veiculo.tipo, veiculo.layout_pneus);
    const situacao = situacaoMedicao({
      dataMedicao: pneu.data_medicao,
      diaVeiculo: veiculo.dia_medicao,
      diaFilial,
      agora,
    });
    const obrigatorio = obrigatorias.includes(pneu.posicao);
    const classificavel = kpiClassificavel(kpi);
    if (kpi === 'critico') temCritico = true;
    if (kpi === 'monitorar') temMonitor = true;
    if (obrigatorio && !classificavel) {
      semClassificacao = true;
      integral = false;
    }
    if (obrigatorio && classificavel && !completa) sulcoIncompleto = true;
    if (obrigatorio && situacao.situacao === 'atrasada') medicaoVencida = true;

    const alertas = [];
    if (classificavel && !completa) alertas.push('Sulco incompleto');
    if (situacao.situacao === 'atrasada') alertas.push('Medição vencida');
    if (!pneu.posicao) alertas.push('Pneu sem posição');
    if (pneu.filial_id != null && Number(pneu.filial_id) !== Number(veiculo.filial_id)) {
      alertas.push('Pneu vinculado a outra filial');
    }
    const relevante = kpi === 'critico'
      || kpi === 'monitorar'
      || !classificavel
      || alertas.length > 0;
    if (relevante) {
      pneus.push({
        pneu_id: pneu.id ?? pneu.pneu_id ?? null,
        posicao: pneu.posicao || null,
        posicao_label: pneu.posicao ? labelPosicao(pneu.posicao) : null,
        numero_fogo: pneu.numero_fogo || null,
        menor_sulco: aval.menor_sulco ?? null,
        data_medicao: dataIso(pneu.data_medicao),
        kpi,
        sulco_incompleto: classificavel && !completa,
        medicao_vencida: situacao.situacao === 'atrasada',
        situacao_medicao: situacao.situacao,
        alertas,
      });
    }
  }

  if (montados.some((p) => !p.posicao) && !temCritico && !temMonitor) {
    semClassificacao = true;
    integral = false;
  }
  if (cadastroIncompleto(veiculo.cadastro_completo) && !temCritico && !temMonitor) {
    semClassificacao = true;
    integral = false;
  }

  let classe;
  if (temCritico) classe = 'critico';
  else if (temMonitor) classe = 'monitoramento';
  else if (semClassificacao) classe = 'sem_dados';
  else classe = 'sem_risco';
  if (classe === 'sem_dados') integral = false;

  return {
    id: veiculo.id,
    placa: veiculo.placa,
    apelido: veiculo.apelido || null,
    tipo: veiculo.tipo || null,
    classe,
    classe_label: labelClasseVeiculo(classe),
    avaliado_integral: integral,
    medicao_vencida: medicaoVencida,
    sulco_incompleto: sulcoIncompleto,
    posicoes_vazias: vazias.map((codigo) => ({ codigo, label: labelPosicao(codigo) })),
    pneus,
  };
}

export function classificarFilialExecutiva(veiculos) {
  const lista = Array.isArray(veiculos) ? veiculos : [];
  const N = lista.length;
  const C = lista.filter((v) => v.classe === 'critico').length;
  const M = lista.filter((v) => v.classe === 'monitoramento').length;
  const D = lista.filter((v) => v.classe === 'sem_dados').length;
  const R = lista.filter((v) => v.classe === 'sem_risco').length;
  const diagnosticados = C + M + R;
  const integrais = lista.filter((v) => v.avaliado_integral).length;
  const vencidos = lista.filter((v) => v.medicao_vencida).length;
  const vencidosDiagnosticados = lista.filter((v) => v.classe !== 'sem_dados' && v.medicao_vencida).length;
  const base = percentual(C, diagnosticados);
  const semDadosPct = percentual(D, N);
  const vencidaPct = percentual(vencidosDiagnosticados, diagnosticados);
  const avaliadaPct = percentual(integrais, N);

  let situacao;
  let motivo;
  if (N === 0 || diagnosticados === 0) {
    situacao = 'nao_avaliada';
    motivo = N === 0
      ? 'Sem veículo ativo.'
      : 'Nenhum veículo ativo tem condição física comprovada pelo motor oficial.';
  } else if (C === 0 && M === 0 && semDadosPct >= CORTES_EXECUTIVOS.pct_sem_dados_nao_avaliada) {
    situacao = 'nao_avaliada';
    motivo = 'Metade ou mais da frota sem dados suficientes e nenhum risco comprovado.';
  } else if (C >= CORTES_EXECUTIVOS.min_veiculos_criticos && base >= CORTES_EXECUTIVOS.pct_criticos) {
    situacao = 'critica';
    motivo = `${C} veículos com pneu crítico, ${base}% dos veículos com condição comprovada.`;
  } else if (
    C >= 1
    || M >= 1
    || semDadosPct >= CORTES_EXECUTIVOS.pct_sem_dados_atencao
    || vencidaPct >= CORTES_EXECUTIVOS.pct_vencida_atencao
  ) {
    situacao = 'atencao';
    if (C === 1) {
      motivo = 'Um veículo com pneu crítico. O risco individual permanece visível.';
    } else if (C > 1) {
      motivo = `${C} veículos críticos, ${base}% dos veículos com condição comprovada, abaixo de 20%.`;
    } else if (M >= 1) {
      motivo = `${M} veículo(s) em monitoramento, sem pneu crítico comprovado.`;
    } else if (vencidaPct >= CORTES_EXECUTIVOS.pct_vencida_atencao) {
      motivo = 'Sem risco físico comprovado, mas metade ou mais dos veículos com condição comprovada está com medição vencida.';
    } else {
      motivo = 'Sem risco físico comprovado, mas 20% ou mais da frota está sem dados suficientes.';
    }
  } else {
    situacao = 'controlada';
    motivo = 'Nenhum pneu crítico ou em monitoramento, e a maior parte da frota tem medição classificável nas posições obrigatórias.';
  }

  const justificativa = lista
    .filter((v) => v.classe !== 'sem_risco' || v.medicao_vencida || v.sulco_incompleto)
    .slice()
    .sort((a, b) => (ORDEM_CLASSE[a.classe] ?? 9) - (ORDEM_CLASSE[b.classe] ?? 9)
      || String(a.placa || '').localeCompare(String(b.placa || ''), 'pt-BR'));

  return {
    situacao,
    situacao_label: labelSituacaoExecutiva(situacao),
    motivo,
    veiculos_ativos: N,
    sem_risco_critico: R,
    com_monitoramento: M,
    com_criticos: C,
    sem_dados: D,
    frota_avaliada_pct: avaliadaPct,
    veiculos_medicao_vencida: vencidos,
    criticos_sobre_diagnosticados_pct: base,
    justificativa,
  };
}

export function montarDiagnosticoExecutivo({
  filiais,
  veiculos,
  pneus,
  tipo = null,
  incluirMatriz = false,
  agora = new Date(),
} = {}) {
  const porVeiculo = new Map();
  for (const pneu of pneus || []) {
    const id = Number(pneu.veiculo_id);
    if (!id) continue;
    if (!porVeiculo.has(id)) porVeiculo.set(id, []);
    porVeiculo.get(id).push(pneu);
  }

  let matrizFora = false;
  const saida = [];
  for (const filial of filiais || []) {
    if (ehMatriz(filial.codigo) && !incluirMatriz) {
      matrizFora = true;
      continue;
    }
    const daFilial = (veiculos || []).filter((v) => Number(v.filial_id) === Number(filial.id));
    const classificados = [];
    for (const veiculo of daFilial) {
      if (!veiculoCombinaTipo(veiculo.tipo, tipo)) continue;
      classificados.push(classificarVeiculoExecutivo(
        veiculo,
        porVeiculo.get(Number(veiculo.id)) || [],
        { diaFilial: filial.dia_medicao, agora },
      ));
    }
    saida.push({
      id: filial.id,
      nome: filial.nome,
      codigo: filial.codigo,
      dia_medicao: filial.dia_medicao ?? null,
      ...classificarFilialExecutiva(classificados),
    });
  }

  saida.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  return {
    gerado_em: agora.toISOString(),
    cortes: CORTES_EXECUTIVOS,
    matriz_fora_da_visao: matrizFora,
    filiais: saida,
  };
}

export async function consultarDiagnosticoExecutivo(db, {
  escopo = null,
  tipo = null,
  incluirMatriz = false,
  filialId = null,
  agora = new Date(),
} = {}) {
  let sql = `SELECT id, nome, codigo, dia_medicao FROM filiais WHERE ativo = 1`;
  const params = [];
  if (Array.isArray(escopo) && escopo.length) {
    sql += ` AND id IN (${escopo.map(() => '?').join(',')})`;
    params.push(...escopo.map(Number));
  }
  if (filialId != null && filialId !== '') {
    sql += ' AND id = ?';
    params.push(Number(filialId));
  }
  sql += ' ORDER BY nome';
  const filiais = await db.prepare(sql).all(...params);
  if (!filiais.length) {
    return {
      gerado_em: agora.toISOString(),
      cortes: CORTES_EXECUTIVOS,
      matriz_fora_da_visao: false,
      filiais: [],
    };
  }

  const ids = filiais.map((f) => Number(f.id));
  const marcas = ids.map(() => '?').join(',');
  const veiculos = await db.prepare(`
    SELECT id, placa, apelido, tipo, layout_pneus, cadastro_completo, dia_medicao, filial_id
    FROM veiculos
    WHERE ativo = 1 AND filial_id IN (${marcas})
  `).all(...ids);
  const pneus = await db.prepare(`
    SELECT
      p.id, p.veiculo_id, p.filial_id, p.posicao, p.numero_fogo, p.vida_recap,
      p.condicao, p.tipo_pneu,
      um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar, um.sulco_mm,
      um.inspecao_danos, um.data_medicao
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1
    ${SQL_LATERAL_ULTIMA_MEDICAO}
    WHERE p.ativo = 1 AND p.status_pneu = 'montado' AND v.filial_id IN (${marcas})
  `).all(...ids);

  return montarDiagnosticoExecutivo({
    filiais,
    veiculos,
    pneus,
    tipo,
    incluirMatriz,
    agora,
  });
}
