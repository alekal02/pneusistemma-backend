import { getDb } from './database.js';
import { config } from './config.js';
import { perfilMedicaoVeiculo } from './pneus-layouts.js';

const CHAVES = {
  CRITICO: 'sulco_critico_mm',
  ALERTA: 'sulco_alerta_mm',
  RECAP: 'sulco_recap_mm',
  NOVO: 'sulco_novo_mm',
  MAX_RECAPS: 'max_recaps',
  PRAZO_RECAP_DIAS: 'prazo_recap_dias',
  TOLERANCIA: 'diagnostico_tolerancia_mm',
  RODIZIO_DESVIO: 'rodizio_desvio_mm',
  RODIZIO_SIMILARIDADE: 'rodizio_similaridade_mm',
  ACAO_TROCA_LABEL: 'acao_troca_label',
  ACAO_TROCA_INSTRUCAO: 'acao_troca_instrucao',
  ACAO_RECAP_LABEL: 'acao_recap_label',
  ACAO_RECAP_INSTRUCAO: 'acao_recap_instrucao',
  ACAO_MONITORAR_LABEL: 'acao_monitorar_label',
  ACAO_MONITORAR_INSTRUCAO: 'acao_monitorar_instrucao',
  ACAO_RODIZIO_LABEL: 'acao_rodizio_label',
  ACAO_RODIZIO_INSTRUCAO: 'acao_rodizio_instrucao',
  ACAO_OK_LABEL: 'acao_ok_label',
  ACAO_OK_INSTRUCAO: 'acao_ok_instrucao',
  TRATOR_CRITICO: 'trator_sulco_critico_mm',
  TRATOR_ALERTA: 'trator_sulco_alerta_mm',
  TRATOR_NOVO: 'trator_sulco_novo_mm',
};

const PADROES = {
  [CHAVES.CRITICO]: config.sulcoMinimo,
  [CHAVES.RECAP]: 3.0,
  [CHAVES.ALERTA]: config.sulcoAlerta,
  [CHAVES.NOVO]: 14.0,
  [CHAVES.MAX_RECAPS]: 6,
  [CHAVES.PRAZO_RECAP_DIAS]: 15,
  [CHAVES.TOLERANCIA]: 1.0,
  [CHAVES.RODIZIO_DESVIO]: 4.0,
  [CHAVES.RODIZIO_SIMILARIDADE]: 2.5,
  [CHAVES.ACAO_TROCA_LABEL]: 'Trocar',
  [CHAVES.ACAO_TROCA_INSTRUCAO]: 'Crítico — retirar e trocar o pneu',
  [CHAVES.ACAO_RECAP_LABEL]: 'Recapagem',
  [CHAVES.ACAO_RECAP_INSTRUCAO]: 'Iniciar processo de recap em até 15 dias',
  [CHAVES.ACAO_MONITORAR_LABEL]: 'Monitorar',
  [CHAVES.ACAO_MONITORAR_INSTRUCAO]: 'Programar substituição — iniciar processo de recap em até 15 dias',
  [CHAVES.ACAO_RODIZIO_LABEL]: 'Mudar posição',
  [CHAVES.ACAO_RODIZIO_INSTRUCAO]: 'Rodízio para o lado oposto do eixo (ex.: 1E → 1D) para equalizar o desgaste',
  [CHAVES.ACAO_OK_LABEL]: 'OK',
  [CHAVES.ACAO_OK_INSTRUCAO]: 'Manter em operação — sulco adequado',
  [CHAVES.TRATOR_CRITICO]: 10,
  [CHAVES.TRATOR_ALERTA]: 15,
  [CHAVES.TRATOR_NOVO]: 25,
};

const CHAVES_TEXTO = new Set([
  CHAVES.ACAO_TROCA_LABEL,
  CHAVES.ACAO_TROCA_INSTRUCAO,
  CHAVES.ACAO_RECAP_LABEL,
  CHAVES.ACAO_RECAP_INSTRUCAO,
  CHAVES.ACAO_MONITORAR_LABEL,
  CHAVES.ACAO_MONITORAR_INSTRUCAO,
  CHAVES.ACAO_RODIZIO_LABEL,
  CHAVES.ACAO_RODIZIO_INSTRUCAO,
  CHAVES.ACAO_OK_LABEL,
  CHAVES.ACAO_OK_INSTRUCAO,
]);

