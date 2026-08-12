/**
 * Diagnóstico automático do perfil de desgaste (4 pontos Esq → Dir)
 * e sugestão de ação (OK / RODÍZIO / RECAP / TROCA).
 */

export const DIAGNOSTICOS = {
  ok: {
    codigo: 'ok',
    label: 'OK',
    descricao: 'Desgaste uniforme — sem indício de problema',
  },
  alinhamento: {
    codigo: 'alinhamento',
    label: 'Alinhamento + Balanceamento',
    descricao: 'Desgaste em cunha (um lado mais gasto) — verificar alinhamento e balanceamento',
  },
  alinhamento_traseiro: {
    codigo: 'alinhamento_traseiro',
    label: 'Alinhamento (sem balanceamento)',
    descricao: 'Desgaste em cunha no eixo traseiro — verificar alinhamento. Não faz balanceamento no eixo traseiro (não compensa)',
  },
  falta_calib: {
    codigo: 'falta_calib',
    label: 'Falta de calibragem',
    descricao: 'Centro mais gasto que as bordas — possível subcalibragem',
  },
  excesso_calib: {
    codigo: 'excesso_calib',
    label: 'Excesso de calibragem',
    descricao: 'Bordas mais gastas que o centro — possível sobrecalibragem',
  },
  irregular: {
    codigo: 'irregular',
    label: 'Desgaste irregular',
    descricao: 'Perfil inconsistente — inspeção visual recomendada',
  },
  sem_dado: {
    codigo: 'sem_dado',
    label: 'Sem dados',
    descricao: 'Pontos insuficientes para diagnóstico',
  },
};

export const ACOES = {
  ok: { codigo: 'ok', label: 'OK', prioridade: 0 },
  monitorar: { codigo: 'monitorar', label: 'Monitorar', prioridade: 1 },
  rodizio: { codigo: 'rodizio', label: 'Mudar posição', prioridade: 2 },
  recap: { codigo: 'recap', label: 'Recapagem', prioridade: 3 },
  troca: { codigo: 'troca', label: 'Trocar', prioridade: 4 },
};

/**
 * @param {{ sulco_externo?: number|null, sulco_central?: number|null, sulco_interno?: number|null, sulco_auxiliar?: number|null }} row
 * @returns {(number|null)[]}
 */
export function pontosSulco(row) {
  return [
    row.sulco_externo ?? null,
    row.sulco_central ?? null,
    row.sulco_interno ?? null,
    row.sulco_auxiliar ?? null,
  ];
}

export function valoresValidos(row) {
  return pontosSulco(row).filter((v) => v != null && Number.isFinite(v));
}

export function menorSulco4(row) {
  const vals = valoresValidos(row);
  return vals.length ? Math.min(...vals) : null;
}

/** Diferença entre o maior e o menor ponto (mm). */
export function desvioEntrePontos(row) {
  const vals = valoresValidos(row);
  if (vals.length < 2) return null;
  return Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10;
}

