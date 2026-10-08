/**
 * Consultas que precisam funcionar no schema já publicado,
 * mesmo quando a coluna ainda não foi criada.
 * Não altera o banco.
 */
const cache = new Map();

export function limparCacheColunas() {
  cache.clear();
}

export async function colunaExiste(db, tabela, coluna) {
  const key = `${tabela}.${coluna}`;
  if (cache.has(key)) return cache.get(key);
  const row = await db.prepare(`
    SELECT 1 AS ok
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ? AND column_name = ?
  `).get(tabela, coluna);
  const ok = Boolean(row);
  cache.set(key, ok);
  return ok;
}

/** Filtro SQL. Sem a coluna, todo registro conta como cadastro completo. */
export async function filtroCadastroCompleto(db, tabela, qualificado = 'cadastro_completo') {
  const ok = await colunaExiste(db, tabela, 'cadastro_completo');
  if (!ok) return 'TRUE';
  return `COALESCE(${qualificado}, 1) = 1`;
}

/** Projeção SQL. Sem a coluna, devolve 1 sem referenciar o nome. */
export async function projecaoCadastroCompleto(db, tabela, qualificado = 'cadastro_completo') {
  const ok = await colunaExiste(db, tabela, 'cadastro_completo');
  if (!ok) return '1 AS cadastro_completo';
  return qualificado;
}
