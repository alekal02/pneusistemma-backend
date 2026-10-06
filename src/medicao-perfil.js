/**
 * Motor de medição por perfil do catálogo.
 * O backend decide campos, unidade e se há diagnóstico de desgaste.
 * Mini/giro (perfil industrial) não herdam régua nem diagnóstico de caminhão.
 */
import { resolverTipoEquipamento } from './equipamento-tipos.js';
import { perfilMedicaoVeiculo } from './pneus-layouts.js';
import { classificarSulco, getLimitesPorPerfil, limitesDoVeiculo, menorSulco } from './limites.js';
import {
  ACOES,
  desvioEntrePontos,
  desgastePorHora,
  desgastePorKm,
  diagnosticarPerfil,
  sugerirAcao,
} from './diagnostico.js';

export const INSPECOES_DANO = [
  { codigo: 'corte', label: 'Corte' },
  { codigo: 'dano_lateral', label: 'Dano lateral' },
  { codigo: 'desgaste_irregular', label: 'Desgaste irregular' },
  { codigo: 'outro', label: 'Outro' },
];

const CODIGOS_INSPECAO = new Set(INSPECOES_DANO.map((i) => i.codigo));

function codigoInspecao(valor) {
  const n = String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');
  if (CODIGOS_INSPECAO.has(n)) return n;
  return null;
}

