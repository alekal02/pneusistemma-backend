/**
 * Duas inicializações no PGlite local. Não usa Neon nem Render.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const BACKEND = 'C:/Projetos/pneusistemma/backend';
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55438;
const toFileUrl = (p) => pathToFileURL(p).href;

async function iniciarPglite() {
  const pglitePkg = path.join(PGLITE_DIR, 'node_modules/@electric-sql/pglite');
  const socketPkg = path.join(PGLITE_DIR, 'node_modules/@electric-sql/pglite-socket');
  const { PGlite } = await import(toFileUrl(path.join(pglitePkg, 'dist/index.js')));
  const { PGLiteSocketServer } = await import(toFileUrl(path.join(socketPkg, 'dist/index.js')));
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1', maxConnections: 8 });
  await server.start();
  return server;
}

function fase(nome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(BACKEND, 'scripts', 'test-init-idempotente.mjs')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`,
        DATABASE_SSL: 'false',
        NODE_ENV: 'development',
        JWT_SECRET: 'init-idem',
        PNEU_INIT_FASE: nome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`${nome} saiu ${code}\n${out}\n${err}`));
      else resolve(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    });
  });
}

async function executarFase(nome) {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  await initDatabase();
  const db = getDb();
  if (nome === 'gravar') {
    const admin = await db.prepare(`SELECT id, senha_hash FROM usuarios WHERE papel = 'admin' LIMIT 1`).get();
    const antes = admin.senha_hash;
    await db.prepare(`UPDATE usuarios SET senha_hash = ? WHERE id = ?`).run('hash-fixo-teste', admin.id);
    const filial = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get();
    const veiculo = await db.prepare(`
      INSERT INTO veiculos (placa, tipo, tipo_codigo, filial_id, ativo, cadastro_completo)
      VALUES ('IDM0001', 'Trator', 'trator', ?, 1, 1) RETURNING id
    `).run(filial.id);
    const pneu = await db.prepare(`
      INSERT INTO pneus (numero_fogo, filial_id, veiculo_id, status_pneu, ativo, cadastro_completo)
      VALUES ('F-IDEM', ?, NULL, 'estoque', 1, 1) RETURNING id
    `).run(filial.id);
    await db.prepare(`
      INSERT INTO medicoes (pneu_id, veiculo_id, sulco_mm, observacoes)
      VALUES (?, ?, 12.5, 'medicao-original')
    `).run(pneu.lastInsertRowid, veiculo.lastInsertRowid);
    await db.prepare(`
      INSERT INTO movimentacoes (pneu_id, tipo, motivo)
      VALUES (?, 'estoque', 'mov-original')
    `).run(pneu.lastInsertRowid);
    await db.prepare(`
      INSERT INTO notificacoes_whatsapp (tipo, destinatario_whatsapp, mensagem, status)
      VALUES ('menu', '5500000000000', 'menu existente', 'enviado')
    `).run();
    const contagens = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM pneus) AS pneus,
        (SELECT COUNT(*) FROM medicoes) AS medicoes,
        (SELECT COUNT(*) FROM movimentacoes) AS movimentacoes,
        (SELECT COUNT(*) FROM notificacoes_whatsapp WHERE tipo = 'menu') AS menus
    `).get();
    console.log(JSON.stringify({
      senha_antes_seed: antes,
      senha: 'hash-fixo-teste',
      pneu: pneu.lastInsertRowid,
      ...contagens,
    }));
  } else {
    const admin = await db.prepare(`SELECT senha_hash FROM usuarios WHERE papel = 'admin' LIMIT 1`).get();
    const pneu = await db.prepare(`SELECT id, numero_fogo, status_pneu FROM pneus WHERE numero_fogo = 'F-IDEM'`).get();
    const med = await db.prepare(`SELECT sulco_mm, observacoes FROM medicoes WHERE observacoes = 'medicao-original'`).get();
    const mov = await db.prepare(`SELECT tipo, motivo FROM movimentacoes WHERE motivo = 'mov-original'`).get();
    const menu = await db.prepare(`SELECT COUNT(*) AS n FROM notificacoes_whatsapp WHERE tipo = 'menu'`).get();
    const check = await db.prepare(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'notificacoes_whatsapp_tipo_check'
    `).get();
    console.log(JSON.stringify({
      senha: admin.senha_hash,
      pneu,
      med,
      mov,
      menus: Number(menu.n),
      check: check?.def || '',
    }));
  }
  await closePool();
}

const faseArg = process.env.PNEU_INIT_FASE || process.argv[2];
if (faseArg === 'gravar' || faseArg === 'releitura') {
  await executarFase(faseArg);
} else {
  const server = await iniciarPglite();
  try {
    const bruto1 = await fase('gravar');
    const bruto2 = await fase('releitura');
    const a = JSON.parse(bruto1);
    const b = JSON.parse(bruto2);
    assert.equal(b.senha, 'hash-fixo-teste');
    assert.notEqual(b.senha, a.senha_antes_seed);
    assert.equal(b.pneu.numero_fogo, 'F-IDEM');
    assert.equal(b.pneu.status_pneu, 'estoque');
    assert.equal(Number(b.med.sulco_mm), 12.5);
    assert.equal(b.med.observacoes, 'medicao-original');
    assert.equal(b.mov.motivo, 'mov-original');
    assert.equal(b.menus, 1);
    assert.match(b.check, /menu/);
    assert.doesNotMatch(b.check, /DELETE/i);
    console.log('init idempotente ok');
  } finally {
    await server.stop();
  }
}