/** Cache em memória — getLimites() permanece síncrono */
let cache = null;

async function lerValorAsync(chave) {
  const db = getDb();
  const row = await db.prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave);
  if (!row) return PADROES[chave];
  if (CHAVES_TEXTO.has(chave)) {
    const txt = String(row.valor ?? '').trim();
    return txt || PADROES[chave];
  }
  const n = parseFloat(row.valor);
  return Number.isFinite(n) ? n : PADROES[chave];
}

async function salvarValor(chave, valor) {
  const db = getDb();
  await db.prepare(`
    INSERT INTO configuracoes (chave, valor, updated_at)
    VALUES (?, ?, NOW())
    ON CONFLICT (chave) DO UPDATE SET
      valor = EXCLUDED.valor,
      updated_at = NOW()
  `).run(chave, String(valor));
}

function textoOuPadrao(valor, padrao, { max = 200 } = {}) {
  if (valor == null) return padrao;
  const t = String(valor).trim();
  if (!t) return padrao;
  return t.slice(0, max);
}

export async function refreshLimitesCache() {
  const keys = Object.values(CHAVES);
  const values = {};
  for (const k of keys) {
    values[k] = await lerValorAsync(k);
  }
  cache = {
    sulco_critico_mm: values[CHAVES.CRITICO],
    sulco_alerta_mm: values[CHAVES.ALERTA],
    sulco_recap_mm: values[CHAVES.RECAP],
    sulco_novo_mm: values[CHAVES.NOVO],
    max_recaps: Math.round(values[CHAVES.MAX_RECAPS]),
    prazo_recap_dias: Math.round(values[CHAVES.PRAZO_RECAP_DIAS]),
    diagnostico_tolerancia_mm: values[CHAVES.TOLERANCIA],
    rodizio_desvio_mm: values[CHAVES.RODIZIO_DESVIO],
    rodizio_similaridade_mm: values[CHAVES.RODIZIO_SIMILARIDADE],
    acoes: {
      troca: {
        label: values[CHAVES.ACAO_TROCA_LABEL],
        instrucao: values[CHAVES.ACAO_TROCA_INSTRUCAO],
      },
      recap: {
        label: values[CHAVES.ACAO_RECAP_LABEL],
        instrucao: values[CHAVES.ACAO_RECAP_INSTRUCAO],
      },
      monitorar: {
        label: values[CHAVES.ACAO_MONITORAR_LABEL],
        instrucao: values[CHAVES.ACAO_MONITORAR_INSTRUCAO],
      },
      rodizio: {
        label: values[CHAVES.ACAO_RODIZIO_LABEL],
        instrucao: values[CHAVES.ACAO_RODIZIO_INSTRUCAO],
      },
      ok: {
        label: values[CHAVES.ACAO_OK_LABEL],
        instrucao: values[CHAVES.ACAO_OK_INSTRUCAO],
      },
    },
    trator: {
      sulco_critico_mm: values[CHAVES.TRATOR_CRITICO],
      sulco_alerta_mm: values[CHAVES.TRATOR_ALERTA],
      sulco_novo_mm: values[CHAVES.TRATOR_NOVO],
    },
  };
  return cache;
}

