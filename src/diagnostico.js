/**
 * Diagnóstico automático do perfil de desgaste (4 pontos Esq → Dir)
 * e sugestão de ação (OK / RODÍZIO / RECAP / TROCA).
 */

import { labelPosicao, perfilMedicaoVeiculo, posicaoEspelhada, ladoPosicao } from './pneus-layouts.js';
import { getLimites } from './limites.js';

export const DIAGNOSTICOS = {
  ok: {
    codigo: 'ok',
    label: 'OK',
    descricao: 'Desgaste uniforme — perfil sem irregularidade',
  },
  critico: {
    codigo: 'critico',
    label: 'Crítico',
    descricao: 'Sulco no limite crítico — retirar e trocar',
  },
  alinhamento: {
    codigo: 'alinhamento',
    label: 'Alinhamento + Balanceamento',
    descricao: 'Reservado — será implementado no futuro',
  },
  alinhamento_traseiro: {
    codigo: 'alinhamento_traseiro',
    label: 'Alinhamento (sem balanceamento)',
    descricao: 'Reservado — será implementado no futuro',
  },
  desgaste_progressivo: {
    codigo: 'desgaste_progressivo',
    label: 'Desgaste progressivo Ext→Int',
    descricao: 'Parte interna sofre mais desgaste que a externa — consumo esperado enquanto o sulco estiver acima do crítico. Acompanhar; não indica rodízio.',
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
  substituir: { codigo: 'substituir', label: 'Programar substituição', prioridade: 4 },
  verificar_desgaste: { codigo: 'verificar_desgaste', label: 'Verificar desgaste', prioridade: 2 },
  reinspecionar: { codigo: 'reinspecionar', label: 'Reinspecionar', prioridade: 1 },
  corte: { codigo: 'corte', label: 'Corte', prioridade: 3 },
  dano_lateral: { codigo: 'dano_lateral', label: 'Dano lateral', prioridade: 3 },
  desgaste_irregular: { codigo: 'desgaste_irregular', label: 'Desgaste irregular', prioridade: 2 },
  avaliar: { codigo: 'avaliar', label: 'Inspecionar e avaliar', prioridade: 2 },
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
 * Consumo progressivo esperado: ombro externo mais gasto que o interno
 * (sulco_externo < sulco_interno).
 * - Lado esquerdo: desgaste da esquerda → direita
 * - Lado direito: desgaste da direita → esquerda
 * Em ambos, o ombro externo (fora do veículo) gasta primeiro.
 */
export function desgasteProgressivoEsperado(row, toleranciaMm = 1.0) {
  const ext = row?.sulco_externo;
  const int = row?.sulco_interno;
  if (ext == null || int == null || !Number.isFinite(ext) || !Number.isFinite(int)) return false;
  return (int - ext) >= toleranciaMm;
}

/** @deprecated use desgasteProgressivoEsperado — mantido por compatibilidade */
export function internoMaisGastoQueExterno(row, toleranciaMm = 1.0) {
  return desgasteProgressivoEsperado(row, toleranciaMm);
}

function textoDirecaoConsumo(posicao) {
  const lado = ladoPosicao(posicao);
  if (lado === 'direito') return 'lado direito: da direita para a esquerda (externo → interno)';
  if (lado === 'esquerdo') return 'lado esquerdo: da esquerda para a direita (externo → interno)';
  return 'ombro externo → interno';
}

function montarSugestaoEspelho({ posicaoAtual, espelho, ocupante, pontosAtual }) {
  const origemLabel = labelPosicao(posicaoAtual) || posicaoAtual;
  const destLabel = labelPosicao(espelho) || espelho;
  const desvio = desvioEntrePontos(pontosAtual);

  if (ocupante) {
    const fogo = ocupante.numero_fogo ? `Fogo ${ocupante.numero_fogo}` : `Pneu #${ocupante.id}`;
    return {
      pneu_id: ocupante.id,
      posicao: ocupante.posicao || espelho,
      posicao_label: destLabel,
      posicao_origem: posicaoAtual,
      posicao_destino: espelho,
      slot_vazio: false,
      numero_fogo: ocupante.numero_fogo || null,
      media_sulco: mediaSulco({
        sulco_externo: ocupante.sulco_externo ?? ocupante.ult_sulco_ext ?? null,
        sulco_central: ocupante.sulco_central ?? ocupante.ult_sulco_cent ?? null,
        sulco_interno: ocupante.sulco_interno ?? ocupante.ult_sulco_int ?? null,
        sulco_auxiliar: ocupante.sulco_auxiliar ?? ocupante.ult_sulco_aux ?? null,
      }),
      menor_sulco: menorSulco4({
        sulco_externo: ocupante.sulco_externo ?? ocupante.ult_sulco_ext ?? null,
        sulco_central: ocupante.sulco_central ?? ocupante.ult_sulco_cent ?? null,
        sulco_interno: ocupante.sulco_interno ?? ocupante.ult_sulco_int ?? null,
        sulco_auxiliar: ocupante.sulco_auxiliar ?? ocupante.ult_sulco_aux ?? null,
      }),
      desvio_mm: desvio,
      label: `${fogo} (${destLabel})`,
      motivo: `Troque de posição com ${fogo} em ${destLabel} (lado oposto do eixo).`,
    };
  }

  return {
    pneu_id: null,
    posicao: espelho,
    posicao_label: destLabel,
    posicao_origem: posicaoAtual,
    posicao_destino: espelho,
    slot_vazio: true,
    numero_fogo: null,
    media_sulco: null,
    menor_sulco: null,
    desvio_mm: desvio,
    label: `${destLabel} (vazio)`,
    motivo: `Mova este pneu de ${origemLabel} para ${destLabel} (posição vazia no lado oposto).`,
  };
}

/**
 * Encontra outro pneu montado com sulco parecido (média próxima)
 * e, de preferência, perfil complementar (espelhado) para equalizar o desgaste.
 * Prioriza o lado oposto no mesmo eixo (1E↔1D) quando a posição atual é informada.
 */
export function encontrarParRodizio(pontosAtual, candidatos = [], limites = {}, opcoes = {}) {
  const posicaoAtual = opcoes.posicaoAtual || null;
  const espelho = posicaoAtual ? posicaoEspelhada(posicaoAtual) : null;

  // Sempre prioriza o lado oposto do mesmo eixo (ocupado ou vazio)
  if (espelho) {
    const ocupante = candidatos.find((c) => c.posicao === espelho) || null;
    return montarSugestaoEspelho({
      posicaoAtual,
      espelho,
      ocupante,
      pontosAtual,
    });
  }

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

  if (!comMedicao.length) {
    return null;
  }

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
    posicao_origem: posicaoAtual,
    posicao_destino: melhor.posicao || null,
    slot_vazio: false,
    numero_fogo: melhor.numero_fogo || null,
    media_sulco: melhor._media,
    menor_sulco: melhor._menor,
    desvio_mm: melhor._desvio,
    label: `${fogo} (${posLabel})`,
    motivo: `Mude de posição com ${fogo} em ${posLabel} (média ~${melhor._media} mm) para equalizar o desgaste.`,
  };
}

function perfilInformado(row, opcoes = {}) {
  if (opcoes.limites?.perfil) return opcoes.limites.perfil;
  const tipo = opcoes.tipo || row?.tipo || row?.veiculo_tipo || null;
  const layout = opcoes.layout || row?.layout_pneus || null;
  if (!tipo && !layout) return null;
  return perfilMedicaoVeiculo(tipo, layout);
}

function limiarCritico(opcoes = {}) {
  if (opcoes.limites?.perfil === 'industrial') {
    const bruto = opcoes.limites.sulco_critico_mm;
    if (bruto == null || bruto === '') return null;
    const n = Number(bruto);
    return Number.isFinite(n) ? n : null;
  }
  const n = opcoes.limites?.sulco_critico_mm;
  if (Number.isFinite(n)) return n;
  const fallback = getLimites()?.sulco_critico_mm;
  return Number.isFinite(fallback) ? fallback : null;
}

/**
 * Sulco ≤ crítico prevalece sobre "OK" do perfil: 3 mm no limite não é diagnóstico OK.
 */
function aplicarCriticoAoDiagnostico(perfil, menorMm, opcoes = {}) {
  const critico = limiarCritico(opcoes);
  if (menorMm == null || critico == null || menorMm > critico) return perfil;

  if (perfil.codigo === 'ok' || perfil.codigo === 'sem_dado') {
    return {
      ...DIAGNOSTICOS.critico,
      descricao: perfil.codigo === 'ok'
        ? `Menor sulco ${menorMm} mm (limite crítico ${critico} mm). Desgaste uniforme — retirar e trocar.`
        : `Menor sulco ${menorMm} mm (limite crítico ${critico} mm) — retirar e trocar.`,
    };
  }

  return {
    ...perfil,
    descricao: `${perfil.descricao} Sulco crítico (${menorMm} mm ≤ ${critico} mm) — retirar e trocar.`,
  };
}

/**
 * Classifica o padrão de desgaste com base nos pontos disponíveis.
 * Consumo esperado: externo mais gasto que interno (conforme o lado do caminhão).
 * Se o menor sulco estiver no limite crítico, o diagnóstico não pode ser OK.
 * @param {object} row
 * @param {number} toleranciaMm
 * @param {{ papel?: string|null, posicao?: string|null, limites?: object }} [opcoes]
 */
export function diagnosticarPerfil(row, toleranciaMm = 1.0, opcoes = {}) {
  if (perfilInformado(row, opcoes) === 'industrial') {
    return { codigo: null, label: null, descricao: '' };
  }
  const pontos = valoresValidos(row);
  const menor = menorSulco4(row);
  let perfil;

  if (pontos.length < 3) {
    perfil = DIAGNOSTICOS.sem_dado;
  } else {
    const max = Math.max(...pontos);
    const min = Math.min(...pontos);
    const delta = max - min;

    if (delta <= toleranciaMm) {
      perfil = DIAGNOSTICOS.ok;
    } else {
      const ext = row.sulco_externo;
      const int = row.sulco_interno;
      const cent = row.sulco_central;
      const posicao = opcoes.posicao || null;
      const direcao = textoDirecaoConsumo(posicao);

      // Ombros Ext ↔ Int
      if (ext != null && int != null && Number.isFinite(ext) && Number.isFinite(int)
        && Math.abs(ext - int) >= toleranciaMm) {
        // Externo mais gasto = consumo progressivo esperado (esq→dir ou dir→esq conforme o lado)
        if (desgasteProgressivoEsperado(row, toleranciaMm)) {
          const dif = Math.round((int - ext) * 10) / 10;
          perfil = {
            ...DIAGNOSTICOS.desgaste_progressivo,
            descricao: `Externo mais gasto que o interno (diferença ${dif} mm). Consumo esperado — ${direcao}. Acompanhar enquanto sulco estiver acima do crítico; não indica rodízio.`,
          };
        } else {
          // Interno mais gasto que o externo — fora do padrão de consumo do lado
          perfil = {
            ...DIAGNOSTICOS.irregular,
            descricao: `Interno mais gasto que o externo — fora do padrão esperado (${direcao}). Acompanhar nas próximas medições.`,
          };
        }
      } else if (cent != null && Number.isFinite(cent) && ext != null && int != null
        && Number.isFinite(ext) && Number.isFinite(int)) {
        const mediaBordas = (ext + int) / 2;
        if (mediaBordas - cent >= toleranciaMm) {
          perfil = DIAGNOSTICOS.falta_calib;
        } else if (cent - mediaBordas >= toleranciaMm) {
          perfil = DIAGNOSTICOS.excesso_calib;
        }
      }

      if (!perfil) {
        const seq = pontosSulco(row).filter((v) => v != null && Number.isFinite(v));
        const primeiro = seq[0];
        const ultimo = seq[seq.length - 1];
        const meio = seq.slice(1, -1);
        const mediaMeio = meio.length ? meio.reduce((a, b) => a + b, 0) / meio.length : null;

        if (Math.abs(primeiro - ultimo) >= toleranciaMm) {
          perfil = DIAGNOSTICOS.irregular;
        } else if (mediaMeio != null) {
          const mediaBordas = (primeiro + ultimo) / 2;
          if (mediaBordas - mediaMeio >= toleranciaMm) {
            perfil = DIAGNOSTICOS.falta_calib;
          } else if (mediaMeio - mediaBordas >= toleranciaMm) {
            perfil = DIAGNOSTICOS.excesso_calib;
          } else {
            perfil = DIAGNOSTICOS.irregular;
          }
        } else {
          perfil = DIAGNOSTICOS.irregular;
        }
      }
    }
  }

  return aplicarCriticoAoDiagnostico(perfil, menor, opcoes);
}

/**
 * Faixas: ≤ crítico → trocar · até alerta → monitorar · > alerta → OK.
 * Desvio > limiar:
 *   - cunha Ext→Int (externo mais gasto) + sulco acima do crítico → NÃO rodízio (consumo esperado)
 *   - demais perfis irregulares → rodízio (lado oposto preferencial)
 *
 * @param {number|null} menorMm
 * @param {object} limites
 * @param {number} vidaRecap
 * @param {{ pontos?: object|null, candidatos?: object[], posicaoAtual?: string|null }} [opcoes]
 */
export function sugerirAcao(menorMm, limites, vidaRecap = 0, opcoes = {}) {
  if (limites?.perfil === 'industrial' && (limites.sulco_critico_mm == null || limites.sulco_critico_mm === '' || !Number.isFinite(Number(limites.sulco_critico_mm)))) {
    return {
      codigo: null,
      label: null,
      motivo: null,
      rodizio_sugestao: null,
      desvio_mm: null,
    };
  }
  const { pontos = null, candidatos = [], posicaoAtual = null } = opcoes;
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
    return { ...acao, motivo: 'Sem medição', rodizio_sugestao: null, desvio_mm: null };
  }

  const critico = limites.sulco_critico_mm;
  const monitorarAte = limites.sulco_alerta_mm;
  const maxRecap = limites.max_recaps ?? 6;
  const prazoRecap = limites.prazo_recap_dias ?? 15;
  const rodizioDesvio = limites.rodizio_desvio_mm ?? 4;
  const tolerancia = limites.diagnostico_tolerancia_mm ?? 1.0;

  if (menorMm <= critico) {
    const acao = comCustom(ACOES.troca, 'troca');
    return {
      ...acao,
      motivo: acao.instrucao
        || `Crítico — retirar e trocar (sulco ${menorMm} mm ≤ ${critico} mm)`,
      rodizio_sugestao: null,
      desvio_mm: pontos ? desvioEntrePontos(pontos) : null,
    };
  }

  const desvio = pontos ? desvioEntrePontos(pontos) : null;
  const consumoEsperado = pontos
    ? desgasteProgressivoEsperado(pontos, tolerancia)
    : false;
  const desvioAlto = desvio != null && desvio > rodizioDesvio;

  // Consumo Ext→Int esperado (conforme lado) + sulco acima do crítico → sem rodízio
  if (desvioAlto && consumoEsperado) {
    const pts = valoresValidos(pontos).join(' · ');
    const direcao = textoDirecaoConsumo(posicaoAtual);
    if (menorMm <= monitorarAte) {
      if (vidaRecap >= maxRecap) {
        const acao = comCustom(ACOES.troca, 'troca');
        return {
          ...acao,
          motivo: `Limite de recaps atingido (${vidaRecap}/${maxRecap}) — trocar`,
          rodizio_sugestao: null,
          desvio_mm: desvio,
        };
      }
      const acao = comCustom(ACOES.monitorar, 'monitorar');
      return {
        ...acao,
        motivo: `Desgaste progressivo Ext→Int (${direcao}; desvio ${desvio} mm) — consumo esperado enquanto ≥ ${critico} mm. Acompanhar. Medições: ${pts} mm.`,
        prazo_recap_dias: prazoRecap,
        rodizio_sugestao: null,
        desvio_mm: desvio,
      };
    }
    const acao = comCustom(ACOES.ok, 'ok');
    return {
      ...acao,
      motivo: `Desgaste progressivo Ext→Int (${direcao}; desvio ${desvio} mm) — consumo esperado. Sem rodízio. Medições: ${pts} mm.`,
      rodizio_sugestao: null,
      desvio_mm: desvio,
    };
  }

  // Outros perfis com desvio alto → rodízio
  if (desvioAlto) {
    const acao = comCustom(ACOES.rodizio, 'rodizio');
    const par = encontrarParRodizio(pontos, candidatos, limites, { posicaoAtual });
    const pts = valoresValidos(pontos).join(' · ');
    const baseInstrucao = acao.instrucao
      || 'Rodízio para o lado oposto do eixo para equalizar o desgaste.';
    const motivo = par
      ? `${baseInstrucao} Medições: ${pts} mm (desvio ${desvio} mm > ${rodizioDesvio} mm). ${par.motivo}`
      : `${baseInstrucao} Medições: ${pts} mm (desvio ${desvio} mm > ${rodizioDesvio} mm).`;
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
        desvio_mm: desvio,
      };
    }
    const acao = comCustom(ACOES.monitorar, 'monitorar');
    return {
      ...acao,
      motivo: acao.instrucao
        || `Programar substituição (sulco ${menorMm} mm). Iniciar processo de recap em até ${prazoRecap} dias`,
      prazo_recap_dias: prazoRecap,
      rodizio_sugestao: null,
      desvio_mm: desvio,
    };
  }

  const acao = comCustom(ACOES.ok, 'ok');
  return {
    ...acao,
    motivo: acao.instrucao
      || `OK (sulco ${menorMm} mm > ${monitorarAte} mm)`,
    rodizio_sugestao: null,
    desvio_mm: desvio,
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

/** Mesma taxa do KM, com a diferença de horímetro no denominador. */
export function desgastePorHora(sulcoAnterior, sulcoAtual, hrAnterior, hrAtual) {
  return desgastePorKm(sulcoAnterior, sulcoAtual, hrAnterior, hrAtual);
}

/**
 * Percentual de vida útil restante com base no sulco inicial e crítico.
 */
export function percentualVida(sulcoAtual, sulcoInicial, sulcoCritico) {
  if (sulcoAtual == null || sulcoInicial == null || !Number.isFinite(Number(sulcoCritico))) return null;
  const util = sulcoInicial - sulcoCritico;
  if (util <= 0) return null;
  const restante = sulcoAtual - sulcoCritico;
  return Math.max(0, Math.min(100, Math.round((restante / util) * 100)));
}
