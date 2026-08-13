/**
 * Utilitários de transação/erro para PostgreSQL.
 */

let savepointSeq = 0;

/**
 * No PostgreSQL qualquer erro aborta a transação inteira. As importações em
 * massa coletam o erro da linha e seguem para a próxima, então cada operação
 * que pode falhar precisa rodar dentro de um savepoint.
 */
export async function comSavepoint(db, fn) {
  savepointSeq += 1;
  const nome = `sp_${savepointSeq}`;
  await db.exec(`SAVEPOINT ${nome}`);
  try {
    const resultado = await fn();
    await db.exec(`RELEASE SAVEPOINT ${nome}`);
    return resultado;
  } catch (err) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${nome}`);
    throw err;
  }
}

/** 23505 = unique_violation no PostgreSQL */
export function ehViolacaoUnique(err) {
  return err?.code === '23505' || String(err?.message || '').includes('UNIQUE');
}