/** Sync — usa cache (chame refreshLimitesCache no boot) */
export function getLimites() {
  if (!cache) {
    // Fallback com padrões até o cache aquecer
    return {
      sulco_critico_mm: PADROES[CHAVES.CRITICO],
      sulco_alerta_mm: PADROES[CHAVES.ALERTA],
      sulco_recap_mm: PADROES[CHAVES.RECAP],
      sulco_novo_mm: PADROES[CHAVES.NOVO],
      max_recaps: PADROES[CHAVES.MAX_RECAPS],
      prazo_recap_dias: PADROES[CHAVES.PRAZO_RECAP_DIAS],
      diagnostico_tolerancia_mm: PADROES[CHAVES.TOLERANCIA],
      rodizio_desvio_mm: PADROES[CHAVES.RODIZIO_DESVIO],
      rodizio_similaridade_mm: PADROES[CHAVES.RODIZIO_SIMILARIDADE],
      acoes: {
        troca: { label: PADROES[CHAVES.ACAO_TROCA_LABEL], instrucao: PADROES[CHAVES.ACAO_TROCA_INSTRUCAO] },
        recap: { label: PADROES[CHAVES.ACAO_RECAP_LABEL], instrucao: PADROES[CHAVES.ACAO_RECAP_INSTRUCAO] },
        monitorar: { label: PADROES[CHAVES.ACAO_MONITORAR_LABEL], instrucao: PADROES[CHAVES.ACAO_MONITORAR_INSTRUCAO] },
        rodizio: { label: PADROES[CHAVES.ACAO_RODIZIO_LABEL], instrucao: PADROES[CHAVES.ACAO_RODIZIO_INSTRUCAO] },
        ok: { label: PADROES[CHAVES.ACAO_OK_LABEL], instrucao: PADROES[CHAVES.ACAO_OK_INSTRUCAO] },
      },
      trator: {
        sulco_critico_mm: PADROES[CHAVES.TRATOR_CRITICO],
        sulco_alerta_mm: PADROES[CHAVES.TRATOR_ALERTA],
        sulco_novo_mm: PADROES[CHAVES.TRATOR_NOVO],
      },
    };
  }
  return cache;
}

export function getLimitesPorPerfil(perfil = 'caminhao') {
  const base = getLimites();
  if (perfil !== 'trator') {
    return { ...base, perfil: 'caminhao' };
  }
  const t = base.trator || {};
  const critico = t.sulco_critico_mm ?? PADROES[CHAVES.TRATOR_CRITICO];
  return {
    ...base,
    perfil: 'trator',
    sulco_critico_mm: critico,
    sulco_alerta_mm: t.sulco_alerta_mm ?? PADROES[CHAVES.TRATOR_ALERTA],
    sulco_novo_mm: t.sulco_novo_mm ?? PADROES[CHAVES.TRATOR_NOVO],
    sulco_recap_mm: critico,
  };
}

export function limitesDoVeiculo(row = {}, layoutId = null) {
  const tipo = row.tipo || row.tipo_veiculo || row.veiculo_tipo || null;
  const layout = row.layout_pneus || layoutId || null;
  return getLimitesPorPerfil(perfilMedicaoVeiculo(tipo, layout));
}

