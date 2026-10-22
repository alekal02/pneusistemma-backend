/**
 * Diagnóstico executivo das filiais. Somente leitura.
 * A classe de cada pneu vem de avaliarPneuPainel / bucketKpi e dos limites oficiais.
 * A situação da filial usa a fatia dos pneus montados. Pneu sem medição não entra como boa condição.
 * Alta necessidade: 20% ou mais em substituição prioritária e pelo menos 2 pneus.
 * Acompanhamento da unidade: 20% ou mais na faixa oficial de atenção, ou 10% ou mais em substituição.
 * Abaixo disso a unidade permanece em boa condição e os pneus de substituição ficam listados à parte.
 * Sensibilidade na frota real: 20% e 25% de substituição marcam as mesmas duas unidades;
 * 30% deixaria de fora uma unidade com 27,8%. O exemplo 3/120 (2,5%) com 47,5% em acompanhamento
 * fica em acompanhamento pela faixa de atenção, não por alta necessidade.
 */
import { bucketKpi, avaliarPneuPainel, veiculoCombinaTipo } from './indicadores-frota.js';
import { especificacaoMedicao } from '../medicao-perfil.js';
import { posicoesDoLayout, situacaoMedicao } from './diagnostico-frota.js';
import { labelPosicao, papelPosicao } from '../pneus-layouts.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { limitesDoVeiculo } from '../limites.js';

export const CORTES_EXECUTIVOS = {
  min_pneus_criticos: 2,
  pct_criticos: 20,
  pct_prioridade_acompanhamento: 10,
  pct_atencao: 20,
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
  if (situacao === 'controlada') return 'Boa condição';
  if (situacao === 'atencao') return 'Requer acompanhamento';
  if (situacao === 'critica') return 'Alta necessidade de intervenção';
  if (situacao === 'nao_avaliada') return 'Dados insuficientes';
  return situacao || '—';
}

export function labelClasseVeiculo(classe) {
  if (classe === 'critico') return 'Com substituição prioritária';
  if (classe === 'monitoramento') return 'Com pneus em acompanhamento';
  if (classe === 'sem_dados') return 'Dados insuficientes';
  if (classe === 'sem_risco') return 'Sem substituição prioritária';
  return classe || '—';
}

function percentual(parte, total) {
  if (!total) return null;
  return Math.round((1000 * parte) / total) / 10;
}

/**
 * Condição consolidada da unidade, separada da lista de pneus que pedem ação.
 * Os mm continuam os limites oficiais. Não há índice único de saúde.
 */
