/**
 * Limpa dados operacionais para testes do zero.
 * Mantém: filiais, usuarios, configuracoes (limites).
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../data/pneus.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

function count(table) {
  return db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
}

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

console.log('Banco:', dbPath);
console.log('Antes:', Object.fromEntries(tabelas.map((t) => [t, count(t)])));

db.exec('BEGIN');
try {
  db.exec('DELETE FROM notificacoes_whatsapp');
  db.exec('DELETE FROM tokens_acesso_rapido');
  db.exec('DELETE FROM medicoes');
  db.exec('DELETE FROM movimentacoes');
  db.exec('DELETE FROM pneus');
  db.exec('DELETE FROM veiculos');
  db.exec(`
    DELETE FROM sqlite_sequence
    WHERE name IN (
      'veiculos','pneus','medicoes','movimentacoes',
      'notificacoes_whatsapp','tokens_acesso_rapido'
    )
  `);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

console.log('Depois:', Object.fromEntries(tabelas.map((t) => [t, count(t)])));
db.close();
console.log('OK: frota limpa. Logins e limites mantidos.');