export async function setLimites(body) {
  const atual = getLimites();
  const critico = body.sulco_critico_mm != null ? parseFloat(body.sulco_critico_mm) : atual.sulco_critico_mm;
  const alerta = body.sulco_alerta_mm != null ? parseFloat(body.sulco_alerta_mm) : atual.sulco_alerta_mm;
  const recap = body.sulco_recap_mm != null ? parseFloat(body.sulco_recap_mm) : critico;
  const novo = body.sulco_novo_mm != null ? parseFloat(body.sulco_novo_mm) : atual.sulco_novo_mm;
  const maxRecaps = body.max_recaps != null ? parseInt(body.max_recaps, 10) : atual.max_recaps;
  const prazoRecap = body.prazo_recap_dias != null
    ? parseInt(body.prazo_recap_dias, 10)
    : atual.prazo_recap_dias;
  const tolerancia = body.diagnostico_tolerancia_mm != null
    ? parseFloat(body.diagnostico_tolerancia_mm)
    : atual.diagnostico_tolerancia_mm;
  const rodizioDesvio = body.rodizio_desvio_mm != null
    ? parseFloat(body.rodizio_desvio_mm)
    : atual.rodizio_desvio_mm;
  const rodizioSimilaridade = body.rodizio_similaridade_mm != null
    ? parseFloat(body.rodizio_similaridade_mm)
    : atual.rodizio_similaridade_mm;

  if (!Number.isFinite(critico) || critico < 0) throw new Error('Limite crítico inválido');
  if (!Number.isFinite(alerta) || alerta <= critico) {
    throw new Error('O limiar de monitorar deve ser maior que o crítico');
  }
  if (!Number.isFinite(novo) || novo <= alerta) {
    throw new Error('O sulco de pneu novo deve ser maior que o limiar de monitorar');
  }
  if (!Number.isFinite(maxRecaps) || maxRecaps < 0 || maxRecaps > 10) {
    throw new Error('Máximo de recaps inválido (0–10)');
  }
  if (!Number.isFinite(prazoRecap) || prazoRecap < 1 || prazoRecap > 90) {
    throw new Error('Prazo de recap inválido (1–90 dias)');
  }
  if (!Number.isFinite(tolerancia) || tolerancia < 0) {
    throw new Error('Tolerância de diagnóstico inválida');
  }
  if (!Number.isFinite(rodizioDesvio) || rodizioDesvio < 0.5 || rodizioDesvio > 20) {
    throw new Error('Desvio para mudança de posição inválido (0,5 a 20 mm)');
  }
  if (!Number.isFinite(rodizioSimilaridade) || rodizioSimilaridade < 0.5 || rodizioSimilaridade > 20) {
    throw new Error('Similaridade de posição inválida (0,5 a 20 mm)');
  }

  const acoesBody = body.acoes && typeof body.acoes === 'object' ? body.acoes : {};
  const trocaLabel = textoOuPadrao(acoesBody.troca?.label ?? body.acao_troca_label, atual.acoes.troca.label, { max: 40 });
  const trocaInstrucao = textoOuPadrao(acoesBody.troca?.instrucao ?? body.acao_troca_instrucao, atual.acoes.troca.instrucao, { max: 240 });
  const recapLabel = textoOuPadrao(acoesBody.recap?.label ?? body.acao_recap_label, atual.acoes.recap.label, { max: 40 });
  const recapInstrucao = textoOuPadrao(acoesBody.recap?.instrucao ?? body.acao_recap_instrucao, atual.acoes.recap.instrucao, { max: 240 });
  const monLabel = textoOuPadrao(acoesBody.monitorar?.label ?? body.acao_monitorar_label, atual.acoes.monitorar.label, { max: 40 });
  const monInstrucao = textoOuPadrao(acoesBody.monitorar?.instrucao ?? body.acao_monitorar_instrucao, atual.acoes.monitorar.instrucao, { max: 240 });
  const rodLabel = textoOuPadrao(acoesBody.rodizio?.label ?? body.acao_rodizio_label, atual.acoes.rodizio.label, { max: 40 });
  const rodInstrucao = textoOuPadrao(acoesBody.rodizio?.instrucao ?? body.acao_rodizio_instrucao, atual.acoes.rodizio.instrucao, { max: 240 });
  const okLabel = textoOuPadrao(acoesBody.ok?.label ?? body.acao_ok_label, atual.acoes.ok.label, { max: 40 });
  const okInstrucao = textoOuPadrao(acoesBody.ok?.instrucao ?? body.acao_ok_instrucao, atual.acoes.ok.instrucao, { max: 240 });

  await salvarValor(CHAVES.CRITICO, critico);
  await salvarValor(CHAVES.ALERTA, alerta);
  await salvarValor(CHAVES.RECAP, Number.isFinite(recap) ? recap : critico);
  await salvarValor(CHAVES.NOVO, novo);
  await salvarValor(CHAVES.MAX_RECAPS, maxRecaps);
  await salvarValor(CHAVES.PRAZO_RECAP_DIAS, prazoRecap);
  await salvarValor(CHAVES.TOLERANCIA, tolerancia);
  await salvarValor(CHAVES.RODIZIO_DESVIO, rodizioDesvio);
  await salvarValor(CHAVES.RODIZIO_SIMILARIDADE, rodizioSimilaridade);
  await salvarValor(CHAVES.ACAO_TROCA_LABEL, trocaLabel);
  await salvarValor(CHAVES.ACAO_TROCA_INSTRUCAO, trocaInstrucao);
  await salvarValor(CHAVES.ACAO_RECAP_LABEL, recapLabel);
  await salvarValor(CHAVES.ACAO_RECAP_INSTRUCAO, recapInstrucao);
  await salvarValor(CHAVES.ACAO_MONITORAR_LABEL, monLabel);
  await salvarValor(CHAVES.ACAO_MONITORAR_INSTRUCAO, monInstrucao);
  await salvarValor(CHAVES.ACAO_RODIZIO_LABEL, rodLabel);
  await salvarValor(CHAVES.ACAO_RODIZIO_INSTRUCAO, rodInstrucao);
  await salvarValor(CHAVES.ACAO_OK_LABEL, okLabel);
  await salvarValor(CHAVES.ACAO_OK_INSTRUCAO, okInstrucao);

  const tratorBody = body.trator && typeof body.trator === 'object' ? body.trator : {};
  const tratorAtual = atual.trator || {};
  const tratorCritico = tratorBody.sulco_critico_mm != null
    ? parseFloat(tratorBody.sulco_critico_mm)
    : (body.trator_sulco_critico_mm != null ? parseFloat(body.trator_sulco_critico_mm) : tratorAtual.sulco_critico_mm);
  const tratorAlerta = tratorBody.sulco_alerta_mm != null
    ? parseFloat(tratorBody.sulco_alerta_mm)
    : (body.trator_sulco_alerta_mm != null ? parseFloat(body.trator_sulco_alerta_mm) : tratorAtual.sulco_alerta_mm);
  const tratorNovo = tratorBody.sulco_novo_mm != null
    ? parseFloat(tratorBody.sulco_novo_mm)
    : (body.trator_sulco_novo_mm != null ? parseFloat(body.trator_sulco_novo_mm) : tratorAtual.sulco_novo_mm);

  if (!Number.isFinite(tratorCritico) || tratorCritico < 0) {
    throw new Error('Limite crítico do trator inválido');
  }
  if (!Number.isFinite(tratorAlerta) || tratorAlerta <= tratorCritico) {
    throw new Error('No trator, o limiar de monitorar deve ser maior que o crítico');
  }
  if (!Number.isFinite(tratorNovo) || tratorNovo <= tratorAlerta) {
    throw new Error('No trator, o sulco de pneu novo deve ser maior que o limiar de monitorar');
  }

  await salvarValor(CHAVES.TRATOR_CRITICO, tratorCritico);
  await salvarValor(CHAVES.TRATOR_ALERTA, tratorAlerta);
  await salvarValor(CHAVES.TRATOR_NOVO, tratorNovo);

  return refreshLimitesCache();
}

