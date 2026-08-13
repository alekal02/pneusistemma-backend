/**
 * Traduz SQL estilo SQLite → PostgreSQL e ? → $1,$2,...
 */
export function translateSql(sql) {
  let s = String(sql);

  // Timestamps / dates SQLite → PG
  s = s.replace(/datetime\('now',\s*'localtime',\s*'\+24 hours'\)/gi, "(NOW() + INTERVAL '24 hours')");
  s = s.replace(/datetime\('now',\s*'localtime'\)/gi, 'NOW()');
  s = s.replace(/date\('now',\s*'localtime'\)/gi, 'CURRENT_DATE');

  // Funções
  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
  // excluded. → EXCLUDED. (PG)
  s = s.replace(/\bexcluded\./g, 'EXCLUDED.');

  // MAX(col, ?) / MAX(COALESCE(...), ?) → GREATEST (não agregação)
  s = s.replace(/\bMAX\s*\(\s*(COALESCE\s*\([^)]+\)|[a-zA-Z_][\w.]*)\s*,/gi, 'GREATEST($1,');
  // MIN com múltiplos args (sulcos) — padrão comum no projeto
  s = s.replace(/\bMIN\s*\(\s*COALESCE\s*\(/gi, 'LEAST(COALESCE(');

  // INSERT OR IGNORE precisa de ON CONFLICT — aplicado em sites específicos via SQL já com ON CONFLICT
  // Para INSERT INTO configuracoes sem ON CONFLICT após OR IGNORE:
  // tratado no prepare se detectar

  return convertPlaceholders(s);
}

function convertPlaceholders(sql) {
  let i = 0;
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingle && !inDouble) {
      i += 1;
      out += `$${i}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Garante RETURNING id em INSERTs sem RETURNING (para lastInsertRowid)
 */
/** Tabelas cuja PK não é `id` — RETURNING id quebraria o INSERT */
const TABELAS_SEM_ID = /\bINTO\s+configuracoes\b/i;

export function ensureReturningId(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^\s*INSERT\s+/i.test(trimmed)) return trimmed;
  if (/\bRETURNING\b/i.test(trimmed)) return trimmed;
  if (TABELAS_SEM_ID.test(trimmed)) return trimmed;
  return `${trimmed} RETURNING id`;
}

/**
 * Se o SQL veio de INSERT OR IGNORE sem ON CONFLICT, adiciona DO NOTHING genérico
 * (só seguro quando há UNIQUE/PK — configuracoes usa chave PK)
 */
export function ensureIgnoreConflict(originalSql, translatedSql) {
  if (!/\bINSERT\s+OR\s+IGNORE\b/i.test(originalSql)) return translatedSql;
  if (/\bON\s+CONFLICT\b/i.test(translatedSql)) return translatedSql;
  // configuracoes (chave), e inserts genéricos
  if (/INTO\s+configuracoes\b/i.test(translatedSql)) {
    return `${translatedSql.replace(/;+\s*$/, '')} ON CONFLICT (chave) DO NOTHING`;
  }
  return `${translatedSql.replace(/;+\s*$/, '')} ON CONFLICT DO NOTHING`;
}
