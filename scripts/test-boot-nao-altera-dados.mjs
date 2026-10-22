/**
 * Boot de produção não regrava dados operacionais.
 * Só fala com Postgres local. Recusa Neon e não usa credencial administrativa.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

process.env.NODE_ENV = 'production';
delete process.env.BOOT_MIGRACOES;

const { bootManutencaoHabilitada, initDatabase, closePool } = await import('../src/database.js');
const { limparTokensChatbotAntigos } = await import('../src/services/whatsapp.js');
const { config } = await import('../src/config.js');

function flag(nodeEnv, boot) {
  const anteriorEnv = process.env.NODE_ENV;
  const anteriorBoot = process.env.BOOT_MIGRACOES;
  process.env.NODE_ENV = nodeEnv;
  if (boot == null) delete process.env.BOOT_MIGRACOES;
  else process.env.BOOT_MIGRACOES = boot;
  const valor = bootManutencaoHabilitada();
  process.env.NODE_ENV = anteriorEnv;
  if (anteriorBoot == null) delete process.env.BOOT_MIGRACOES;
  else process.env.BOOT_MIGRACOES = anteriorBoot;
  return valor;
}

assert.equal(flag('production', null), false);
assert.equal(flag('production', '1'), true);
assert.equal(flag('production', '0'), false);
assert.equal(flag('development', null), true);
assert.equal(flag('development', '0'), false);
assert.equal(bootManutencaoHabilitada(), false);

const antesDoPool = await limparTokensChatbotAntigos();
assert.equal(antesDoPool.skipped, true);
assert.equal(antesDoPool.motivo, 'boot_producao');

let url;
try {
  url = new URL(config.databaseUrl);
} catch {
  throw new Error('DATABASE_URL local inválida. O teste não segue.');
}
const host = url.hostname;
if (host !== 'localhost' && host !== '127.0.0.1') {
  throw new Error('Teste recusado: o banco configurado não é local.');
}

const client = new pg.Client({
  connectionString: config.databaseUrl,
  ssl: false,
  statement_timeout: 20000,
});
await client.connect();
await client.query('BEGIN READ ONLY');

const consultas = {
  usuarios: `SELECT md5(COALESCE(string_agg(concat_ws('|', id::text, COALESCE(login,''), COALESCE(senha_hash,''), COALESCE(papel,''), COALESCE(cargo,''), COALESCE(filial_id::text,''), COALESCE(ativo::text,''), COALESCE(whatsapp,'')), E'\\n' ORDER BY id), '')) AS h, COUNT(*)::int AS n FROM usuarios`,
  veiculos: `SELECT md5(COALESCE(string_agg(concat_ws('|', id::text, COALESCE(placa,''), COALESCE(filial_id::text,''), COALESCE(ativo::text,''), COALESCE(tipo,''), COALESCE(tipo_codigo,''), COALESCE(layout_pneus,'')), E'\\n' ORDER BY id), '')) AS h, COUNT(*)::int AS n FROM veiculos`,
  pneus: `SELECT md5(COALESCE(string_agg(concat_ws('|', id::text, COALESCE(veiculo_id::text,''), COALESCE(posicao,''), COALESCE(filial_id::text,''), COALESCE(status_pneu,''), COALESCE(ativo::text,''), COALESCE(numero_fogo,'')), E'\\n' ORDER BY id), '')) AS h, COUNT(*)::int AS n FROM pneus`,
  medicoes: `SELECT md5(COALESCE(string_agg(concat_ws('|', id::text, COALESCE(pneu_id::text,''), COALESCE(data_medicao,''), COALESCE(sulco_externo::text,''), COALESCE(sulco_central::text,''), COALESCE(sulco_interno::text,''), COALESCE(sulco_auxiliar::text,''), COALESCE(sulco_mm::text,'')), E'\\n' ORDER BY id), '')) AS h, COUNT(*)::int AS n FROM medicoes`,
  filiais: `SELECT md5(COALESCE(string_agg(concat_ws('|', id::text, COALESCE(codigo,''), COALESCE(whatsapp,''), COALESCE(wuzapi_token,''), COALESCE(ativo::text,'')), E'\\n' ORDER BY id), '')) AS h, COUNT(*)::int AS n FROM filiais`,
  tokens: `SELECT md5(COALESCE(string_agg(concat_ws('|', id::text, COALESCE(token,''), COALESCE(veiculo_id::text,''), COALESCE(filial_id::text,''), COALESCE(tipo,''), COALESCE(usado_em::text,'')), E'\\n' ORDER BY id), '')) AS h, COUNT(*)::int AS n FROM tokens_acesso_rapido`,
  configuracoes: `SELECT md5(COALESCE(string_agg(concat_ws('|', chave, COALESCE(valor,'')), E'\\n' ORDER BY chave), '')) AS h, COUNT(*)::int AS n FROM configuracoes`,
};

async function foto() {
  const saida = {};
  for (const [nome, sql] of Object.entries(consultas)) {
    const res = await client.query(sql);
    saida[nome] = res.rows[0];
  }
  return saida;
}

function iguais(a, b) {
  for (const nome of Object.keys(consultas)) {
    assert.equal(b[nome].n, a[nome].n, `${nome}: quantidade mudou`);
    assert.equal(b[nome].h, a[nome].h, `${nome}: conteúdo mudou`);
  }
}

const antes = await foto();
await client.query('COMMIT');

await initDatabase();
const limpeza = await limparTokensChatbotAntigos();
assert.equal(limpeza.skipped, true);
assert.equal(limpeza.motivo, 'boot_producao');

await client.query('BEGIN READ ONLY');
const depois = await foto();
await client.query('COMMIT');
iguais(antes, depois);

await initDatabase();
await limparTokensChatbotAntigos();
await client.query('BEGIN READ ONLY');
const segundo = await foto();
await client.query('COMMIT');
iguais(antes, segundo);

await client.end();
await closePool();

console.log('boot de produção não alterou usuários, senhas, frota, medições, tokens nem configurações');
console.log('dashboard: regras puras seguem no teste executivo');