function numero(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Especificação que o frontend só renderiza.
 * Unidade e perfil vêm do catálogo; layout antigo só entra se o tipo não resolver.
 */
export function especificacaoMedicao(tipo, layoutId = null) {
  const perfilBruto = perfilMedicaoVeiculo(tipo, layoutId);
  const codigo = perfilBruto === 'trator' || perfilBruto === 'industrial' ? perfilBruto : 'caminhao';
  const tipoCat = resolverTipoEquipamento(tipo);
  let unidade = tipoCat?.unidade_uso;
  if (unidade !== 'km' && unidade !== 'horas') {
    unidade = codigo === 'caminhao' ? 'km' : 'horas';
  }
  const quatro = codigo === 'caminhao' || codigo === 'trator';
  return {
    codigo,
    tipo_codigo: tipoCat?.codigo || null,
    unidade,
    sulco: quatro ? 'quatro_pontos' : 'simples',
    inspecao_danos: codigo === 'industrial',
    diagnostico_desgaste: codigo !== 'industrial',
    inspecoes: codigo === 'industrial' ? INSPECOES_DANO.map((i) => ({ ...i })) : [],
  };
}

export function normalizarInspecao(valor) {
  if (valor == null || valor === '') return { dados: null };
  let bruto = valor;
  if (typeof bruto === 'string') {
    const t = bruto.trim();
    if (!t) return { dados: null };
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        bruto = JSON.parse(t);
      } catch {
        return { erro: 'Inspeção de danos inválida' };
      }
    } else {
      bruto = t.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  let itens = [];
  let outro = null;
  if (Array.isArray(bruto)) {
    itens = bruto;
  } else if (bruto && typeof bruto === 'object') {
    itens = bruto.itens || bruto.tipos || [];
    outro = bruto.outro ?? bruto.descricao ?? null;
  } else {
    return { erro: 'Inspeção de danos inválida' };
  }

  const norm = [];
  for (const item of itens) {
    const codigo = codigoInspecao(item);
    if (!codigo) return { erro: `Inspeção inválida: ${item}` };
    if (!norm.includes(codigo)) norm.push(codigo);
  }
  if (!norm.length) return { dados: null };
  const detalhe = outro != null ? String(outro).trim() || null : null;
  return {
    dados: {
      itens: norm,
      outro: norm.includes('outro') ? detalhe : null,
    },
  };
}

function sulcoReferencia(row, spec) {
  if (!row) return null;
  if (spec.sulco === 'simples') {
    const simples = numero(row.sulco_mm);
    if (simples != null && !Number.isNaN(simples)) return simples;
    return menorSulco(row);
  }
  return menorSulco({
    sulco_externo: row.sulco_externo,
    sulco_central: row.sulco_central,
    sulco_interno: row.sulco_interno,
    sulco_auxiliar: row.sulco_auxiliar,
  });
}

/**
 * Zera o que o perfil não mede. Não altera a medição anterior gravada.
 */
export function prepararMedicao(body, contexto = {}) {
  const spec = especificacaoMedicao(contexto.tipo, contexto.layout);
  const origem = body || {};
  const pressao = numero(origem.pressao_psi);
  if (Number.isNaN(pressao)) return { erro: 'Pressão inválida', spec };

  let km = numero(origem.km_veiculo);
  let hr = numero(origem.hr_veiculo);
  if (Number.isNaN(km) || Number.isNaN(hr)) return { erro: 'Uso do equipamento inválido', spec };
  if (spec.unidade === 'km') {
    km = km ? Math.trunc(km) : null;
    hr = null;
  } else {
    km = null;
    hr = hr ?? null;
  }

  let sulcos = {
    sulco_externo: null,
    sulco_central: null,
    sulco_interno: null,
    sulco_auxiliar: null,
  };
  let sulcoMm = null;
  let inspecao = null;
  let marcacao = null;

  if (spec.sulco === 'quatro_pontos') {
    const campos = ['sulco_externo', 'sulco_central', 'sulco_interno', 'sulco_auxiliar'];
    for (const campo of campos) {
      const n = numero(origem[campo]);
      if (Number.isNaN(n)) return { erro: 'Sulco inválido', spec };
      sulcos[campo] = n;
    }
    if (menorSulco(sulcos) == null) {
      return { erro: 'Informe ao menos um valor de sulco', spec };
    }
    marcacao = origem.marcacao_json ?? null;
  } else {
    let n = numero(origem.sulco_mm ?? origem.sulco_simples);
    if (Number.isNaN(n)) return { erro: 'Sulco inválido', spec };
    if (n == null) {
      n = menorSulco({
        sulco_externo: origem.sulco_externo,
        sulco_central: origem.sulco_central,
        sulco_interno: origem.sulco_interno,
        sulco_auxiliar: origem.sulco_auxiliar,
      });
    }
    if (n == null) return { erro: 'Informe o sulco', spec };
    sulcoMm = n;
    const insp = normalizarInspecao(origem.inspecao_danos);
    if (insp.erro) return { erro: insp.erro, spec };
    inspecao = insp.dados;
  }

  const dados = {
    km_veiculo: km,
    hr_veiculo: hr,
    ...sulcos,
    sulco_mm: sulcoMm,
    inspecao_danos: inspecao,
    pressao_psi: pressao,
    marcacao_json: marcacao,
  };

  const limites = getLimitesPorPerfil(spec.codigo);
  const menor = spec.sulco === 'simples' ? sulcoMm : menorSulco(sulcos);
  const anterior = contexto.anterior || null;
  const sulcoAnterior = sulcoReferencia(anterior, spec);

  let desgasteKm = null;
  let desgasteHora = null;
  if (spec.unidade === 'km') {
    desgasteKm = desgastePorKm(sulcoAnterior, menor, anterior?.km_veiculo, km);
  } else {
    desgasteHora = desgastePorHora(sulcoAnterior, menor, anterior?.hr_veiculo, hr);
  }

  const alerta = avaliarAlertaPerfil(
    {
      ...sulcos,
      sulco_mm: sulcoMm,
      inspecao_danos: inspecao,
      pressao_psi: pressao,
    },
    {
      spec,
      limites,
      menor,
      vidaRecap: contexto.vidaRecap || 0,
      candidatos: contexto.candidatos || [],
      posicao: contexto.posicao || null,
      papel: contexto.papel || null,
      tipo: contexto.tipo || null,
      layout: contexto.layout || null,
      hr_veiculo: hr,
      km_veiculo: km,
    },
  );

  return {
    spec,
    ...dados,
    menor_sulco: menor,
    status_sulco: alerta.status_sulco,
    diagnostico: alerta.diagnostico,
    acao: alerta.acao,
    alertas: alerta.alertas,
    notificar: alerta.notificar,
    alerta,
    desgaste_mm_km: desgasteKm,
    desgaste_mm_hora: desgasteHora,
    limites,
  };
}

export function limitesDaMedicao(tipo, layoutId = null) {
  return limitesDoVeiculo({ tipo, layout_pneus: layoutId });
}

const DIAG_VAZIO = { codigo: null, label: null, descricao: '' };
const ACAO_VAZIA = {
  codigo: null,
  label: null,
  motivo: null,
  rodizio_sugestao: null,
  desvio_mm: null,
};

function copiarAcao(base, extra = {}) {
  return {
    codigo: base.codigo,
    label: base.label,
    motivo: extra.motivo ?? null,
    rodizio_sugestao: null,
    desvio_mm: extra.desvio_mm ?? null,
    prioridade: base.prioridade,
  };
}

function textoInspecao(codigo, inspecao) {
  if (codigo === 'corte') {
    return 'Corte identificado na inspeção. Verificar o pneu pelo horímetro.';
  }
  if (codigo === 'dano_lateral') {
    return 'Dano lateral identificado na inspeção. Verificar o flanco pelo horímetro.';
  }
  if (codigo === 'desgaste_irregular') {
    return 'Desgaste irregular identificado na inspeção. Verificar o desgaste pelo horímetro.';
  }
  const detalhe = inspecao?.outro ? ` (${inspecao.outro})` : '';
  return `Outro dano informado${detalhe}. Solicitar inspeção e avaliação.`;
}

function alertasDoCaminhao(status, diagnostico, acao) {
  const lista = [];
  if (status === 'critico') {
    lista.push({ codigo: 'sulco_critico', severidade: 'critico', texto: acao.motivo });
  }
  if (acao.codigo === 'monitorar' || status === 'alerta') {
    lista.push({ codigo: 'monitoramento', severidade: 'alerta', texto: acao.motivo });
  }
  if (diagnostico.codigo === 'irregular' || acao.codigo === 'rodizio') {
    lista.push({
      codigo: 'desgaste_irregular',
      severidade: 'alerta',
      texto: diagnostico.descricao || acao.motivo,
    });
  }
  if (diagnostico.codigo === 'falta_calib' || diagnostico.codigo === 'excesso_calib') {
    lista.push({ codigo: 'pressao', severidade: 'alerta', texto: diagnostico.descricao });
  }
  if (acao.codigo === 'rodizio') {
    lista.push({ codigo: 'rodizio', severidade: 'alerta', texto: acao.motivo });
  }
  if (acao.codigo === 'recap' || acao.prazo_recap_dias) {
    lista.push({
      codigo: 'recapagem',
      severidade: status === 'critico' ? 'critico' : 'alerta',
      texto: acao.motivo,
    });
  }
  return lista.filter((item) => item.texto);
}

function avaliarCaminhao(entrada, ctx, menor) {
  const { spec, limites } = ctx;
  const pontos = {
    sulco_externo: entrada.sulco_externo ?? null,
    sulco_central: entrada.sulco_central ?? null,
    sulco_interno: entrada.sulco_interno ?? null,
    sulco_auxiliar: entrada.sulco_auxiliar ?? null,
  };
  const diagnostico = diagnosticarPerfil(pontos, limites.diagnostico_tolerancia_mm, {
    papel: ctx.papel || null,
    posicao: ctx.posicao || null,
    limites,
    tipo: ctx.tipo || null,
    layout: ctx.layout || null,
  });
  const acao = sugerirAcao(menor, limites, ctx.vidaRecap || 0, {
    pontos,
    candidatos: ctx.candidatos || [],
    posicaoAtual: ctx.posicao || null,
  });
  const status = classificarSulco(menor, limites);
  return fecharAlerta({
    spec,
    limites,
    status,
    diagnostico,
    acao,
    alertas: alertasDoCaminhao(status, diagnostico, acao),
    menor,
    ctx,
  });
}

function avaliarTrator(entrada, ctx, menor) {
  const { spec, limites } = ctx;
  const pontos = {
    sulco_externo: entrada.sulco_externo ?? null,
    sulco_central: entrada.sulco_central ?? null,
    sulco_interno: entrada.sulco_interno ?? null,
    sulco_auxiliar: entrada.sulco_auxiliar ?? null,
  };
  const diagnostico = diagnosticarPerfil(pontos, limites.diagnostico_tolerancia_mm, {
    papel: ctx.papel || null,
    posicao: ctx.posicao || null,
    limites,
    tipo: ctx.tipo || null,
    layout: ctx.layout || null,
  });
  const status = classificarSulco(menor, limites);
  const desvio = desvioEntrePontos(pontos);
  const critico = limites.sulco_critico_mm;
  const ate = limites.sulco_alerta_mm;
  const limiarDif = limites.rodizio_desvio_mm ?? 4;
  const tolerancia = limites.diagnostico_tolerancia_mm ?? 1;
  let acao;

  if (menor == null) {
    acao = { ...ACAO_VAZIA };
  } else if (menor <= critico) {
    acao = copiarAcao(ACOES.substituir, {
      desvio_mm: desvio,
      motivo: `Sulco ${menor} mm atingiu o limite crítico (${critico} mm). Programar substituição e reinspecionar em horas.`,
    });
  } else if (desvio != null && desvio > limiarDif) {
    acao = copiarAcao(ACOES.verificar_desgaste, {
      desvio_mm: desvio,
      motivo: `Diferença de ${desvio} mm entre os pontos. Verificar desgaste e reinspecionar em horas.`,
    });
  } else if (menor <= ate) {
    acao = copiarAcao(ACOES.monitorar, {
      desvio_mm: desvio,
      motivo: `Sulco ${menor} mm em monitoramento (limiar ${ate} mm). Reinspecionar em horas.`,
    });
  } else if (desvio != null && desvio > tolerancia) {
    acao = copiarAcao(ACOES.reinspecionar, {
      desvio_mm: desvio,
      motivo: `Diferença de ${desvio} mm. Reinspecionar em horas.`,
    });
  } else {
    acao = copiarAcao(ACOES.ok, {
      desvio_mm: desvio,
      motivo: `Sulco ${menor} mm acima de ${ate} mm. Próxima inspeção pelo horímetro.`,
    });
  }

  const alertas = acao.codigo && acao.codigo !== 'ok'
    ? [{
      codigo: acao.codigo,
      severidade: acao.codigo === 'substituir' ? 'critico' : 'alerta',
      texto: acao.motivo,
    }]
    : [];

  return fecharAlerta({
    spec,
    limites,
    status,
    diagnostico,
    acao,
    alertas,
    menor,
    ctx,
  });
}

function avaliarIndustrial(entrada, ctx, menor) {
  const { spec, limites } = ctx;
  const status = classificarSulco(menor, limites);
  const insp = normalizarInspecao(entrada.inspecao_danos);
  const inspecao = insp.erro ? null : insp.dados;
  const opcoes = [];

  for (const codigo of ['corte', 'dano_lateral', 'desgaste_irregular']) {
    if (!inspecao?.itens?.includes(codigo)) continue;
    const base = ACOES[codigo];
    opcoes.push(copiarAcao(base, { motivo: textoInspecao(codigo, inspecao) }));
  }
  if (inspecao?.itens?.includes('outro')) {
    opcoes.push(copiarAcao(ACOES.avaliar, { motivo: textoInspecao('outro', inspecao) }));
  }
  if (status === 'critico') {
    opcoes.push(copiarAcao(ACOES.substituir, {
      motivo: `Sulco ${menor} mm atingiu o limite configurado (${limites.sulco_critico_mm} mm). Programar substituição e reinspecionar em horas.`,
    }));
  } else if (status === 'alerta') {
    opcoes.push(copiarAcao(ACOES.monitorar, {
      motivo: `Sulco ${menor} mm em monitoramento (limiar ${limites.sulco_alerta_mm} mm). Reinspecionar em horas.`,
    }));
  }

  opcoes.sort((a, b) => (b.prioridade ?? 0) - (a.prioridade ?? 0));
  const acao = opcoes[0] || { ...ACAO_VAZIA };
  const alertas = opcoes.map((item) => ({
    codigo: item.codigo,
    severidade: item.codigo === 'substituir' || item.codigo === 'corte' || item.codigo === 'dano_lateral'
      ? 'critico'
      : 'alerta',
    texto: item.motivo,
  }));

  return fecharAlerta({
    spec,
    limites,
    status,
    diagnostico: { ...DIAG_VAZIO },
    acao,
    alertas,
    menor,
    ctx,
  });
}

function fecharAlerta({ spec, limites, status, diagnostico, acao, alertas, menor, ctx }) {
  const notificar = spec.codigo === 'caminhao'
    ? status === 'alerta' || status === 'critico'
    : Boolean(acao?.codigo && acao.codigo !== 'ok');
  const severidade = !notificar
    ? null
    : (spec.codigo === 'caminhao'
      ? status
      : ((alertas || []).some((item) => item.severidade === 'critico') ? 'critico' : 'alerta'));
  return {
    spec,
    limites,
    status_sulco: status,
    diagnostico: diagnostico || { ...DIAG_VAZIO },
    acao: acao || { ...ACAO_VAZIA },
    alertas: alertas || [],
    menor_sulco: menor,
    unidade: spec.unidade,
    hr_veiculo: ctx.hr_veiculo ?? null,
    km_veiculo: ctx.km_veiculo ?? null,
    severidade,
    notificar,
  };
}

/**
 * Alertas e ação a partir do perfil de medição.
 * Caminhão/compactador delega às regras já existentes.
 */
export function avaliarAlertaPerfil(entrada = {}, contexto = {}) {
  const spec = contexto.spec || especificacaoMedicao(contexto.tipo, contexto.layout);
  const limites = contexto.limites || getLimitesPorPerfil(spec.codigo);
  const pontos = {
    sulco_externo: entrada.sulco_externo ?? null,
    sulco_central: entrada.sulco_central ?? null,
    sulco_interno: entrada.sulco_interno ?? null,
    sulco_auxiliar: entrada.sulco_auxiliar ?? null,
    sulco_mm: entrada.sulco_mm ?? null,
  };
  let menor = contexto.menor;
  if (menor == null) {
    menor = spec.sulco === 'simples'
      ? menorSulco(pontos)
      : menorSulco({
        sulco_externo: pontos.sulco_externo,
        sulco_central: pontos.sulco_central,
        sulco_interno: pontos.sulco_interno,
        sulco_auxiliar: pontos.sulco_auxiliar,
      });
  }
  const ctx = { ...contexto, spec, limites };
  if (spec.codigo === 'trator') return avaliarTrator(entrada, ctx, menor);
  if (spec.codigo === 'industrial') return avaliarIndustrial(entrada, ctx, menor);
  return avaliarCaminhao(entrada, ctx, menor);
}

export function classeAlerta(alerta) {
  if (alerta?.notificar && alerta.severidade === 'critico') return 'critico';
  if (alerta?.notificar) return 'alerta';
  if (alerta?.status_sulco === 'sem_dado') return 'sem_dado';
  if (alerta?.status_sulco === 'ok' || alerta?.acao?.codigo === 'ok') return 'ok';
  return 'sem_classificacao';
}

export function rotuloAlerta(alerta, temMedicao = true) {
  if (alerta?.notificar && alerta.acao?.label) return alerta.acao.label;
  if (alerta?.status_sulco === 'ok') return 'OK';
  if (alerta?.status_sulco === 'alerta') return 'Alerta';
  if (alerta?.status_sulco === 'critico') return 'Critico';
  if (alerta?.status_sulco === 'sem_dado' || !temMedicao) return 'Sem medicao';
  return 'Sem classificacao';
}

export function textoMensagemAlerta(alerta, { veiculo, pneu, menorSulco: menor = null } = {}) {
  const acao = alerta?.acao || {};
  const linhas = [
    '🚨 *ALERTA DE PNEU* 🚨',
    '',
    `Veículo: *${veiculo?.placa || '-'}*`,
    `Posição: ${pneu?.posicao || '-'}${pneu?.numero_fogo ? ` — Fogo: ${pneu.numero_fogo}` : ''}`,
  ];
  if (acao.label) linhas.push(`Ação: *${acao.label}*`);
  if (alerta?.status_sulco && menor != null) linhas.push(`Sulco mínimo: ${menor} mm`);
  if (alerta?.unidade === 'horas' && alerta.hr_veiculo != null) {
    linhas.push(`Horímetro: ${alerta.hr_veiculo} h`);
  }
  if (alerta?.diagnostico?.label) linhas.push(`Diagnóstico: ${alerta.diagnostico.label}`);
  const vistos = new Set();
  for (const item of alerta?.alertas || []) {
    if (!item?.texto || vistos.has(item.texto)) continue;
    vistos.add(item.texto);
    linhas.push(item.texto);
  }
  if (acao.motivo && !vistos.has(acao.motivo)) linhas.push(acao.motivo);
  return linhas.join('\n');
}

export function pesoAlerta(alerta) {
  if (alerta?.notificar && alerta.severidade === 'critico') return 0;
  if (alerta?.notificar) return 1;
  if (alerta?.status_sulco === 'ok' || alerta?.acao?.codigo === 'ok') return 2;
  if (alerta?.status_sulco === 'sem_dado') return 4;
  return 3;
}
