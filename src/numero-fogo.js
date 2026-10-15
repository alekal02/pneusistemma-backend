/**
 * Marca de fogo no padrão {CODIGO_FILIAL}-{sequencia}, ex.: 0110-0001.
 *
 * Unidades sem histórico neste formato começam em 0001.
 * A sequência considera todos os pneus da filial (inclusive inativos/descarte)
 * para não reutilizar um identificador já gravado.
 *
 * Filiais que já usam outro formato (ex.: F-1001) continuam podendo cadastrar
 * nesse formato. Se a unidade está vazia ou 100% no padrão, o formato passa
 * a ser obrigatório.
 */
import { ehViolacaoUnique } from './db-utils.js';

const LARGURA_MIN_SEQ = 4;
const MAX_TENTATIVAS_GERAR = 8;

export function erroHttp(mensagem, status = 400) {
  const err = new Error(mensagem);
  err.status = status;
  return err;
}

export function escapeRegex(texto) {
  return String(texto || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizarCodigoFilial(codigo) {
  const c = String(codigo || '').trim().toUpperCase();
  if (!c) {
    throw erroHttp('Unidade sem código cadastrado — não dá para gerar a marca de fogo', 400);
  }
  return c;
}

export function formatarNumeroFogo(codigo, sequencia, larguraMin = LARGURA_MIN_SEQ) {
  const n = Number(sequencia);
  if (!Number.isInteger(n) || n < 1) {
    throw erroHttp('Sequência da marca de fogo inválida', 400);
  }
  const largura = Math.max(larguraMin, String(n).length);
  return `${codigo}-${String(n).padStart(largura, '0')}`;
}

export function sequenciaDoPadrao(fogo, codigo) {
  const c = String(codigo || '');
  if (!c) return null;
  const m = String(fogo || '').trim().match(
    new RegExp(`^${escapeRegex(c)}-(\\d+)$`, 'i')
  );
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const RE_SO_DIGITOS = /^\d+$/;
const RE_PREFIXO_SEQ = /^(.+)-(\d+)$/;
const RE_PLACEHOLDER_FOGO = /^(s\/?n|sem\s*n(ume?ro)?|sem\s*fogo|n\/?a|-|null|undefined)$/i;

function textoFogo(informado) {
  return String(informado || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** S/N, vazio, "Sem identificação" e similares — não são marca de fogo. */
export function ehPlaceholderFogo(informado) {
  const bruto = String(informado || '').trim();
  if (!bruto) return true;
  if (RE_PLACEHOLDER_FOGO.test(bruto)) return true;
  return /^sem identificacao\s*\d*$/.test(textoFogo(bruto));
}

/**
 * Interpreta o que o usuário digitou.
 * - vazio, S/N ou só o código da unidade → null (gerar automático)
 * - só dígitos, unidade 100% no padrão {CODIGO}-seq → completa (0001 → 0110-0001)
 * - só dígitos, unidade com fogos legados (planilha 1224510, 377) → mantém
 * - 0110-0001 (prefixo desta unidade) → normaliza com padding
 * - qualquer outro texto → legado (F-1001, CLG0748), sem alterar
 */
export function normalizarFogoInformado(informado, codigo, { padrao_obrigatorio = false } = {}) {
  const bruto = String(informado || '').trim();
  if (ehPlaceholderFogo(bruto)) return null;
  const codigoOk = normalizarCodigoFilial(codigo);
  const upper = bruto.toUpperCase();
  if (upper === codigoOk) return null;

  if (RE_SO_DIGITOS.test(bruto)) {
    if (padrao_obrigatorio) {
      return formatarNumeroFogo(codigoOk, Number(bruto));
    }
    return bruto;
  }

  const m = upper.match(RE_PREFIXO_SEQ);
  if (m && m[1] === codigoOk) {
    return formatarNumeroFogo(codigoOk, Number(m[2]));
  }

  return bruto;
}

export async function consultarProximoFogo(db, filialId) {
  const filial = await db.prepare('SELECT id, codigo FROM filiais WHERE id = ?').get(filialId);
  if (!filial) throw erroHttp('Filial não encontrada', 404);
  const codigo = normalizarCodigoFilial(filial.codigo);

  const rows = await db.prepare(`
    SELECT numero_fogo FROM pneus
    WHERE filial_id = ?
      AND numero_fogo IS NOT NULL
      AND TRIM(numero_fogo) != ''
      AND numero_fogo ~* ?
  `).all(filialId, `^${escapeRegex(codigo)}-[0-9]+$`);

  const totalRow = await db.prepare(`
    SELECT COUNT(*) AS n FROM pneus
    WHERE filial_id = ?
      AND numero_fogo IS NOT NULL
      AND TRIM(numero_fogo) != ''
  `).get(filialId);

  let maxSeq = 0;
  let ultimo = null;
  for (const row of rows) {
    const n = sequenciaDoPadrao(row.numero_fogo, codigo);
    if (n != null && n > maxSeq) {
      maxSeq = n;
      ultimo = formatarNumeroFogo(codigo, n);
    }
  }

  const sequencia = maxSeq + 1;
  const total = Number(totalRow?.n || 0);
  const noPadrao = rows.length;

  return {
    codigo_filial: codigo,
    padrao: formatarNumeroFogo(codigo, 1),
    proximo: formatarNumeroFogo(codigo, sequencia),
    ultimo,
    sequencia,
    padrao_obrigatorio: total === 0 || noPadrao === total,
  };
}

export async function resolverNumeroFogo(db, filialId, informado) {
  const info = await consultarProximoFogo(db, filialId);
  const normalizado = normalizarFogoInformado(informado, info.codigo_filial, {
    padrao_obrigatorio: info.padrao_obrigatorio,
  });
  if (!normalizado) {
    return { ...info, numero_fogo: info.proximo, gerado: true };
  }
  if (sequenciaDoPadrao(normalizado, info.codigo_filial) == null && info.padrao_obrigatorio) {
    throw erroHttp(
      `Use o padrão ${info.padrao} (código da unidade ${info.codigo_filial} + sequência)`,
      400
    );
  }
  return { ...info, numero_fogo: normalizado, gerado: false };
}

export async function assertFogoLivre(db, filialId, fogo, { ignorarId } = {}) {
  const params = [filialId, fogo];
  let sql = `
    SELECT id, ativo, status_pneu FROM pneus
    WHERE filial_id = ?
      AND LOWER(TRIM(numero_fogo)) = LOWER(TRIM(?))
  `;
  if (ignorarId) {
    sql += ' AND id != ?';
    params.push(ignorarId);
  }
  sql += ' LIMIT 1';
  const row = await db.prepare(sql).get(...params);
  if (!row) return;
  throw erroHttp(
    row.ativo
      ? 'Já existe um pneu com este nº de fogo nesta unidade'
      : 'Este nº de fogo já foi usado nesta unidade e não pode ser reutilizado',
    409
  );
}

/**
 * Gera/normaliza o fogo e tenta o INSERT. Em colisão do número gerado, tenta o próximo.
 * `inserir` deve usar savepoint se estiver dentro de uma transação PostgreSQL.
 */
export async function comRetryFogoUnico(db, filialId, informado, inserir) {
  let lastErr;
  for (let i = 0; i < MAX_TENTATIVAS_GERAR; i++) {
    const resolvido = await resolverNumeroFogo(db, filialId, informado);
    if (!resolvido.gerado) {
      await assertFogoLivre(db, filialId, resolvido.numero_fogo);
    }
    try {
      const result = await inserir(resolvido.numero_fogo);
      return { result, ...resolvido };
    } catch (err) {
      lastErr = err;
      if (!ehViolacaoUnique(err)) throw err;
      if (!resolvido.gerado) {
        throw erroHttp('Já existe um pneu com este nº de fogo nesta unidade', 409);
      }
    }
  }
  throw lastErr || erroHttp('Não foi possível gerar um nº de fogo único. Tente de novo.', 409);
}

export async function criarGeradorNumeroFogo(db, filialId) {
  const info = await consultarProximoFogo(db, filialId);
  let seq = info.sequencia;
  return {
    ...info,
    alocar(informado) {
      const normalizado = normalizarFogoInformado(informado, info.codigo_filial, {
        padrao_obrigatorio: info.padrao_obrigatorio,
      });
      if (!normalizado) {
        const fogo = formatarNumeroFogo(info.codigo_filial, seq);
        seq += 1;
        return { numero_fogo: fogo, gerado: true };
      }
      if (sequenciaDoPadrao(normalizado, info.codigo_filial) == null && info.padrao_obrigatorio) {
        throw erroHttp(
          `Use o padrão ${info.padrao} (código da unidade ${info.codigo_filial} + sequência)`,
          400
        );
      }
      const n = sequenciaDoPadrao(normalizado, info.codigo_filial);
      if (n != null && n >= seq) seq = n + 1;
      return { numero_fogo: normalizado, gerado: false };
    },
  };
}
