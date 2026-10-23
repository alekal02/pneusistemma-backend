/**
 * Regressão, autorização, paginação e desempenho de
 * GET /api/veiculos, GET /api/pneus e GET /api/dashboard/resumo.
 *
 * Banco: PGlite em 127.0.0.1. Não abre Neon e não grava dado operacional.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import express from 'express';
import bcrypt from 'bcryptjs';

const PGLITE = 'C:/Projetos/pneu-main/backend/node_modules/@electric-sql/pglite/dist/index.js';
const SOCKET = 'C:/Projetos/pneu-main/backend/node_modules/@electric-sql/pglite-socket/dist/index.js';
const PG_PORT = 55484;
const SENHA = 'teste-local-frota';
const VEICULOS = 18;
const PNEUS_POR_VEICULO = 4;
const HISTORICO = 3;
const ESTOQUE = 16;

const medidor = { ativo: false, consultas: [] };

function bytes(valor) {
  return Buffer.byteLength(JSON.stringify(valor));
}

async function medir(fn) {
  medidor.consultas = [];
  medidor.ativo = true;
  if (global.gc) global.gc();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  try {
    const valor = await fn();
    return {
      valor,
      tempo: performance.now() - t0,
      heap: process.memoryUsage().heapUsed - heap0,
      consultas: medidor.consultas.length,
      medicoes: medidor.consultas.filter((c) => /\bmedicoes\b/i.test(c)).length,
    };
  } finally {
    medidor.ativo = false;
  }
}

async function main() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'teste-local-frota-jwt';
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = SENHA;
  process.env.FRONTEND_URL = 'http://127.0.0.1:5173';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  if (!/127\.0\.0\.1|localhost/i.test(process.env.DATABASE_URL)) {
    throw new Error('Teste recusado: o banco não é local.');
  }

  const { PGlite } = await import(pathToFileURL(PGLITE).href);
  const { PGLiteSocketServer } = await import(pathToFileURL(SOCKET).href);
  const mem = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: mem, port: PG_PORT, host: '127.0.0.1', maxConnections: 20 });
  await socket.start();

  const { initDatabase, getDb, closePool } = await import('../src/database.js');
  const { getPool } = await import('../src/pg-db.js');
  await initDatabase();
  if (!/127\.0\.0\.1/.test(process.env.DATABASE_URL)) {
    throw new Error('Teste interrompido: a conexão deixou o localhost.');
  }
  const pool = getPool();
  const queryOriginal = pool.query.bind(pool);
  pool.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text || '');
    if (medidor.ativo) medidor.consultas.push(String(sql).replace(/\s+/g, ' ').trim());
    return queryOriginal(...args);
  };

  const db = getDb();
  const hash = bcrypt.hashSync(SENHA, 10);

  async function criarFilial(codigo, nome) {
    const criada = await db.prepare(`
      INSERT INTO filiais (nome, codigo, contrato, ativo) VALUES (?, ?, 'contrato-teste', 1)
    `).run(nome, codigo);
    return Number(criada.lastInsertRowid);
  }

  async function criarVeiculo(filialId, placa) {
    const r = await db.prepare(`
      INSERT INTO veiculos (placa, apelido, tipo, layout_pneus, filial_id, ativo, cadastro_completo, km_atual)
      VALUES (?, ?, 'Truck / Tração', 'truck_10', ?, 1, 1, 1000)
    `).run(placa, placa, filialId);
    return Number(r.lastInsertRowid);
  }

  async function criarPneu(filialId, veiculoId, posicao, status, fogo) {
    const r = await db.prepare(`
      INSERT INTO pneus (
        filial_id, veiculo_id, posicao, status_pneu, ativo, cadastro_completo, numero_fogo, marca
      ) VALUES (?, ?, ?, ?, 1, 1, ?, 'Marca')
    `).run(filialId, veiculoId, posicao, status, fogo);
    return Number(r.lastInsertRowid);
  }

  async function medirPneu(pneuId, data, mm, pressao = null) {
    await db.prepare(`
      INSERT INTO medicoes (
        pneu_id, data_medicao, sulco_externo, sulco_central, sulco_interno, sulco_auxiliar, pressao_psi
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pneuId, data, mm, mm, mm, mm, pressao);
  }

  const filialA = await criarFilial('FA01', 'Filial A');
  const filialB = await criarFilial('FB01', 'Filial B');
  const posicoes = ['1E', '1D', '2E', '2D'];
  const veiculosA = [];
  let pneuPressao = null;
  for (let i = 1; i <= VEICULOS; i += 1) {
    const veiculoId = await criarVeiculo(filialA, `AAA${String(i).padStart(3, '0')}`);
    veiculosA.push(veiculoId);
    for (let p = 0; p < PNEUS_POR_VEICULO; p += 1) {
      const pneuId = await criarPneu(filialA, veiculoId, posicoes[p], 'montado', `FA-${i}-${p}`);
      for (let h = 0; h < HISTORICO; h += 1) await medirPneu(pneuId, '2024-01-01', 14);
      const mm = i % 2 === 0 ? 2 : 12;
      const pressao = pneuPressao ? null : 95;
      await medirPneu(pneuId, '2026-10-20', mm, pressao);
      if (!pneuPressao) pneuPressao = pneuId;
    }
  }
  for (let i = 1; i <= ESTOQUE; i += 1) {
    const id = await criarPneu(filialA, null, null, 'estoque', `EST-${i}`);
    await medirPneu(id, '2026-10-18', 8, 90);
  }
  const veiculoB = await criarVeiculo(filialB, 'BBB001');
  const pneuB = await criarPneu(filialB, veiculoB, '1E', 'montado', 'FB-1');
  await medirPneu(pneuB, '2026-10-20', 4, 80);

  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES ('filial_a', ?, 'filial', 'filial', ?, 1)
  `).run(hash, filialA);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES ('filial_b', ?, 'filial', 'filial', ?, 1)
  `).run(hash, filialB);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES ('gerente_teste', ?, 'gerente', 'gerente_filial', ?, 1)
  `).run(hash, filialA);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES ('presidente_teste', ?, 'presidente', 'presidente', NULL, 1)
  `).run(hash);

  const app = express();
  app.use(express.json());
  app.use('/api/auth', (await import('../src/routes/auth.js')).default);
  app.use('/api/veiculos', (await import('../src/routes/veiculos.js')).default);
  app.use('/api/pneus', (await import('../src/routes/pneus.js')).default);
  app.use('/api/dashboard', (await import('../src/routes/dashboard.js')).default);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ erro: err.message || 'erro' });
  });
  const http = app.listen(0);
  const base = `http://127.0.0.1:${http.address().port}/api`;

  async function req(caminho, token) {
    const res = await fetch(`${base}${caminho}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const texto = await res.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto }; }
    return { status: res.status, dados, bytes: Buffer.byteLength(texto) };
  }

  async function tokenDe(login) {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, senha: SENHA }),
    });
    const dados = await res.json();
    assert.equal(res.status, 200, dados.erro || login);
    return dados.token;
  }

  try {
    const tokenA = await tokenDe('filial_a');
    const tokenB = await tokenDe('filial_b');
    const tokenAdmin = await tokenDe('admin');
    const tokenGerente = await tokenDe('gerente_teste');
    const tokenPresidente = await tokenDe('presidente_teste');

    const cheio = await medir(() => req('/veiculos', tokenA));
    assert.equal(cheio.valor.status, 200);
    assert.ok(Array.isArray(cheio.valor.dados), 'sem paginação a lista continua um array');
    assert.equal(cheio.valor.dados.length, VEICULOS);
    const idsCheios = cheio.valor.dados.map((v) => Number(v.id));

    const pagina1 = await medir(() => req('/veiculos?limite=8&pagina=1', tokenA));
    const pagina2 = await req('/veiculos?limite=8&pagina=2', tokenA);
    const pagina3 = await req('/veiculos?limite=8&pagina=3', tokenA);
    assert.equal(pagina1.valor.status, 200);
    assert.equal(Array.isArray(pagina1.valor.dados), false);
    assert.equal(pagina1.valor.dados.total, VEICULOS);
    assert.equal(pagina1.valor.dados.itens.length, 8);
    assert.equal(pagina2.dados.itens.length, 8);
    assert.equal(pagina3.dados.itens.length, 2);
    const idsPagina = [...pagina1.valor.dados.itens, ...pagina2.dados.itens, ...pagina3.dados.itens]
      .map((v) => Number(v.id));
    assert.deepEqual(idsPagina, idsCheios);
    const porId = new Map(cheio.valor.dados.map((v) => [Number(v.id), v]));
    for (const item of pagina1.valor.dados.itens) {
      const original = porId.get(Number(item.id));
      assert.equal(item.menor_sulco, original.menor_sulco);
      assert.equal(item.status_sulco, original.status_sulco);
      assert.equal(Number(item.total_pneus), Number(original.total_pneus));
    }
    const busca = await req('/veiculos?limite=8&pagina=1&q=AAA001', tokenA);
    assert.equal(busca.dados.total, 1);
    assert.equal(busca.dados.itens[0].placa, 'AAA001');
    const outraFilial = await req('/veiculos?limite=50&pagina=1', tokenB);
    assert.deepEqual(outraFilial.dados.itens.map((v) => v.placa), ['BBB001']);

    const pneusCheios = await medir(() => req('/pneus?status=estoque', tokenA));
    assert.ok(Array.isArray(pneusCheios.valor.dados));
    assert.equal(pneusCheios.valor.dados.length, ESTOQUE);
    const pneusPagina = await medir(() => req('/pneus?status=estoque&limite=8&pagina=1', tokenA));
    assert.equal(pneusPagina.valor.dados.total, ESTOQUE);
    assert.equal(pneusPagina.valor.dados.itens.length, 8);
    const primeiro = pneusPagina.valor.dados.itens[0];
    assert.ok(primeiro.numero_fogo);
    assert.equal(primeiro.ultima_medicao.sulco_externo, 8);
    assert.equal(primeiro.ultima_medicao.sulco_central, 8);
    assert.equal(primeiro.ultima_medicao.sulco_interno, 8);
    assert.equal(primeiro.ultima_medicao.sulco_auxiliar, 8);
    assert.equal(Number(primeiro.ultima_medicao.pressao_psi), 90);
    const idsPneus = pneusCheios.valor.dados.map((p) => Number(p.id));
    const idsPneusPagina = [];
    for (let pagina = 1; pagina <= 2; pagina += 1) {
      const pedaco = await req(`/pneus?status=estoque&limite=8&pagina=${pagina}`, tokenA);
      idsPneusPagina.push(...pedaco.dados.itens.map((p) => Number(p.id)));
    }
    assert.deepEqual(idsPneusPagina, idsPneus.slice(0, 16));
    const pneusB = await req('/pneus?status=montado&limite=20', tokenB);
    assert.deepEqual(pneusB.dados.itens.map((p) => p.numero_fogo), ['FB-1']);

    const resumoCheio = await medir(() => req('/dashboard/resumo', tokenA));
    const resumoLeve = await medir(() => req('/dashboard/resumo?sem_pneus=1', tokenA));
    assert.equal(resumoCheio.valor.status, 200);
    assert.equal(resumoLeve.valor.dados.pneus_omitidos, true);
    assert.equal(resumoLeve.valor.dados.veiculos_ativos, resumoCheio.valor.dados.veiculos_ativos);
    assert.equal(resumoLeve.valor.dados.pneus_ok, resumoCheio.valor.dados.pneus_ok);
    assert.equal(resumoLeve.valor.dados.pneus_alerta, resumoCheio.valor.dados.pneus_alerta);
    assert.equal(resumoLeve.valor.dados.pneus_critico, resumoCheio.valor.dados.pneus_critico);
    assert.equal(resumoLeve.valor.dados.pneus_total, resumoCheio.valor.dados.pneus_total);
    assert.ok(resumoLeve.valor.dados.veiculos.every((v) => (v.pneus || []).length === 0));
    assert.ok(resumoCheio.valor.dados.veiculos.some((v) => (v.pneus || []).length === PNEUS_POR_VEICULO));
    const quatro = resumoLeve.valor.dados.veiculos.slice(0, 4).map((v) => v.id);
    const desenhos = await medir(() => req(`/dashboard/desenhos?ids=${quatro.join(',')},${veiculoB}`, tokenA));
    assert.equal(desenhos.valor.dados.veiculos.length, 4);
    assert.equal(desenhos.valor.dados.veiculos.some((v) => Number(v.id) === veiculoB), false);
    for (const desenho of desenhos.valor.dados.veiculos) {
      assert.equal(desenho.pneus.length, PNEUS_POR_VEICULO);
      for (const pneu of desenho.pneus) {
        assert.ok(pneu.numero_fogo);
        assert.ok(pneu.status_sulco);
        assert.notEqual(pneu.menor_sulco, null);
      }
    }
    const indice = await req('/dashboard/resumo?somente_indice=1', tokenA);
    assert.equal(indice.dados.indice.length, VEICULOS * PNEUS_POR_VEICULO);
    assert.ok(indice.dados.indice.every((p) => p.numero_fogo && p.posicao));

    const detalhe = await req(`/veiculos/${veiculosA[0]}`, tokenA);
    assert.equal(detalhe.status, 200);
    assert.equal(detalhe.dados.pneus.length, PNEUS_POR_VEICULO);
    assert.ok(detalhe.dados.posicoes_layout.length > detalhe.dados.pneus.length);
    assert.ok(detalhe.dados.posicoes_layout.some((pos) => pos.montado === false));
    const pneuDetalhe = detalhe.dados.pneus.find((p) => Number(p.id) === pneuPressao);
    assert.equal(pneuDetalhe.ultima_medicao.sulco_externo, pneuDetalhe.ultima_medicao.sulco_interno);
    assert.equal(Number(pneuDetalhe.ultima_medicao.pressao_psi), 95);
    assert.ok(pneuDetalhe.numero_fogo);

    for (const token of [tokenAdmin, tokenGerente, tokenPresidente]) {
      for (const caminho of [
        '/veiculos',
        '/veiculos?limite=8',
        '/pneus?status=estoque',
        '/pneus?status=estoque&limite=8',
        '/dashboard/resumo',
        '/dashboard/resumo?sem_pneus=1',
        '/dashboard/desenhos?ids=1',
      ]) {
        const resposta = await req(caminho, token);
        assert.equal(resposta.status, 403, caminho);
      }
    }
    for (const caminho of ['/veiculos?limite=8', '/pneus?limite=8', '/dashboard/resumo?sem_pneus=1']) {
      assert.equal((await req(caminho)).status, 401, caminho);
    }

    const relatorio = {
      veiculos: {
        antes: { itens: cheio.valor.dados.length, bytes: cheio.valor.bytes, tempo_ms: Math.round(cheio.tempo), consultas: cheio.consultas, heap: cheio.heap },
        depois: { itens: pagina1.valor.dados.itens.length, total: pagina1.valor.dados.total, bytes: pagina1.valor.bytes, tempo_ms: Math.round(pagina1.tempo), consultas: pagina1.consultas, heap: pagina1.heap },
      },
      pneus: {
        antes: { itens: pneusCheios.valor.dados.length, bytes: pneusCheios.valor.bytes, tempo_ms: Math.round(pneusCheios.tempo), consultas: pneusCheios.consultas, heap: pneusCheios.heap },
        depois: { itens: pneusPagina.valor.dados.itens.length, total: pneusPagina.valor.dados.total, bytes: pneusPagina.valor.bytes, tempo_ms: Math.round(pneusPagina.tempo), consultas: pneusPagina.consultas, heap: pneusPagina.heap },
      },
      frota_ilustrada: {
        antes: { veiculos: resumoCheio.valor.dados.veiculos.length, bytes: resumoCheio.valor.bytes, tempo_ms: Math.round(resumoCheio.tempo), heap: resumoCheio.heap },
        depois_resumo: { veiculos_com_pneus: 0, bytes: resumoLeve.valor.bytes, tempo_ms: Math.round(resumoLeve.tempo), heap: resumoLeve.heap },
        depois_desenhos: { veiculos: desenhos.valor.dados.veiculos.length, bytes: desenhos.valor.bytes, tempo_ms: Math.round(desenhos.tempo) },
      },
    };
    console.log(JSON.stringify(relatorio, null, 2));
    console.log('test:frota-pagina ok');
  } finally {
    await new Promise((resolve) => http.close(resolve));
    await closePool();
    await socket.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
