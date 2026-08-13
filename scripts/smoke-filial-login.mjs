/**
 * Smoke: cria filial → login → “logout” → login de novo (persistência PG).
 * Uso: node scripts/smoke-filial-login.mjs
 * Env: SMOKE_BASE, ADMIN_USER, ADMIN_PASS
 */
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

let falhas = 0;

async function req(metodo, caminho, { token, body } = {}) {
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto }; }
  return { status: res.status, dados };
}

function ok(cond, msg, detalhe) {
  if (cond) console.log(`OK   ${msg}`);
  else {
    falhas += 1;
    console.log(`FAIL ${msg}${detalhe ? ` -> ${detalhe}` : ''}`);
  }
}

const loginAdmin = await req('POST', '/auth/login', {
  body: { login: ADMIN_USER, senha: ADMIN_PASS },
});
ok(loginAdmin.status === 200 && loginAdmin.dados?.token, 'login admin', JSON.stringify(loginAdmin.dados).slice(0, 200));
const adminToken = loginAdmin.dados?.token;
if (!adminToken) {
  console.error('Abortado: sem token admin');
  process.exit(1);
}

const sufixo = String(Date.now()).slice(-6);
const loginFilial = `unai${sufixo}`;
const senhaFilial = 'Unai123';
const codigo = `UNA${sufixo}`;

const cria = await req('POST', '/filiais', {
  token: adminToken,
  body: {
    nome: `Filial Unai ${sufixo}`,
    codigo,
    contrato: 'smoke',
    login: loginFilial,
    senha: senhaFilial,
  },
});
ok(cria.status === 201 && cria.dados?.id, 'POST /filiais', JSON.stringify(cria.dados).slice(0, 300));
ok(cria.dados?.login === loginFilial, `resposta inclui login=${loginFilial}`, JSON.stringify(cria.dados));
ok(Boolean(cria.dados?.usuario_id), 'resposta inclui usuario_id', JSON.stringify(cria.dados));

const users = await req('GET', '/usuarios', { token: adminToken });
const u = users.dados?.usuarios?.find((x) => x.login === loginFilial);
ok(Boolean(u), 'usuário aparece em GET /usuarios', JSON.stringify(users.dados?.usuarios?.map((x) => x.login)));
ok(u?.filial_id === cria.dados?.id, 'usuário vinculado à filial criada');

async function loginFilialN(vez) {
  const r = await req('POST', '/auth/login', {
    body: { login: loginFilial, senha: senhaFilial },
  });
  ok(r.status === 200 && r.dados?.token, `login filial #${vez}`, JSON.stringify(r.dados).slice(0, 200));
  ok(r.dados?.usuario?.login === loginFilial, `login #${vez} retorna usuário certo`);
  ok(r.dados?.usuario?.filial_id === cria.dados?.id, `login #${vez} filial_id ok`);
  return r.dados?.token;
}

const t1 = await loginFilialN(1);
if (t1) {
  const me = await req('GET', '/auth/me', { token: t1 });
  ok(me.status === 200 && me.dados?.login === loginFilial, 'GET /auth/me com token filial');
}

// “logout” = descartar token e autenticar de novo (como no front)
await loginFilialN(2);
await loginFilialN(3);

// Case-insensitive
const mix = await req('POST', '/auth/login', {
  body: { login: loginFilial.toUpperCase(), senha: senhaFilial },
});
ok(mix.status === 200, 'login case-insensitive');

if (falhas) {
  console.error(`\n${falhas} FALHA(S)`);
  process.exit(1);
}
console.log('\nTODOS OS TESTES DE FILIAL/LOGIN PASSARAM');