/** Média dos pontos medidos. */
export function mediaSulco(row) {
  const vals = valoresValidos(row);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

/**
 * Encontra outro pneu montado com sulco parecido (média próxima)
 * e, de preferência, perfil complementar (espelhado) para equalizar o desgaste.
 */
export function encontrarParRodizio(pontosAtual, candidatos = [], limites = {}) {
  const seq = pontosSulco(pontosAtual).map((v) => (v != null && Number.isFinite(v) ? v : null));
  const valsAtual = seq.filter((v) => v != null);
  if (valsAtual.length < 2 || !candidatos.length) return null;

  const mediaAtual = mediaSulco(pontosAtual);
  const similaridade = limites.rodizio_similaridade_mm ?? 2.5;

  const comMedicao = candidatos
    .map((c) => {
      const pontos = {
        sulco_externo: c.sulco_externo ?? c.ult_sulco_ext ?? null,
        sulco_central: c.sulco_central ?? c.ult_sulco_cent ?? null,
        sulco_interno: c.sulco_interno ?? c.ult_sulco_int ?? null,
        sulco_auxiliar: c.sulco_auxiliar ?? c.ult_sulco_aux ?? null,
      };
      const media = mediaSulco(pontos);
      const menor = menorSulco4(pontos);
      const desvio = desvioEntrePontos(pontos);
      if (media == null) return null;
      return { ...c, _pontos: pontos, _media: media, _menor: menor, _desvio: desvio };
    })
    .filter(Boolean);

  if (!comMedicao.length) return null;

  const parecidos = comMedicao
    .filter((c) => Math.abs(c._media - mediaAtual) <= similaridade)
    .sort((a, b) => Math.abs(a._media - mediaAtual) - Math.abs(b._media - mediaAtual));

  const lista = parecidos.length
    ? parecidos
    : [...comMedicao]
      .sort((a, b) => Math.abs(a._media - mediaAtual) - Math.abs(b._media - mediaAtual))
      .slice(0, 3);

  let melhor = null;
  let melhorScore = Infinity;

  for (const c of lista) {
    const seqC = pontosSulco(c._pontos).map((v) => (v != null && Number.isFinite(v) ? v : null));
    const espelhado = [...seqC].reverse();
    let scoreEsp = 0;
    let n = 0;
    for (let i = 0; i < Math.min(seq.length, espelhado.length); i += 1) {
      if (seq[i] == null || espelhado[i] == null) continue;
      scoreEsp += Math.abs(seq[i] - espelhado[i]);
      n += 1;
    }
    const scoreComplementar = n ? scoreEsp / n : 99;
    const scoreMedia = Math.abs(c._media - mediaAtual);
    const score = scoreComplementar * 0.7 + scoreMedia * 0.3;
    if (score < melhorScore) {
      melhorScore = score;
      melhor = c;
    }
  }

  if (!melhor) return null;

  const posLabel = melhor.posicao_label || melhor.posicao || `#${melhor.id}`;
  const fogo = melhor.numero_fogo ? `Fogo ${melhor.numero_fogo}` : `Pneu #${melhor.id}`;
  return {
    pneu_id: melhor.id,
    posicao: melhor.posicao || null,
    posicao_label: posLabel,
    numero_fogo: melhor.numero_fogo || null,
    media_sulco: melhor._media,
    menor_sulco: melhor._menor,
    desvio_mm: melhor._desvio,
    label: `${fogo} (${posLabel})`,
    motivo: `Mude de posição com ${fogo} em ${posLabel} (média ~${melhor._media} mm) para equalizar o desgaste.`,
  };
}

/**
 * Classifica o padrão de desgaste com base nos pontos disponíveis.
 * Com 3 pontos: [ext, cent, int]. Com 4: [ext, cent, int, aux].
 * @param {object} row
 * @param {number} toleranciaMm
 * @param {{ papel?: string|null }} [opcoes] papel da posição: direcional | tracao | estepe
 */
export function diagnosticarPerfil(row, toleranciaMm = 1.0, opcoes = {}) {
  const pontos = valoresValidos(row);
  if (pontos.length < 3) return DIAGNOSTICOS.sem_dado;

  const max = Math.max(...pontos);
  const min = Math.min(...pontos);
  const delta = max - min;

  if (delta <= toleranciaMm) return DIAGNOSTICOS.ok;

  const seq = pontosSulco(row).filter((v) => v != null && Number.isFinite(v));
  const primeiro = seq[0];
  const ultimo = seq[seq.length - 1];
  const meio = seq.slice(1, -1);
  const mediaMeio = meio.length ? meio.reduce((a, b) => a + b, 0) / meio.length : null;

  if (Math.abs(primeiro - ultimo) >= toleranciaMm) {
    // Eixo traseiro: não sugere balanceamento — não compensa
    if (opcoes.papel === 'tracao') return DIAGNOSTICOS.alinhamento_traseiro;
    return DIAGNOSTICOS.alinhamento;
  }

  if (mediaMeio != null) {
    const mediaBordas = (primeiro + ultimo) / 2;
    if (mediaBordas - mediaMeio >= toleranciaMm) {
      return DIAGNOSTICOS.falta_calib;
    }
    if (mediaMeio - mediaBordas >= toleranciaMm) {
      return DIAGNOSTICOS.excesso_calib;
    }
  }

  return DIAGNOSTICOS.irregular;
}

/**
 * Faixas: < crítico → trocar · até alerta → monitorar (programar sub + recap em N dias) · > alerta → OK.
 * Desvio alto entre pontos → sugerir mudança de posição no caminhão.
 *
 * @param {number|null} menorMm
 * @param {object} limites
 * @param {number} vidaRecap
 * @param {{ pontos?: object|null, candidatos?: object[] }} [opcoes]
 */
export function sugerirAcao(menorMm, limites, vidaRecap = 0, opcoes = {}) {
  const { pontos = null, candidatos = [] } = opcoes;
  const custom = limites?.acoes || {};
  const comCustom = (base, chave) => {
    const c = custom[chave];
    return {
      ...base,
      label: c?.label || base.label,
      instrucao: c?.instrucao || null,
    };
  };

  if (menorMm == null) {
    const acao = comCustom(ACOES.ok, 'ok');
    return { ...acao, motivo: 'Sem medição', rodizio_sugestao: null };
  }

  const critico = limites.sulco_critico_mm;
  const monitorarAte = limites.sulco_alerta_mm;
  const maxRecap = limites.max_recaps ?? 6;
  const prazoRecap = limites.prazo_recap_dias ?? 15;
  const rodizioDesvio = limites.rodizio_desvio_mm ?? 3;

  if (menorMm < critico) {
    const acao = comCustom(ACOES.troca, 'troca');
    return {
      ...acao,
      motivo: acao.instrucao
        || `Crítico — trocar (sulco ${menorMm} mm < ${critico} mm)`,
      rodizio_sugestao: null,
    };
  }

  const desvio = pontos ? desvioEntrePontos(pontos) : null;
  const precisaMudarPosicao = desvio != null && desvio >= rodizioDesvio;

  if (precisaMudarPosicao) {
    const acao = comCustom(ACOES.rodizio, 'rodizio');
    const par = encontrarParRodizio(pontos, candidatos, limites);
    const pts = valoresValidos(pontos).join(' · ');
    const baseInstrucao = acao.instrucao
      || 'Mudar de posição no caminhão para equalizar o desgaste.';
    const motivo = par
      ? `${baseInstrucao} Medições: ${pts} mm (desvio ${desvio} mm). ${par.motivo}`
      : `${baseInstrucao} Medições: ${pts} mm (desvio ${desvio} mm).`;
    return {
      ...acao,
      motivo,
      desvio_mm: desvio,
      rodizio_sugestao: par,
    };
  }

  if (menorMm <= monitorarAte) {
    if (vidaRecap >= maxRecap) {
      const acao = comCustom(ACOES.troca, 'troca');
      return {
        ...acao,
        motivo: `Limite de recaps atingido (${vidaRecap}/${maxRecap}) — trocar`,
        rodizio_sugestao: null,
      };
    }
    const acao = comCustom(ACOES.monitorar, 'monitorar');
    return {
      ...acao,
      motivo: acao.instrucao
        || `Programar substituição (sulco ${menorMm} mm). Iniciar processo de recap em até ${prazoRecap} dias`,
      prazo_recap_dias: prazoRecap,
      rodizio_sugestao: null,
    };
  }

  const acao = comCustom(ACOES.ok, 'ok');
  return {
    ...acao,
    motivo: acao.instrucao
      || `OK (sulco ${menorMm} mm > ${monitorarAte} mm)`,
    rodizio_sugestao: null,
  };
}

/**
 * Taxa de desgaste mm/km entre duas medições.
 */
export function desgastePorKm(sulcoAnterior, sulcoAtual, kmAnterior, kmAtual) {
  if (sulcoAnterior == null || sulcoAtual == null) return null;
  if (kmAnterior == null || kmAtual == null) return null;
  const deltaKm = kmAtual - kmAnterior;
  if (deltaKm <= 0) return null;
  const deltaSulco = sulcoAnterior - sulcoAtual;
  if (deltaSulco < 0) return null;
  return Math.round((deltaSulco / deltaKm) * 100000) / 100000;
}

/**
 * Percentual de vida útil restante com base no sulco inicial e crítico.
 */
export function percentualVida(sulcoAtual, sulcoInicial, sulcoCritico) {
  if (sulcoAtual == null || sulcoInicial == null) return null;
  const util = sulcoInicial - sulcoCritico;
  if (util <= 0) return null;
  const restante = sulcoAtual - sulcoCritico;
  return Math.max(0, Math.min(100, Math.round((restante / util) * 100)));
}
