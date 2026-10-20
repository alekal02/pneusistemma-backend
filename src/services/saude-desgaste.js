/**
 * Saúde e desgaste para a visão do presidente.
 * Só calcula em memória. Não grava, não reclassifica medição antiga e não mistura ciclos.
 *
 * Régua de recapagem (caminhão que admite recap):
 *   > 8 mm acompanhamento normal
 *   > 5 e ≤ 8 mm monitoramento preventivo
 *   > 3 e ≤ 5 mm programar recapagem
 *   ≤ 3 mm crítico — retirada e avaliação urgente, nunca apto automático
 * O menor sulco usa só externo, central e interno.
 */

export const LIMIARES_RECAP = { critico: 3, programar: 5, preventivo: 8 };
export const MIN_AMOSTRA_GRUPO = 3;
export const FOLGA_MEDIA = 1.25;
export const USO_MINIMO = { km: 100, horas: 10 };
export const JANELA_MINIMA_DIAS = 14;
export const HORIZONTE_DATA_DIAS = 540;
export const MAX_PONTOS_EVOLUCAO = 24;

export const FAIXAS = {
  acompanhamento_normal: 'Acompanhamento normal',
  monitoramento_preventivo: 'Monitoramento preventivo',
  programar_recapagem: 'Programar recapagem',
  critico: 'Crítico',
  sem_medicao: 'Sem medição de banda',
  critico_equipamento: 'Crítico do equipamento',
  monitoramento_equipamento: 'Monitoramento do equipamento',
  acompanhamento_equipamento: 'Acompanhamento do equipamento',
  sem_regua: 'Sem régua de sulco',
};

export const LIMITACOES_FIXAS = [
  'O menor sulco da régua de recapagem usa apenas externo, central e interno. Sulco auxiliar não entra nessa conta.',
  'Medições de ciclos de recapagem diferentes não são somadas para consumo nem para projeção.',
  'Projeção de 5 mm e 3 mm só aparece com pelo menos duas medições no mesmo ciclo, uso crescente e consumo de borracha. Sem isso, o campo fica vazio.',
  'Data estimada exige janela de pelo menos 14 dias e horizonte de até 18 meses. Fora disso, mostra-se só o uso restante.',
  'KM e horas não entram no mesmo cálculo.',
  'Pneu em 3 mm ou menos nunca é marcado como apto para recapagem.',
  'Candidato à programação de recapagem ainda depende de conferência humana. Não há envio automático.',
  'Dianteira de caminhão permanece com pneu novo. Recapado não é tratado como opção nessa posição.',
  'Trator, mini carregadeira e giro zero não usam a régua de 8/5/3 mm.',
  'Causas de desgaste irregular são hipóteses para inspeção, não diagnóstico automático.',
  'Consumo acima da média só é apontado em grupo comparável (tipo, medida, posição, unidade e vida) com pelo menos 3 pneus.',
  'Nenhum dado histórico é alterado por este relatório.',
];

