/**
 * Autorização do perfil presidente e migração da constraint.
 * Usa um banco local descartável. Não altera pneusistemma nem produção.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  aplicarConstraintPapel,
  ativarPresidente,
  assertHostPermitido,
  inspecionarPapel,
} from './migrar-papel-presidente.mjs';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = path.resolve(backendDir, '..', 'frontend');
dotenv.config({ path: path.join(backendDir, '.env') });

const origem = String(process.env.DATABASE_URL || '').trim();
if (!origem) throw new Error('DATABASE_URL local ausente no ambiente ou em backend/.env');
const origemUrl = new URL(origem);
if (!['localhost', '127.0.0.1'].includes(origemUrl.hostname)) {
  throw new Error('Teste recusado: DATABASE_URL não aponta para localhost');
}

const TEST_DB = 'pneusistemma_papel_test';
const PORT = 3017;
const SENHA = 'teste-auth-123';

function urlDoBanco(nome) {
  const url = new URL(origem);
  url.pathname = `/${nome}`;
  return url.toString();
}

async function conectar(nome) {
  const pool = new pg.Pool({ connectionString: urlDoBanco(nome), ssl: false });
  return pool;
}

async function recriarBanco() {
  const admin = await conectar('postgres');
  const client = await admin.connect();
  try {
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [TEST_DB]);
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    client.release();
    await admin.end();
  }
}

async function derrubarBanco() {
  const admin = await conectar('postgres');
  const client = await admin.connect();
  try {
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [TEST_DB]);
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  } finally {
    client.release();
    await admin.end();
  }
}

async function fotoBancoReal() {
  const pool = await conectar(origemUrl.pathname.replace(/^\//, '') || 'pneusistemma');
  try {
    const foto = await pool.query(`
      SELECT
        (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'usuarios_papel_check') AS constraint_papel,
        (SELECT COUNT(*)::int FROM usuarios) AS usuarios,
        (SELECT COUNT(*)::int FROM pneus) AS pneus,
        (SELECT COUNT(*)::int FROM medicoes) AS medicoes,
        (SELECT COUNT(*)::int FROM movimentacoes) AS movimentacoes,
        (SELECT COALESCE(json_agg(json_build_object('id', id, 'login', login, 'papel', papel, 'ativo', ativo, 'filial_id', filial_id) ORDER BY id), '[]'::json)
           FROM usuarios) AS usuarios_estado
    `);
    return foto.rows[0];
  } finally {
    await pool.end();
  }
}

async function prepararSchemaAntigo(pool) {
  await pool.query(`
    CREATE TABLE filiais (
      id BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      codigo TEXT NOT NULL UNIQUE
    );
    CREATE TABLE usuarios (
      id BIGSERIAL PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL CHECK (papel IN ('admin', 'gerente', 'filial')),
      filial_id BIGINT REFERENCES filiais(id) ON DELETE SET NULL,
      ativo INTEGER DEFAULT 1,
      cargo TEXT,
      ultimo_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE pneus (
      id BIGSERIAL PRIMARY KEY,
      observacoes TEXT
    );
    CREATE TABLE medicoes (
      id BIGSERIAL PRIMARY KEY,
      observacoes TEXT
    );
    CREATE TABLE movimentacoes (
      id BIGSERIAL PRIMARY KEY,
      motivo TEXT
    );
  `);
  await pool.query(`INSERT INTO filiais (nome, codigo) VALUES ('Unidade teste', 'TST')`);
  await pool.query(`
    INSERT INTO usuarios (id, login, senha_hash, papel, cargo, filial_id, ativo, ultimo_login, created_at)
    VALUES
      (1, 'admin', 'hash-admin', 'admin', 'admin', NULL, 1, '2024-05-01T12:00:00Z', '2024-01-01T00:00:00Z'),
      (2, 'gerente_auth', 'hash-gerente', 'gerente', 'gerente_filial', 1, 1, NULL, '2024-01-01T00:00:00Z'),
      (3, 'filial_auth', 'hash-filial', 'filial', 'funcionario', 1, 1, NULL, '2024-01-01T00:00:00Z'),
      (34, 'presidente', 'hash-fixo-nao-mexer', 'admin', 'admin', NULL, 1, '2024-06-15T08:30:00Z', '2024-02-02T00:00:00Z')
  `);
  await pool.query(`SELECT setval('usuarios_id_seq', 34)`);
  await pool.query(`INSERT INTO pneus (observacoes) VALUES ('pneu-original')`);
  await pool.query(`INSERT INTO medicoes (observacoes) VALUES ('medicao-original')`);
  await pool.query(`INSERT INTO movimentacoes (motivo) VALUES ('mov-original')`);
}

function esperarSaida(child) {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

async function testarMigracao() {
  await recriarBanco();
  const pool = await conectar(TEST_DB);
  const client = await pool.connect();
  try {
    await prepararSchemaAntigo(pool);
    const antes = await inspecionarPapel(client);
    assert.equal(antes.contagens.pneus, 1);
    assert.equal(antes.contagens.medicoes, 1);
    assert.equal(antes.contagens.movimentacoes, 1);
    assert.equal(antes.alvo.length, 1);
    assert.equal(antes.alvo[0].papel, 'admin');
    assert.equal(antes.constraints[0].def.includes('presidente'), false);

    await assert.rejects(
      () => pool.query(`INSERT INTO usuarios (login, senha_hash, papel) VALUES ('extra', 'h', 'presidente')`),
      (err) => err.code === '23514'
    );

    const constraint = await aplicarConstraintPapel(client);
    assert.equal(constraint.alterada, true);
    assert.equal(constraint.depois.includes(`'presidente'`), true);
    const deNovo = await aplicarConstraintPapel(client);
    assert.equal(deNovo.alterada, false);

    await pool.query(`UPDATE usuarios SET login = 'outro' WHERE id = 34`);
    await assert.rejects(() => ativarPresidente(client));
    const recusado = await pool.query(`SELECT login, papel, senha_hash FROM usuarios WHERE id = 34`);
    assert.equal(recusado.rows[0].login, 'outro');
    assert.equal(recusado.rows[0].papel, 'admin');
    assert.equal(recusado.rows[0].senha_hash, 'hash-fixo-nao-mexer');

    await pool.query(`UPDATE usuarios SET login = 'presidente' WHERE id = 34`);
    const ativacao = await ativarPresidente(client);
    assert.equal(ativacao.jaAtivo, false);
    assert.equal(ativacao.papel, 'presidente');
    const repetida = await ativarPresidente(client);
    assert.equal(repetida.jaAtivo, true);

    const depois = await pool.query(`
      SELECT login, papel, cargo, ativo, filial_id, senha_hash, ultimo_login, created_at
      FROM usuarios WHERE id = 34
    `);
    const row = depois.rows[0];
    assert.equal(row.login, 'presidente');
    assert.equal(row.papel, 'presidente');
    assert.equal(row.cargo, 'admin');
    assert.equal(Number(row.ativo), 1);
    assert.equal(row.filial_id, null);
    assert.equal(row.senha_hash, 'hash-fixo-nao-mexer');
    assert.equal(new Date(row.ultimo_login).toISOString(), '2024-06-15T08:30:00.000Z');
    assert.equal(new Date(row.created_at).toISOString(), '2024-02-02T00:00:00.000Z');

    const outros = await pool.query(`SELECT id, papel FROM usuarios WHERE id <> 34 ORDER BY id`);
    assert.deepEqual(outros.rows.map((item) => item.papel), ['admin', 'gerente', 'filial']);
    const frota = await pool.query(`
      SELECT
        (SELECT observacoes FROM pneus) AS pneu,
        (SELECT observacoes FROM medicoes) AS medicao,
        (SELECT motivo FROM movimentacoes) AS movimento,
        (SELECT COUNT(*)::int FROM pneus) AS pneus,
        (SELECT COUNT(*)::int FROM medicoes) AS medicoes,
        (SELECT COUNT(*)::int FROM movimentacoes) AS movimentacoes
    `);
    assert.deepEqual(frota.rows[0], {
      pneu: 'pneu-original',
      medicao: 'medicao-original',
      movimento: 'mov-original',
      pneus: 1,
      medicoes: 1,
      movimentacoes: 1,
    });
    await pool.query(`INSERT INTO usuarios (login, senha_hash, papel, filial_id) VALUES ('pres2', 'h', 'presidente', NULL)`);
    await assert.rejects(
      () => pool.query(`INSERT INTO usuarios (login, senha_hash, papel) VALUES ('ruim', 'h', 'visitante')`),
      (err) => err.code === '23514'
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function http(method, rota, { token, body } = {}) {
  const resp = await fetch(`http://127.0.0.1:${PORT}${rota}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const tipo = resp.headers.get('content-type') || '';
  if (tipo.includes('application/pdf')) {
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, tipo, buffer };
  }
  const texto = await resp.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = { bruto: texto }; }
  return { status: resp.status, tipo, json };
}

async function login(usuario, senha) {
  const resp = await http('POST', '/api/auth/login', { body: { login: usuario, senha } });
  assert.equal(resp.status, 200, JSON.stringify(resp.json));
  return resp.json.token;
}

function iniciarServidor() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: urlDoBanco(TEST_DB),
      DATABASE_SSL: 'false',
      JWT_SECRET: 'teste-presidente-local',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: SENHA,
      WHATSAPP_ALERTAS_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (buf) => { log += buf; });
  child.stderr.on('data', (buf) => { log += buf; });
  child.log = () => log;
  return child;
}

async function esperarHealth(child) {
  const prazo = Date.now() + 40000;
  let ultimo = '';
  while (Date.now() < prazo) {
    if (child.exitCode != null) {
      throw new Error(`Servidor encerrou ${child.exitCode}\n${child.log()}`);
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (resp.ok) return;
      ultimo = `${resp.status}`;
    } catch (err) {
      ultimo = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Health não respondeu (${ultimo})\n${child.log()}`);
}

async function semearPerfis() {
  const pool = await conectar(TEST_DB);
  try {
    const matriz = await pool.query(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`);
    const filialId = matriz.rows[0].id;
    const hash = bcrypt.hashSync(SENHA, 4);
    await pool.query(`
      INSERT INTO usuarios (id, login, senha_hash, papel, cargo, filial_id, ativo)
      VALUES
        (34, 'presidente', $1, 'presidente', 'admin', NULL, 1)
    `, [hash]);
    await pool.query(`SELECT setval('usuarios_id_seq', GREATEST((SELECT MAX(id) FROM usuarios), 34))`);
    await pool.query(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
      VALUES
        ('gerente_auth', $1, 'gerente', 'gerente_filial', $2, 1),
        ('filial_auth', $1, 'filial', 'funcionario', $2, 1)
    `, [hash, filialId]);
  } finally {
    await pool.end();
  }
}

async function testarApi() {
  await recriarBanco();
  const child = iniciarServidor();
  try {
    await esperarHealth(child);
    await semearPerfis();
    const admin = await login('admin', SENHA);
    const gerente = await login('gerente_auth', SENHA);
    const filial = await login('filial_auth', SENHA);
    const presidente = await login('presidente', SENHA);
    const sessao = await http('GET', '/api/auth/me', { token: presidente });
    assert.equal(sessao.status, 200, JSON.stringify(sessao.json));
    assert.equal(sessao.json.papel, 'presidente');
    assert.equal(sessao.json.filial_id ?? null, null);

    const rotas = ['/api/relatorios/saude-desgaste', '/api/relatorios/saude-desgaste.pdf'];
    for (const rota of rotas) {
      const anon = await http('GET', rota);
      assert.equal(anon.status, 401, rota);
      for (const [nome, token] of [['admin', admin], ['gerente', gerente], ['filial', filial]]) {
        const negado = await http('GET', rota, { token });
        assert.equal(negado.status, 403, `${nome} ${rota} ${JSON.stringify(negado.json)}`);
      }
    }

    const jsonOk = await http('GET', '/api/relatorios/saude-desgaste', { token: presidente });
    assert.equal(jsonOk.status, 200, JSON.stringify(jsonOk.json));
    assert.equal(jsonOk.json.titulo, 'Saúde e desgaste dos pneus');
    assert.equal(jsonOk.json.somente_leitura, true);

    const pdfOk = await http('GET', '/api/relatorios/saude-desgaste.pdf', { token: presidente });
    assert.equal(pdfOk.status, 200);
    assert.equal(pdfOk.tipo.includes('application/pdf'), true);
    assert.equal(pdfOk.buffer.slice(0, 4).toString(), '%PDF');

    for (const [method, rota, body] of [
      ['POST', '/api/usuarios', { login: 'nao-pode', senha: 'abcd', papel: 'filial', filial_id: 1 }],
      ['POST', '/api/filiais', { nome: 'Filial indevida', codigo: 'Z999' }],
      ['PUT', '/api/configuracoes', { sulco_critico_mm: 1 }],
      ['POST', '/api/pneus', { modelo: 'nao-gravar', medida: '275/80R22.5' }],
    ]) {
      const bloqueado = await http(method, rota, { token: presidente, body });
      assert.equal(bloqueado.status, 403, `${method} ${rota} ${JSON.stringify(bloqueado.json)}`);
      assert.equal(bloqueado.json?.somente_leitura, true);
    }

    for (const token of [admin, gerente]) {
      const diag = await http('GET', '/api/relatorios/diagnostico-frota', { token });
      assert.equal(diag.status, 200, JSON.stringify(diag.json));
    }
    const diagPresidente = await http('GET', '/api/relatorios/diagnostico-frota', { token: presidente });
    assert.equal(diagPresidente.status, 403, JSON.stringify(diagPresidente.json));
    const diagFilial = await http('GET', '/api/relatorios/diagnostico-frota', { token: filial });
    assert.equal(diagFilial.status, 403);

    const diretoria = await http('GET', '/api/relatorios/diretoria', { token: admin });
    assert.equal(diretoria.status, 200, JSON.stringify(diretoria.json));
    const diretoriaPresidente = await http('GET', '/api/relatorios/diretoria', { token: presidente });
    assert.equal(diretoriaPresidente.status, 403, JSON.stringify(diretoriaPresidente.json));
    assert.equal((await http('GET', '/api/relatorios/diretoria', { token: gerente })).status, 403);
    assert.equal((await http('GET', '/api/relatorios/diretoria', { token: filial })).status, 403);

    const criado = await http('POST', '/api/usuarios', {
      token: admin,
      body: { login: 'pres-com-filial', senha: 'abcd', papel: 'presidente', filial_id: 1 },
    });
    assert.equal(criado.status, 403, JSON.stringify(criado.json));
    const criadoSemFilial = await http('POST', '/api/usuarios', {
      token: admin,
      body: { login: 'outro-presidente', senha: 'abcd', papel: 'presidente' },
    });
    assert.equal(criadoSemFilial.status, 403, JSON.stringify(criadoSemFilial.json));

    const operador = await http('POST', '/api/usuarios', {
      token: admin,
      body: { login: 'operador-novo', senha: 'abcd', papel: 'filial', filial_id: 1 },
    });
    assert.equal(operador.status, 201, JSON.stringify(operador.json));
    const promovido = await http('PATCH', `/api/usuarios/${operador.json.usuario.id}`, {
      token: admin,
      body: { papel: 'gerente', filial_id: 1 },
    });
    assert.equal(promovido.status, 200, JSON.stringify(promovido.json));
    assert.equal(promovido.json.usuario.papel, 'gerente');
    const indevido = await http('PATCH', `/api/usuarios/${operador.json.usuario.id}`, {
      token: admin,
      body: { papel: 'presidente' },
    });
    assert.equal(indevido.status, 403, JSON.stringify(indevido.json));

    const lista = await http('GET', '/api/usuarios', { token: admin });
    assert.equal(lista.status, 200);
    assert.equal(lista.json.papeis.some((p) => p.codigo === 'presidente'), false);

    const pool = await conectar(TEST_DB);
    try {
      const alvo = await pool.query(`SELECT id, login, papel, senha_hash FROM usuarios WHERE login = 'presidente'`);
      assert.equal(Number(alvo.rows[0].id), 34);
      const hashAntes = alvo.rows[0].senha_hash;
      const rebaixado = await http('PATCH', '/api/usuarios/34', {
        token: admin,
        body: { papel: 'admin' },
      });
      assert.equal(rebaixado.status, 403, JSON.stringify(rebaixado.json));
      const papelDepois = await pool.query(`SELECT papel FROM usuarios WHERE id = 34`);
      assert.equal(papelDepois.rows[0].papel, 'presidente');
      const aindaGerente = await pool.query(`SELECT papel FROM usuarios WHERE login = 'operador-novo'`);
      assert.equal(aindaGerente.rows[0].papel, 'gerente');
      const inexistentes = await pool.query(`
        SELECT COUNT(*)::int AS n FROM usuarios
        WHERE login IN ('pres-com-filial', 'outro-presidente')
      `);
      assert.equal(inexistentes.rows[0].n, 0);
      const reset = await http('POST', `/api/usuarios/${alvo.rows[0].id}/reset-senha`, {
        token: gerente,
        body: { senha: 'nova-senha-1' },
      });
      assert.equal(reset.status, 403, JSON.stringify(reset.json));
      const hashDepois = await pool.query(`SELECT senha_hash FROM usuarios WHERE login = 'presidente'`);
      assert.equal(hashDepois.rows[0].senha_hash, hashAntes);
      const frota = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM pneus) AS pneus,
          (SELECT COUNT(*)::int FROM medicoes) AS medicoes,
          (SELECT COUNT(*)::int FROM movimentacoes) AS movimentacoes
      `);
      assert.deepEqual(frota.rows[0], { pneus: 0, medicoes: 0, movimentacoes: 0 });
    } finally {
      await pool.end();
    }
  } finally {
    child.kill();
    await esperarSaida(child);
  }
}

function testarFrontend() {
  const htmlPath = path.join(frontendDir, 'index.html');
  const appPath = path.join(frontendDir, 'src', 'app.js');
  if (!fs.existsSync(htmlPath) || !fs.existsSync(appPath)) return;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  assert.match(html, /id="tab-saude"[^>]*class="tab hidden"|class="tab hidden"[^>]*id="tab-saude"/);
  assert.doesNotMatch(html, /<option value="presidente">/);
  assert.match(app, /function ehContaPresidente\(/);
  assert.match(app, /O papel presidente não pode ser atribuído por esta tela/);
  assert.match(app, /function isAdmin\(\) \{\s*return currentUser\?\.papel === 'admin';/);
  assert.match(app, /function isPresidente\(\)/);
  assert.match(app, /if \(name === 'saude' && !isPresidente\(\)\) return;/);
  assert.match(app, /Saúde e desgaste: exclusivo do perfil presidente/);
  assert.match(app, /if \(!isPresidente\(\)\) return;/);
  const migracao = fs.readFileSync(path.join(backendDir, 'scripts', 'migrar-papel-presidente.mjs'), 'utf8');
  assert.doesNotMatch(migracao, /\b(UPDATE|DELETE|INSERT)\s+(pneus|medicoes|movimentacoes)\b/i);
}

assert.throws(
  () => assertHostPermitido('postgresql://user:secret@ep-xxxx.neon.tech/neondb?sslmode=require'),
  /Migração recusada/
);

const fotoAntes = await fotoBancoReal();
try {
  testarFrontend();
  await testarMigracao();
  await testarApi();
} finally {
  await derrubarBanco();
}
const fotoDepois = await fotoBancoReal();
assert.deepEqual(fotoDepois, fotoAntes);
console.log('test-auth-presidente: migração, API e banco local intactos');
