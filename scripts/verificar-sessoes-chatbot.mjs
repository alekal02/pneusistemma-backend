/**
 * Verificação pré-deploy do chatbot: NÃO conecta, NÃO desconecta, NÃO gera token.
 *
 * 1) Testes locais do reconhecimento de sessão já pareada.
 * 2) Opcional (somente leitura): filiais no banco + usuários WuzAPI.
 *
 *   node scripts/verificar-sessoes-chatbot.mjs
 *   node scripts/verificar-sessoes-chatbot.mjs --live
 */
import { encontrarUsuarioWuzapiDaFilial, chipsWhatsappIguais } from '../src/services/whatsapp.js';

let falhas = 0;
let oks = 0;

function ok(cond, nome, extra = '') {
  if (cond) {
    oks += 1;
    console.log(`OK   ${nome}${extra ? ` — ${extra}` : ''}`);
  } else {
    falhas += 1;
    console.log(`FAIL ${nome}${extra ? ` — ${extra}` : ''}`);
  }
}

const filialBh = {
  id: 5,
  codigo: 'BH',
  nome: 'Belo Horizonte',
  whatsapp: '5531999887766',
  wuzapi_token: 'pneu_5_abc',
};

const users = [
  {
    name: 'Pneu5-BH',
    token: 'pneu_5_abc',
    loggedIn: true,
    connected: true,
    jid: '5531999887766:12@s.whatsapp.net',
  },
  {
    name: 'Pneu9-SP',
    token: 'pneu_9_xyz',
    loggedIn: true,
    connected: true,
    jid: '5511988776655@s.whatsapp.net',
  },
];

console.log('== Testes locais (sessões já pareadas) ==');

const achouBh = encontrarUsuarioWuzapiDaFilial(filialBh, users);
ok(achouBh?.token === 'pneu_5_abc', 'reconhece filial pelo nome WuzAPI');
ok(chipsWhatsappIguais(achouBh?.jid, filialBh.whatsapp), 'chip da filial bate com a sessão (JID com :device)');

const semFlagLoggedIn = encontrarUsuarioWuzapiDaFilial(filialBh, [{
  name: 'Pneu5-BH',
  token: 'pneu_5_abc',
  loggedIn: false,
  connected: true,
  jid: '5531999887766@s.whatsapp.net',
}]);
ok(semFlagLoggedIn?.token === 'pneu_5_abc', 'reconhece sessão connected+chip mesmo com loggedIn=false');

const soPeloChip = encontrarUsuarioWuzapiDaFilial(filialBh, [{
  name: 'sessao-antiga',
  token: 'pneu_5_abc',
  loggedIn: true,
  connected: true,
  Phone: '5531999887766',
}]);
ok(soPeloChip?.token === 'pneu_5_abc', 'reconhece pelo chip salvo se o nome WuzAPI mudou');

const soPeloToken = encontrarUsuarioWuzapiDaFilial(filialBh, [{
  name: 'outro-nome',
  token: 'pneu_5_abc',
  loggedIn: true,
  connected: true,
  jid: '5531999887766@s.whatsapp.net',
}]);
ok(soPeloToken?.token === 'pneu_5_abc', 'reconhece pelo token salvo da própria filial');

const naoPegaOutra = encontrarUsuarioWuzapiDaFilial(filialBh, [users[1]]);
ok(!naoPegaOutra, 'não herda a sessão de outra filial');

const tokenCompartilhado = encontrarUsuarioWuzapiDaFilial(
  { id: 7, codigo: 'RJ', nome: 'Rio', whatsapp: '', wuzapi_token: 'pneu_5_abc' },
  users,
);
ok(
  tokenCompartilhado?.token === 'pneu_5_abc',
  'token repetido no cadastro ainda aponta para a sessão viva — não cria usuário novo nem derruba o chip',
);

function classificarEstadoConexao(st = {}) {
  if (st.loggedIn && !st.sessao_alheia && !st.token_compartilhado) return 'conectado';
  if (st.sessao_alheia || st.token_compartilhado) return 'precisa_qr';
  if (st.infra_wuzapi) return 'servidor_indisponivel';
  if (st.configurado === false) return 'precisa_token';
  if (st.qrcode || (st.connected && !st.loggedIn)) return 'aguardando_qr';
  return 'offline';
}