export function decidirSituacaoExecutiva({
  veiculos = 0,
  diagnosticados = 0,
  veiculosSemDados = 0,
  pneusMontados = 0,
  pneusOk = 0,
  pneusCriticos = 0,
  pneusMonitorar = 0,
  pneusSemDados = 0,
  vencidosDiagnosticados = 0,
} = {}) {
  const semDadosVeiculosPct = percentual(veiculosSemDados, veiculos);
  const pctCritico = percentual(pneusCriticos, pneusMontados);
  const pctAtencao = percentual(pneusMonitorar, pneusMontados);
  const pctSemAlerta = percentual(pneusOk, pneusMontados);
  const pctSemDados = percentual(pneusSemDados, pneusMontados);
  const vencidaPct = percentual(vencidosDiagnosticados, diagnosticados);
  const base = {
    sem_frota: veiculos === 0,
    pct_critico: pctCritico,
    pct_atencao: pctAtencao,
    pct_sem_alerta: pctSemAlerta,
    pct_sem_dados: pctSemDados,
  };

  if (veiculos === 0) {
    return { ...base, situacao: 'nao_avaliada', motivo: 'Dados insuficientes. Sem frota cadastrada.' };
  }
  if (pneusMontados === 0 || diagnosticados === 0) {
    return {
      ...base,
      situacao: 'nao_avaliada',
      motivo: pneusMontados === 0
        ? 'Dados insuficientes. Há veículos ativos, mas nenhum pneu montado.'
        : 'Dados insuficientes. Nenhum veículo ativo tem condição física comprovada pelo motor oficial.',
    };
  }
  if (
    pneusCriticos === 0
    && pneusMonitorar === 0
    && semDadosVeiculosPct >= CORTES_EXECUTIVOS.pct_sem_dados_nao_avaliada
  ) {
    return {
      ...base,
      situacao: 'nao_avaliada',
      motivo: 'Dados insuficientes. Metade ou mais da frota está sem medição classificável e não há substituição nem acompanhamento comprovado.',
    };
  }
  const prioridadeRelevante = pctCritico >= CORTES_EXECUTIVOS.pct_prioridade_acompanhamento;
  if (
    pneusCriticos >= CORTES_EXECUTIVOS.min_pneus_criticos
    && pctCritico >= CORTES_EXECUTIVOS.pct_criticos
  ) {
    return {
      ...base,
      situacao: 'critica',
      motivo: `Alta necessidade de intervenção: ${pneusCriticos} pneus (${pctCritico}%) na faixa oficial de substituição, entre ${pneusMontados} montados.`,
    };
  }
  if (
    prioridadeRelevante
    || pctAtencao >= CORTES_EXECUTIVOS.pct_atencao
    || semDadosVeiculosPct >= CORTES_EXECUTIVOS.pct_sem_dados_atencao
    || pctSemDados >= CORTES_EXECUTIVOS.pct_sem_dados_atencao
    || vencidaPct >= CORTES_EXECUTIVOS.pct_vencida_atencao
  ) {
    const partes = [];
    if (pctAtencao >= CORTES_EXECUTIVOS.pct_atencao) {
      partes.push(`${pneusMonitorar} pneus (${pctAtencao}%) na faixa oficial de acompanhamento`);
    }
    if (pctSemDados >= CORTES_EXECUTIVOS.pct_sem_dados_atencao) {
      partes.push(`${pneusSemDados} pneus (${pctSemDados}%) sem medição, fora da boa condição`);
    } else if (semDadosVeiculosPct >= CORTES_EXECUTIVOS.pct_sem_dados_atencao) {
      partes.push(`${semDadosVeiculosPct}% dos veículos sem medição classificável`);
    }
    if (vencidaPct >= CORTES_EXECUTIVOS.pct_vencida_atencao) {
      partes.push('metade ou mais dos veículos com condição comprovada está com medição vencida');
    }
    if (pneusCriticos > 0) {
      partes.push(`${pneusCriticos} pneus (${pctCritico}%) com substituição prioritária, listados à parte`);
    }
    const motivo = `Requer acompanhamento: ${partes.join('; ')}. A unidade não está em alta necessidade de intervenção.`;
    return { ...base, situacao: 'atencao', motivo };
  }
  const aParte = pneusCriticos > 0
    ? ` ${pneusCriticos} pneu(s) (${pctCritico}%) com substituição prioritária ficam listados à parte e não mudam a condição da unidade.`
    : '';
  return {
    ...base,
    situacao: 'controlada',
    motivo: `Boa condição: ${pctSemAlerta}% dos ${pneusMontados} pneus montados estão acima da faixa oficial de acompanhamento.${aParte}`,
  };
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
  const contagem = { montados: montados.length, ok: 0, monitorar: 0, critico: 0, sem_dado: 0, risco_imediato: 0 };
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
    if (contagem[kpi] != null) contagem[kpi] += 1;
    else contagem.sem_dado += 1;
    const riscoImediato = kpi === 'critico' && papelPosicao(pneu.posicao) === 'direcional';
    if (riscoImediato) contagem.risco_imediato += 1;
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
        risco_imediato: riscoImediato,
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
    risco_imediato: contagem.risco_imediato > 0,
    contagem_pneus: contagem,
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
  const somar = (campo) => lista.reduce((soma, veiculo) => soma + (Number(veiculo.contagem_pneus?.[campo]) || 0), 0);
  const pneusMontados = somar('montados');
  const pneusOk = somar('ok');
  const pneusMonitorar = somar('monitorar');
  const pneusCriticos = somar('critico');
  const pneusSemDados = somar('sem_dado');
  const riscosImediatos = somar('risco_imediato');
  const base = percentual(C, diagnosticados);
  const avaliadaPct = percentual(integrais, N);
  const decisao = decidirSituacaoExecutiva({
    veiculos: N,
    diagnosticados,
    veiculosSemDados: D,
    pneusMontados,
    pneusOk,
    pneusCriticos,
    pneusMonitorar,
    pneusSemDados,
    vencidosDiagnosticados,
  });
  let { situacao, motivo } = decisao;
  const frotaAfetada = percentual(C, N);
  if (situacao !== 'critica' && pneusCriticos > 0 && frotaAfetada != null && frotaAfetada >= 30) {
    motivo = `${motivo} A substituição está em ${frotaAfetada}% dos veículos.`;
  }
  if (riscosImediatos > 0) {
    motivo = `${motivo} ${riscosImediatos} em posição direcional, com intervenção imediata destacada.`;
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
    sem_frota: decisao.sem_frota,
    veiculos_ativos: N,
    sem_risco_critico: R,
    com_monitoramento: M,
    com_criticos: C,
    sem_dados: D,
    frota_avaliada_pct: avaliadaPct,
    frota_afetada_pct: percentual(C, N),
    veiculos_medicao_vencida: vencidos,
    criticos_sobre_diagnosticados_pct: base,
    pneus_montados: pneusMontados,
    pneus_sem_alerta: pneusOk,
    pneus_atencao: pneusMonitorar,
    pneus_criticos: pneusCriticos,
    pneus_sem_dados: pneusSemDados,
    pct_sem_alerta: decisao.pct_sem_alerta,
    pct_atencao: decisao.pct_atencao,
    pct_critico: decisao.pct_critico,
    pct_sem_dados: decisao.pct_sem_dados,
    riscos_imediatos: riscosImediatos,
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
