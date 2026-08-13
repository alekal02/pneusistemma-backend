/**
 * Limpa dados operacionais para testes do zero.
 * Mantém: filiais, usuarios, configuracoes (limites).
 */
import { initDatabase, getDb, closePool } from '../src/database.js';

const tabelas = [
  'veiculos',
  'pneus',
  'medicoes',
  'movimentacoes',
  'notificacoes_whatsapp',
  'tokens_acesso_rapido',
  'usuarios',
  'filiais',
];

async function contagens(db) {
  const entries = [];
  for (const t of tabelas) {
    const row = await db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get();
    entries.push([t, Number(row?.c || 0)]);
  }
  return Object.fromEntries(entries);
}

async function main() {
  await initDatabase();
  const db = getDb();

  console.log('Antes:', await contagens(db));

  // TRUNCATE ... RESTART IDENTITY zera as sequences (equivalente ao sqlite_sequence)
  await db.transaction(async () => {
    await db.exec(`
      TRUNCATE TABLE
        notificacoes_whatsapp,
        tokens_acesso_rapido,
        medicoes,
        movimentacoes,
        pneus,
        veiculos
      RESTART IDENTITY CASCADE
    `);
  });

  console.log('Depois:', await contagens(db));
  await closePool();
  console.log('OK: frota limpa. Logins e limites mantidos.');
}

main().catch(async (err) => {
  console.error(err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
