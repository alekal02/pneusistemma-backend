/**
 * Backup somente leitura do Neon (projeto pneusistemma-producao).
 * Não imprime connection string. Não grava no Neon.
 */
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const ORG = 'org-shy-math-70135500';
const PROJECT = 'snowy-resonance-89586114';
const DBS = ['neondb', 'pneusistemma_final'];
const TABELAS = ['veiculos', 'pneus', 'medicoes', 'movimentacoes'];

function connectionString(database) {
  const res = spawnSync('neonctl.cmd', [
    'connection-string',
    '--project-id', PROJECT,
    '--org-id', ORG,
    '--database-name', database,
  ], { encoding: 'utf8', shell: true });
  const texto = `${res.stdout || ''}\n${res.stderr || ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const match = texto.match(/postgres(?:ql)?:\/\/\S+/);
  if (!match) {
    const aviso = texto.replace(/postgres(?:ql)?:\/\/\S+/g, '[url]').slice(0, 300);
    throw new Error(`Sem connection string para ${database}: ${aviso}`);
  }
  return match[0].trim();
}

async function inspecionar(database) {
  const client = new pg.Client({
    connectionString: connectionString(database),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  const counts = {};
  const tem = {};
  for (const t of TABELAS) {
    const existe = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [t]
    );
    tem[t] = existe.rowCount > 0;
    counts[t] = tem[t]
      ? (await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n
      : null;
  }
  let filiais = [];
  const filialExiste = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'filiais'`
  );
  if (filialExiste.rowCount) {
    filiais = (await client.query('SELECT id, nome, codigo FROM filiais ORDER BY id')).rows;
  }
  await client.end();
  return { database, counts, tem, filiais };
}

const candidatos = [];
for (const database of DBS) {
  candidatos.push(await inspecionar(database));
}
console.log(JSON.stringify(candidatos, null, 2));

const alvo = candidatos.find((c) => TABELAS.every((t) => c.tem[t] && c.counts[t] > 0));
if (!alvo) {
  console.error('Nenhum banco com as quatro tabelas preenchidas.');
  process.exit(2);
}

const client = new pg.Client({
  connectionString: connectionString(alvo.database),
  ssl: { rejectUnauthorized: false },
});
await client.connect();
await client.query('SET default_transaction_read_only = on');
const dir = path.join(process.env.TEMP || '/tmp', 'pneu-neon-backup-2026-10-09');
fs.mkdirSync(dir, { recursive: true });
const dump = {};
for (const t of TABELAS) {
  const res = await client.query(`SELECT * FROM ${t} ORDER BY id`);
  dump[t] = res.rows;
  fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(res.rows));
}
await client.end();

const pglitePath = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2/node_modules/@electric-sql/pglite/dist/index.js';
const { PGlite } = await import(pathToFileURL(pglitePath).href);
const db = new PGlite();
for (const t of TABELAS) {
  const rows = dump[t];
  if (!rows.length) throw new Error(`dump vazio ${t}`);
  const cols = Object.keys(rows[0]);
  await db.exec(`CREATE TABLE ${t} (${cols.map((c) => `"${c}" TEXT`).join(', ')})`);
  for (const row of rows) {
    const vals = cols.map((c) => row[c] == null ? null : typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`, vals);
  }
  const n = await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  if (Number(n.rows[0].n) !== rows.length) {
    throw new Error(`restore divergente ${t}`);
  }
}
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  database: alvo.database,
  counts: alvo.counts,
  filiais: alvo.filiais,
  conferido: true,
  restauradoEmMemoria: true,
}, null, 2));
console.log(JSON.stringify({
  backup: dir,
  database: alvo.database,
  counts: alvo.counts,
  restoreOk: true,
}, null, 2));
