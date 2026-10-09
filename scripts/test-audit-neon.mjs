/**
 * Leitura do Neon: contagens, colunas exigidas pelo boot e dump local conferido.
 * Não grava no banco.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../.env') });

const url = process.env.DATABASE_URL || '';
if (!url) {
  console.error('SEM_URL');
  process.exit(1);
}
let host = 'url-invalida';
try { host = new URL(url).host; } catch { /* ignore */ }
if (!/neon\.tech/i.test(host)) {
  console.error('HOST_NAO_NEON', host);
  process.exit(1);
}
const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const tables = ['filiais', 'veiculos', 'pneus', 'medicoes', 'movimentacoes', 'tokens_acesso_rapido'];
const counts = {};
for (const t of tables) {
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  counts[t] = r.rows[0].n;
}
const cols = await client.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = ANY($1)
`, [tables]);
const have = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
const needed = [
  'veiculos.cadastro_completo', 'veiculos.tipo_codigo', 'veiculos.dia_medicao', 'veiculos.layout_pneus',
  'pneus.cadastro_completo', 'pneus.custo', 'pneus.nota_fiscal', 'pneus.numero_fogo', 'pneus.status_pneu',
  'movimentacoes.usuario', 'movimentacoes.custo', 'movimentacoes.sulco_antes', 'movimentacoes.sulco_depois',
  'movimentacoes.motivo', 'movimentacoes.ciclo', 'movimentacoes.veiculo_apelido',
  'tokens_acesso_rapido.tipo', 'tokens_acesso_rapido.pneu_id', 'tokens_acesso_rapido.usado_em',
];
const missing = needed.filter((k) => !have.has(k));
const cons = await client.query(`
  SELECT conrelid::regclass::text AS tabela, conname
  FROM pg_constraint
  WHERE conrelid IN ('public.veiculos'::regclass, 'public.pneus'::regclass)
    AND contype IN ('u', 'p')
  ORDER BY 1, 2
`);
const idx = await client.query(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'pneus' AND indexdef ILIKE '%unique%'
`);
const dir = path.join(process.env.TEMP || '/tmp', 'pneu-neon-backup-2026-10-09');
fs.mkdirSync(dir, { recursive: true });
for (const t of ['veiculos', 'pneus', 'medicoes', 'movimentacoes']) {
  const res = await client.query(`SELECT * FROM ${t}`);
  const file = path.join(dir, `${t}.json`);
  fs.writeFileSync(file, JSON.stringify(res.rows));
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (back.length !== counts[t]) throw new Error(`dump divergente ${t}`);
}
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  counts, missing, constraints: cons.rows, indexes: idx.rows, host, conferido: true,
}, null, 2));
console.log(JSON.stringify({
  counts,
  missing,
  constraints: cons.rows.map((r) => `${r.tabela}:${r.conname}`),
  indexes: idx.rows.map((r) => r.indexname),
  backup: dir,
  dumpOk: true,
}, null, 2));
await client.end();