ok(classificarEstadoConexao({ loggedIn: true, phone: '5531' }) === 'conectado', 'estado: já conectado');
ok(classificarEstadoConexao({ loggedIn: true, infra_wuzapi: true }) === 'conectado', 'estado: infra não derruba quem já está logado');
ok(classificarEstadoConexao({ loggedIn: true, chip_presumido: true }) === 'conectado', 'estado: chip cadastrado continua conectado se o WuzAPI oscilar');
ok(classificarEstadoConexao({ infra_wuzapi: true, loggedIn: false }) === 'servidor_indisponivel', 'estado: servidor lento sem logout');
ok(classificarEstadoConexao({ connected: true, loggedIn: false, qrcode: 'data:image/png;base64,xx' }) === 'aguardando_qr', 'estado: QR sem desconectar outras filiais');

const live = process.argv.includes('--live');
if (!live) {
  console.log('\n(use --live para cruzar banco + WuzAPI em modo somente leitura)');
  console.log(`\nResultado: ${oks} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}

const { config } = await import('../src/config.js');
const { tokenWuzapiUtil, limparTelefone } = await import('../src/services/whatsapp.js');
const pg = await import('pg');

console.log('\n== Somente leitura: filiais × WuzAPI ==');
console.log('(SELECT + GET admin/users — nenhum connect/logout/token novo/migrate)');

let filiais = [];
if (!config.databaseUrl) {
  console.log('AVISO DATABASE_URL ausente neste ambiente.');
} else {
  const client = new pg.default.Client({
    connectionString: config.databaseUrl,
    ssl: /neon\.tech|sslmode=require/i.test(config.databaseUrl)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT id, nome, codigo, whatsapp, whatsapp_grupo, wuzapi_token
      FROM filiais
      WHERE ativo = 1
      ORDER BY id
    `);
    filiais = r.rows || [];
  } catch (err) {
    console.log(`AVISO banco indisponível aqui (${err.code || err.message}) — testes locais já passaram.`);
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
let usersLive = [];
let wuzapiOk = false;
if (admin && config.wuzapiBaseUrl) {
  try {
    const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
      headers: { Authorization: admin },
      signal: AbortSignal.timeout(15_000),
    });
    wuzapiOk = res.ok;
    const data = res.ok ? await res.json() : null;
    usersLive = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  } catch (err) {
    console.log(`AVISO WuzAPI indisponível agora (${err.message})`);
  }
} else {
  console.log('AVISO WUZAPI_ADMIN_TOKEN / WUZAPI_BASE_URL ausente neste ambiente.');
}

if (filiais.length) ok(true, `filiais ativas no banco: ${filiais.length}`);
if (wuzapiOk) ok(true, `WuzAPI admin/users: ${usersLive.length} sessão(ões)`);

const comChip = filiais.filter((f) => limparTelefone(f.whatsapp).length >= 10);
if (filiais.length) console.log(`Filiais com chip cadastrado: ${comChip.length}`);

for (const f of comChip) {
  const achou = encontrarUsuarioWuzapiDaFilial(f, usersLive);
  const phone = limparTelefone(achou?.jid || achou?.JID || achou?.phone || achou?.Phone);
  const bate = !phone || chipsWhatsappIguais(phone, f.whatsapp);
  if (achou && bate) {
    ok(true, `${f.codigo || f.id} ${f.nome}`, `sessão reconhecida (${achou.name || achou.Name || 'ok'})`);
  } else if (achou && !bate) {
    ok(false, `${f.codigo || f.id} ${f.nome}`, 'chip no WuzAPI diferente do cadastro — não subir sem conferir');
  } else if (!wuzapiOk) {
    console.log(`AVISO ${f.codigo || f.id} ${f.nome} — WuzAPI offline; chip permanece no cadastro`);
  } else {
    console.log(`AVISO ${f.codigo || f.id} ${f.nome} — chip no banco, sessão não vista agora (connect NÃO deve gerar token novo)`);
  }
}

console.log(`\nResultado: ${oks} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