const DANOS_BLOQUEIO = new Set(['corte', 'dano_lateral', 'desgaste_irregular', 'outro']);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sulcoValido(v) {
  const n = num(v);
  if (n == null || n < 0 || n > 100) return null;
  return n;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function dataIso(valor) {
  if (!valor) return null;
  const s = String(valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function diasEntre(a, b) {
  if (!a || !b) return null;
  const da = new Date(`${a}T12:00:00Z`);
  const db = new Date(`${b}T12:00:00Z`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.round((db - da) / 86400000);
}

function adicionarDias(iso, dias) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Math.round(dias));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function sulcosBanda(row) {
  return {
    externo: sulcoValido(row?.sulco_externo),
    central: sulcoValido(row?.sulco_central),
    interno: sulcoValido(row?.sulco_interno),
  };
}

/** Menor sulco válido entre externo, central e interno. Auxiliar fica de fora. */
export function menorSulcoBanda(row) {
  const vals = Object.values(sulcosBanda(row)).filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

export function faixaRecapagemCaminhao(menor) {
  if (menor == null) return 'sem_medicao';
  if (menor <= LIMIARES_RECAP.critico) return 'critico';
  if (menor <= LIMIARES_RECAP.programar) return 'programar_recapagem';
  if (menor <= LIMIARES_RECAP.preventivo) return 'monitoramento_preventivo';
  return 'acompanhamento_normal';
}

export function faixaDoEquipamento(menor, perfil, limites = {}) {
  if (perfil === 'industrial') return 'sem_regua';
  if (perfil !== 'trator') return faixaRecapagemCaminhao(menor);
  if (menor == null) return 'sem_medicao';
  const critico = num(limites.sulco_critico_mm);
  const alerta = num(limites.sulco_alerta_mm);
  if (critico != null && menor <= critico) return 'critico_equipamento';
  if (alerta != null && menor <= alerta) return 'monitoramento_equipamento';
  return 'acompanhamento_equipamento';
}

export function classificarDesgasteBanda(row, { tolerancia = 1, pontosMinimos = 2 } = {}) {
  const sulcos = sulcosBanda(row);
  const vals = [sulcos.externo, sulcos.central, sulcos.interno].filter((v) => v != null);
  if (vals.length < pontosMinimos) {
    return { padrao: 'insuficiente', delta_mm: null, hipoteses: [] };
  }
  const delta = round1(Math.max(...vals) - Math.min(...vals));
  if (vals.length < 3) {
    const irregular = delta > tolerancia;
    return {
      padrao: irregular ? 'irregular' : 'uniforme_parcial',
      delta_mm: delta,
      hipoteses: irregular ? [{
        codigo: 'pontos_incompletos',
        texto: 'Hipótese: há diferença entre os sulcos medidos, mas falta um dos três pontos para distinguir o padrão. Não é diagnóstico.',
      }] : [],
    };
  }
  if (delta <= tolerancia) {
    return { padrao: 'uniforme', delta_mm: delta, hipoteses: [] };
  }

  const { externo: ext, central: cent, interno: int } = sulcos;
  const hipoteses = [];
  if (int - ext >= tolerancia) {
    hipoteses.push({
      codigo: 'consumo_ombro_externo',
      texto: 'Hipótese compatível com consumo progressivo do ombro externo, padrão que pode ser esperado no lado do veículo. Não indica falha por si só e não é diagnóstico.',
    });
  } else if (ext - int >= tolerancia) {
    hipoteses.push({
      codigo: 'ombro_interno',
      texto: 'Hipótese: ombro interno mais consumido que o externo. Causas possíveis a confirmar na inspeção: geometria, cambagem ou arraste. Não é diagnóstico automático.',
    });
  }
  const mediaBordas = (ext + int) / 2;
  if (mediaBordas - cent >= tolerancia) {
    hipoteses.push({
      codigo: 'centro_mais_gasto',
      texto: 'Hipótese: centro mais consumido que as bordas. Uma causa possível é pressão abaixo da recomendada. Confirmar na inspeção. Não é diagnóstico automático.',
    });
  } else if (cent - mediaBordas >= tolerancia) {
    hipoteses.push({
      codigo: 'bordas_mais_gastas',
      texto: 'Hipótese: bordas mais consumidas que o centro. Uma causa possível é pressão acima da recomendada. Confirmar na inspeção. Não é diagnóstico automático.',
    });
  }
  if (!hipoteses.length) {
    hipoteses.push({
      codigo: 'irregular_sem_padrao',
      texto: 'Hipótese: desgaste irregular sem padrão identificável só pelos três sulcos. A causa precisa de inspeção visual. Não é diagnóstico automático.',
    });
  }
  const soOmbroExterno = hipoteses.length === 1 && hipoteses[0].codigo === 'consumo_ombro_externo';
  return { padrao: soOmbroExterno ? 'progressivo' : 'irregular', delta_mm: delta, hipoteses };
}

function consumoVazio(unidade, motivo) {
  return {
    confiavel: false,
    mm_por_1000_km: null,
    mm_por_100_h: null,
    mm: null,
    uso: null,
    unidade,
    motivo,
    projecao: {
      disponivel: false,
      motivo,
      alvo_5: null,
      alvo_3: null,
    },
  };
}

function projetarAlvo(sulco, alvo, taxa, dataFim, diasJanela, deltaUso) {
  if (sulco <= alvo) {
    return { ja_atingido: true, uso_restante: 0, data: null, motivo: null };
  }
  const usoRestante = round1((sulco - alvo) / taxa);
  if (diasJanela == null || diasJanela < JANELA_MINIMA_DIAS) {
    return {
      ja_atingido: false,
      uso_restante: usoRestante,
      data: null,
      motivo: 'Há taxa de consumo, mas a janela de datas é curta demais para estimar um dia.',
    };
  }
  const dias = (usoRestante / deltaUso) * diasJanela;
  if (!Number.isFinite(dias) || dias > HORIZONTE_DATA_DIAS) {
    return {
      ja_atingido: false,
      uso_restante: usoRestante,
      data: null,
      motivo: 'O uso restante passa de 18 meses. A data não é estimada.',
    };
  }
  return {
    ja_atingido: false,
    uso_restante: usoRestante,
    data: adicionarDias(dataFim, dias),
    motivo: null,
  };
}

export function calcularConsumoEProjecao(medicoes, { unidade = 'km', reguaRecap = false } = {}) {
  const pontos = (medicoes || [])
    .map((m) => ({
      id: Number(m.id) || 0,
      data: dataIso(m.data_medicao || m.data),
      menor: menorSulcoBanda(m),
      uso: unidade === 'horas' ? num(m.hr_veiculo) : num(m.km_veiculo),
    }))
    .filter((p) => p.menor != null && p.uso != null && p.data)
    .sort((a, b) => a.data.localeCompare(b.data) || a.id - b.id);

  if (pontos.length < 2) {
    return consumoVazio(unidade, 'Menos de duas medições com sulco de banda e uso no mesmo ciclo.');
  }

  for (let i = 1; i < pontos.length; i += 1) {
    if (pontos[i].uso + 1e-6 < pontos[i - 1].uso) {
      return consumoVazio(unidade, 'O uso diminuiu dentro do ciclo. Consumo e projeção não calculados.');
    }
    if (pontos[i].menor > pontos[i - 1].menor + 0.5) {
      return consumoVazio(
        unidade,
        'O sulco aumentou dentro do ciclo. Pode haver mistura de ciclo ou erro de medição. Projeção não calculada.',
      );
    }
  }

  const ini = pontos[0];
  const fim = pontos[pontos.length - 1];
  const deltaUso = fim.uso - ini.uso;
  const deltaMm = ini.menor - fim.menor;
  if (deltaUso <= 0) {
    return consumoVazio(unidade, 'O uso não avançou entre a primeira e a última medição do ciclo.');
  }
  if (deltaMm <= 0) {
    return consumoVazio(unidade, 'Não houve consumo de borracha entre as medições do ciclo.');
  }

  const taxa = deltaMm / deltaUso;
  const saida = consumoVazio(unidade, null);
  saida.mm = round2(deltaMm);
  saida.uso = round2(deltaUso);
  if (unidade === 'horas') saida.mm_por_100_h = round2(taxa * 100);
  else saida.mm_por_1000_km = round2(taxa * 1000);

  const minimo = unidade === 'horas' ? USO_MINIMO.horas : USO_MINIMO.km;
  if (deltaUso < minimo) {
    const motivo = unidade === 'horas'
      ? 'Intervalo menor que 10 horas. A taxa fica registrada, mas não entra em média nem em projeção.'
      : 'Intervalo menor que 100 km. A taxa fica registrada, mas não entra em média nem em projeção.';
    saida.motivo = motivo;
    saida.projecao.motivo = motivo;
    return saida;
  }

  saida.confiavel = true;
  saida.motivo = null;
  if (!reguaRecap) {
    saida.projecao.motivo = 'A projeção de 5 mm e 3 mm aplica-se à régua de recapagem de caminhão. Este equipamento segue outra condição técnica.';
    return saida;
  }

  const dias = diasEntre(ini.data, fim.data);
  saida.projecao = {
    disponivel: true,
    motivo: null,
    alvo_5: projetarAlvo(fim.menor, 5, taxa, fim.data, dias, deltaUso),
    alvo_3: projetarAlvo(fim.menor, 3, taxa, fim.data, dias, deltaUso),
  };
  return saida;
}

function textoDano(codigo) {
  if (codigo === 'corte') return 'Inspeção registra corte.';
  if (codigo === 'dano_lateral') return 'Inspeção registra dano lateral.';
  if (codigo === 'desgaste_irregular') return 'Inspeção registra desgaste irregular.';
  if (codigo === 'outro') return 'Inspeção registra outro dano.';
  return 'Inspeção registra pendência técnica.';
}

/**
 * Nunca marca crítico como apto. Envio automático é sempre falso.
 */
export function avaliarElegibilidadeRecap({
  faixa,
  reguaRecap = false,
  papel = null,
  vidaRecap = 0,
  maxRecaps = 6,
  danos = [],
  statusPneu = 'montado',
  cicloConfiavel = true,
  inspecaoLegivel = true,
} = {}) {
  const bloqueios = [];
  if (!inspecaoLegivel) bloqueios.push('Inspeção de danos ilegível. Não dá para liberar envio.');
  if (statusPneu === 'descarte') bloqueios.push('Pneu em descarte.');
  if (statusPneu === 'recapagem') bloqueios.push('Pneu já está em recapagem.');
  if (!reguaRecap) bloqueios.push('Equipamento sem recapagem prevista nas regras técnicas.');
  if (papel === 'direcional') {
    bloqueios.push('Dianteira de caminhão exige pneu novo. Recapagem não é opção nesta posição.');
  }
  const vida = num(vidaRecap) || 0;
  const teto = num(maxRecaps);
  if (reguaRecap && teto != null && vida >= teto) {
    bloqueios.push(`Limite de recapagens atingido (${vida}/${teto}).`);
  }
  for (const dano of danos || []) {
    if (DANOS_BLOQUEIO.has(dano)) bloqueios.push(textoDano(dano));
  }
  if (cicloConfiavel === false && (faixa === 'programar_recapagem' || faixa === 'critico')) {
    bloqueios.push('Histórico de ciclo incompleto. Não usar só o sulco atual para decidir envio.');
  }

  if (faixa === 'critico' || faixa === 'critico_equipamento') {
    return {
      apto_recapagem: false,
      candidato_programacao: false,
      envio_automatico: false,
      encaminhamento: reguaRecap && papel !== 'direcional' && statusPneu !== 'descarte' && statusPneu !== 'recapagem'
        ? 'retirada_avaliacao_urgente'
        : 'retirada_substituicao',
      motivo: 'Crítico: retirar e encaminhar para avaliação urgente. Não é apto para recapagem de forma automática.',
      bloqueios,
    };
  }

  if (faixa !== 'programar_recapagem') {
    let motivo = 'Fora da faixa de programar recapagem.';
    if (faixa === 'monitoramento_preventivo') motivo = 'Monitoramento preventivo. Ainda não programar envio.';
    if (faixa === 'acompanhamento_normal') motivo = 'Acompanhamento normal.';
    if (faixa === 'sem_medicao') motivo = 'Sem sulco válido de banda para decidir recapagem.';
    return {
      apto_recapagem: false,
      candidato_programacao: false,
      envio_automatico: false,
      encaminhamento: null,
      motivo,
      bloqueios,
    };
  }

  const candidato = bloqueios.length === 0 && statusPneu === 'montado';
  return {
    apto_recapagem: false,
    candidato_programacao: candidato,
    envio_automatico: false,
    encaminhamento: candidato ? 'programar_avaliacao_envio' : 'avaliacao_tecnica',
    motivo: candidato
      ? 'Na faixa de programar recapagem, sem bloqueio técnico registrado. O envio não é automático e segue conferência humana.'
      : 'Na faixa de programar recapagem, mas há bloqueio técnico. Não enviar.',
    bloqueios,
  };
}

function ordenarMedicoes(medicoes) {
  return [...(medicoes || [])].sort((a, b) => {
    const da = dataIso(a.data_medicao || a.data) || '';
    const db = dataIso(b.data_medicao || b.data) || '';
    if (da !== db) return da.localeCompare(db);
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

export function ultimaMedicao(medicoes) {
  const lista = ordenarMedicoes(medicoes);
  return lista.length ? lista[lista.length - 1] : null;
}

export function serieEvolucao(medicoes) {
  const lista = ordenarMedicoes(medicoes);
  const omitidas = Math.max(0, lista.length - MAX_PONTOS_EVOLUCAO);
  const visiveis = lista.slice(-MAX_PONTOS_EVOLUCAO);
  return {
    pontos: visiveis.map((m) => ({
      data: dataIso(m.data_medicao || m.data),
      externo: sulcoValido(m.sulco_externo),
      central: sulcoValido(m.sulco_central),
      interno: sulcoValido(m.sulco_interno),
      menor: menorSulcoBanda(m),
      km: num(m.km_veiculo),
      horas: num(m.hr_veiculo),
    })),
    total: lista.length,
    omitidas,
  };
}

function chaveCicloNumero(chave) {
  if (chave == null || chave === 'sem') return null;
  const n = Number(chave);
  return Number.isFinite(n) ? n : null;
}

export function escolherCicloAtual(separacao, vidaRecap = 0) {
  const chaves = [...(separacao?.medicoesPorCiclo?.keys?.() || [])];
  const numeros = chaves
    .map(chaveCicloNumero)
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  const vida = num(vidaRecap) || 0;
  if (!separacao?.delimitado) {
    if (vida > 0) {
      return {
        chave: null,
        confiavel: false,
        motivo: 'Vida de recapagem informada sem eventos ou campo de ciclo que separem as medições. O consumo não foi calculado para não misturar ciclos.',
      };
    }
    return { chave: 'sem', confiavel: true, motivo: null, numero: 0 };
  }
  if (numeros.length) {
    const numero = numeros[numeros.length - 1];
    return { chave: String(numero), confiavel: true, motivo: null, numero };
  }
  if (vida > 0) {
    return {
      chave: null,
      confiavel: false,
      motivo: 'Não foi possível apontar o ciclo atual. O consumo não foi calculado.',
    };
  }
  return { chave: 'sem', confiavel: true, motivo: null, numero: 0 };
}

export function labelCicloNumero(numero) {
  if (numero == null) return 'Ciclo não separado';
  if (numero <= 0) return 'Original';
  return `R${numero}`;
}

/** Iguala grafias da mesma medida só na conta. O valor gravado permanece. */
export function normalizarMedida(medida) {
  let t = String(medida || '').trim().replace(/\s+/g, '').replace(/,/g, '.').toLowerCase();
  if (!t) return null;
  // 275/80/22.5 é a mesma medida métrica que 275/80R22.5: a barra ocupa o lugar do R.
  t = t.replace(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/, '$1/$2r$3');
  // 12-16-5 é o aro 16.5 escrito com hífen no lugar do ponto. Não mexe em 22 contra 22.5.
  t = t.replace(/^(\d+)-(\d+)-(\d)$/, '$1-$2.$3');
  return t;
}

export function aplicarComparacao(pneus) {
  const grupos = new Map();
  for (const pneu of pneus) {
    pneu.comparacao = {
      aplicavel: false,
      acima: false,
      media: null,
      amostras: 0,
      motivo: 'Sem taxa confiável no ciclo atual para comparar.',
    };
    if (pneu.status_pneu !== 'montado') {
      pneu.comparacao.motivo = 'Comparação só entre pneus montados.';
      continue;
    }
    if (!pneu.consumo?.confiavel) continue;
    if (!normalizarMedida(pneu.medida)) {
      pneu.comparacao.motivo = 'Medida do pneu ausente. Não entra em grupo comparável.';
      continue;
    }
    const valor = pneu.consumo.unidade === 'horas'
      ? pneu.consumo.mm_por_100_h
      : pneu.consumo.mm_por_1000_km;
    if (valor == null) continue;
    const chave = [
      pneu.consumo.unidade,
      pneu.tipo_codigo || pneu.tipo || 'sem-tipo',
      normalizarMedida(pneu.medida),
      pneu.papel || 'sem-posicao',
      (pneu.ciclo_atual > 0 || (num(pneu.vida_recap) || 0) > 0) ? 'recap' : 'original',
    ].join('|');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push({ pneu, valor });
  }

  let gruposInsuficientes = 0;
  let acima = 0;
  for (const lista of grupos.values()) {
    if (lista.length < MIN_AMOSTRA_GRUPO) {
      gruposInsuficientes += 1;
      for (const item of lista) {
        item.pneu.comparacao = {
          aplicavel: false,
          acima: false,
          media: null,
          amostras: lista.length,
          motivo: `Amostra do grupo comparável menor que ${MIN_AMOSTRA_GRUPO} pneus.`,
        };
      }
      continue;
    }
    const media = lista.reduce((s, item) => s + item.valor, 0) / lista.length;
    for (const item of lista) {
      const acimaMedia = item.valor > media * FOLGA_MEDIA && (item.valor - media) >= 0.05;
      if (acimaMedia) acima += 1;
      item.pneu.comparacao = {
        aplicavel: true,
        acima: acimaMedia,
        media: round2(media),
        valor: round2(item.valor),
        amostras: lista.length,
        unidade: item.pneu.consumo.unidade === 'horas' ? 'mm/100 h' : 'mm/1.000 km',
        motivo: acimaMedia
          ? 'Consumo acima da média do grupo comparável. É um sinal relativo, não a causa do desgaste.'
          : null,
      };
    }
  }
  return { grupos: grupos.size, grupos_insuficientes: gruposInsuficientes, acima_da_media: acima };
}

export function necessidadeCompra(pneu) {
  if (pneu.status_pneu !== 'montado') return false;
  if (pneu.papel === 'direcional' && (pneu.faixa === 'critico' || pneu.faixa === 'programar_recapagem')) {
    return true;
  }
  if (pneu.faixa === 'critico_equipamento') return true;
  return false;
}

export function montarPrevisaoFilial(pneus) {
  const porMedida = new Map();
  function bucket(filialId, medida) {
    const canonica = normalizarMedida(medida);
    const chave = `${filialId}|${canonica || 'sem-medida'}`;
    if (!porMedida.has(chave)) {
      porMedida.set(chave, {
        filial_id: filialId,
        medida: canonica,
        medida_informada: Boolean(canonica),
        estoque_novo: 0,
        estoque_recapado: 0,
        em_recapagem: 0,
        necessidade_pneu_novo: 0,
        candidatos_recap: 0,
        avaliacao_urgente: 0,
        previsao_novo_90d: 0,
        previsao_recap_90d: 0,
      });
    }
    return porMedida.get(chave);
  }

  for (const pneu of pneus) {
    const linha = bucket(pneu.filial_id, pneu.medida);
    if (pneu.status_pneu === 'estoque' && pneu.condicao === 'novo') linha.estoque_novo += 1;
    if (pneu.status_pneu === 'estoque' && pneu.condicao !== 'novo') linha.estoque_recapado += 1;
    if (pneu.status_pneu === 'recapagem') linha.em_recapagem += 1;
    if (necessidadeCompra(pneu)) linha.necessidade_pneu_novo += 1;
    if (pneu.elegibilidade?.candidato_programacao) linha.candidatos_recap += 1;
    if (pneu.elegibilidade?.encaminhamento === 'retirada_avaliacao_urgente') linha.avaliacao_urgente += 1;

    const jaNaFaixa = pneu.faixa === 'critico' || pneu.faixa === 'programar_recapagem' || pneu.faixa === 'critico_equipamento';
    if (jaNaFaixa || pneu.status_pneu !== 'montado') continue;
    const data5 = pneu.consumo?.projecao?.alvo_5?.data;
    if (!data5 || pneu.consumo.projecao.alvo_5.ja_atingido) continue;
    const dias = diasEntre(new Date().toISOString().slice(0, 10), data5);
    if (dias == null || dias < 0 || dias > 90) continue;
    if (pneu.papel === 'direcional' || !pneu.regua_recap) linha.previsao_novo_90d += 1;
    else if (pneu.papel === 'tracao' && pneu.elegibilidade?.bloqueios?.length === 0) linha.previsao_recap_90d += 1;
  }

  return [...porMedida.values()]
    .map((linha) => {
      const saldo = linha.medida_informada ? linha.estoque_novo - linha.necessidade_pneu_novo : null;
      return {
        ...linha,
        saldo_novo: saldo,
        comprar_novo: saldo != null && saldo < 0 ? Math.abs(saldo) : 0,
        observacao: linha.medida_informada
          ? 'Saldo usa só pneu novo da mesma medida, já igualando vírgula e ponto. Recapado em estoque não cobre dianteira.'
          : 'Medida ausente: contagens separadas, sem saldo de compra. A recomendação não é definitiva.',
      };
    })
    .filter((linha) => (
      linha.estoque_novo
      || linha.estoque_recapado
      || linha.em_recapagem
      || linha.necessidade_pneu_novo
      || linha.candidatos_recap
      || linha.avaliacao_urgente
      || linha.previsao_novo_90d
      || linha.previsao_recap_90d
    ))
    .sort((a, b) => (a.filial_id - b.filial_id) || String(a.medida || '').localeCompare(String(b.medida || ''), 'pt-BR'));
}

export function montarAnalisePneu(pneu, contexto = {}) {
  const medicoes = contexto.medicoes || [];
  const perfil = contexto.perfil || 'caminhao';
  const unidade = contexto.unidade === 'horas' ? 'horas' : 'km';
  const permiteRecap = contexto.permiteRecap === true && perfil === 'caminhao';
  const reguaRecap = permiteRecap;
  const papel = contexto.papel || null;
  const separacao = contexto.separacao || { medicoesPorCiclo: new Map(), delimitado: false };
  const ciclo = escolherCicloAtual(separacao, pneu.vida_recap || 0);
  const ultima = ultimaMedicao(medicoes);
  const faixa = reguaRecap
    ? faixaRecapagemCaminhao(menorSulcoBanda(ultima))
    : faixaDoEquipamento(menorSulcoBanda(ultima), perfil, contexto.limites || {});
  const desgaste = classificarDesgasteBanda(ultima || {}, {
    tolerancia: num(contexto.tolerancia) ?? 1,
  });
  const elegibilidade = avaliarElegibilidadeRecap({
    faixa,
    reguaRecap,
    papel,
    vidaRecap: pneu.vida_recap || 0,
    maxRecaps: contexto.maxRecaps ?? 6,
    danos: contexto.danos || [],
    statusPneu: pneu.status_pneu || 'montado',
    cicloConfiavel: ciclo.confiavel,
    inspecaoLegivel: contexto.inspecaoLegivel !== false,
  });

  let medicoesCiclo = [];
  if (ciclo.confiavel && ciclo.chave && separacao.medicoesPorCiclo?.get) {
    medicoesCiclo = separacao.medicoesPorCiclo.get(ciclo.chave) || [];
  }
  const consumo = ciclo.confiavel
    ? calcularConsumoEProjecao(medicoesCiclo, { unidade, reguaRecap })
    : consumoVazio(unidade, ciclo.motivo);

  const evolucao = [];
  if (separacao.medicoesPorCiclo?.entries) {
    for (const [chave, grupo] of separacao.medicoesPorCiclo.entries()) {
      const numero = chaveCicloNumero(chave);
      const serie = serieEvolucao(grupo);
      const consumoCiclo = calcularConsumoEProjecao(grupo, { unidade, reguaRecap: false });
      const cicloLabel = chave === 'sem'
        ? (separacao.delimitado ? 'Sem ciclo informado' : 'Original')
        : labelCicloNumero(numero);
      evolucao.push({
        ciclo: numero,
        ciclo_label: cicloLabel,
        atual: ciclo.confiavel && chave === ciclo.chave,
        medicoes: serie.pontos,
        medicoes_total: serie.total,
        medicoes_omitidas: serie.omitidas,
        mm_por_1000_km: consumoCiclo.mm_por_1000_km,
        mm_por_100_h: consumoCiclo.mm_por_100_h,
        consumo_motivo: consumoCiclo.motivo,
      });
    }
    evolucao.sort((a, b) => (a.ciclo ?? 99) - (b.ciclo ?? 99));
  }
  if (!ciclo.confiavel) {
    evolucao.length = 0;
  }

  return {
    ...pneu,
    perfil,
    unidade,
    regua_recap: reguaRecap,
    papel,
    sulcos: sulcosBanda(ultima),
    menor_sulco: menorSulcoBanda(ultima),
    data_medicao: dataIso(ultima?.data_medicao || ultima?.data),
    faixa,
    faixa_label: FAIXAS[faixa] || faixa,
    desgaste,
    elegibilidade,
    consumo,
    ciclo_atual: ciclo.numero ?? null,
    ciclo_label: ciclo.confiavel ? labelCicloNumero(ciclo.numero ?? 0) : 'Ciclo não separado',
    ciclo_confiavel: ciclo.confiavel,
    ciclo_motivo: ciclo.motivo,
    evolucao,
  };
}

export function resumirFaixas(pneus) {
  const acc = {};
  for (const codigo of Object.keys(FAIXAS)) acc[codigo] = 0;
  for (const pneu of pneus) {
    if (pneu.status_pneu !== 'montado') continue;
    if (acc[pneu.faixa] == null) acc[pneu.faixa] = 0;
    acc[pneu.faixa] += 1;
  }
  return acc;
}