/** Sulco no limite crítico conta como crítico (medições de campo vêm em mm inteiros). */
export function atingiuCritico(mm, criticoMm) {
  if (mm == null || !Number.isFinite(mm)) return false;
  const limiar = Number.isFinite(criticoMm) ? criticoMm : getLimites().sulco_critico_mm;
  return mm <= limiar;
}

export function classificarSulco(mm, limites) {
  if (mm === null || mm === undefined) return 'sem_dado';
  const lim = limites && Number.isFinite(Number(limites.sulco_critico_mm))
    ? limites
    : getLimites();
  if (mm <= lim.sulco_critico_mm) return 'critico';
  if (mm <= lim.sulco_alerta_mm) return 'alerta';
  return 'ok';
}

/** Maior limiar de monitorar entre caminhão e trator (filtros SQL de alerta). */
export function alertaSulcoMaxMm() {
  const lim = getLimites();
  const tratorAlerta = Number(lim.trator?.sulco_alerta_mm);
  return Math.max(
    Number(lim.sulco_alerta_mm) || 0,
    Number(lim.sulco_recap_mm) || 0,
    Number.isFinite(tratorAlerta) ? tratorAlerta : 0,
  );
}

export function menorSulco(row) {
  const valores = [
    row.sulco_externo,
    row.sulco_central,
    row.sulco_interno,
    row.sulco_auxiliar,
  ].filter((v) => v != null);
  return valores.length ? Math.min(...valores) : null;
}

export function adicionarDias(dataIso, dias) {
  if (!dataIso) return null;
  const [y, m, d] = String(dataIso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Number(dias || 0));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export { CHAVES, PADROES };
