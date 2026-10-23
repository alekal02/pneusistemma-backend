/**
 * Regressão, autorização e desempenho de GET /api/filiais
 * e GET /api/filiais/compras/consolidado.
 *
 * Banco: PGlite em memória, só em 127.0.0.1.
 * Não abre Neon, não altera dado operacional e não cria índice novo.
 *
 * node --expose-gc scripts/test-filiais-carregamento.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import express from 'express';
import bcrypt from 'bcryptjs';

const PGLITE = 'C:/Projetos/pneu-main/backend/node_modules/@electric-sql/pglite/dist/index.js';
const SOCKET = 'C:/Projetos/pneu-main/backend/node_modules/@electric-sql/pglite-socket/dist/index.js';
const PG_PORT = 55481;
const SENHA = 'teste-local-filiais';
const FILIAIS = 12;
const MEDICOES_ANTIGAS = 12;
const ATRASO_REDE_MS = 2;

const medidor = { ativo: false, atrasoMs: 0, consultas: [] };

function classificar(consultas) {
  const sqls = consultas.map((c) => c.sql);
  return {
    total: sqls.length,
    medicoes: sqls.filter((s) => /\bmedicoes\b/i.test(s)).length,
    repetidaPorFilial: sqls.filter((s) => /filial_id\s*=\s*\$\d+/i.test(s)).length,
    agrupada: sqls.filter((s) => /filial_id\s+IN\s*\(/i.test(s)).length,
  };
}

function idsDeFilial(consultas) {
  const ids = new Set();
  for (const c of consultas) {
    if (/sessoes_login/i.test(c.sql)) continue;
    if (!/\bfilial_id\b|\bfiliais\b/i.test(c.sql)) continue;
    for (const p of c.params || []) {
      if (typeof p === 'number' && Number.isInteger(p)) ids.add(p);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

async function medir(fn, { atrasoMs = 0 } = {}) {
  medidor.consultas = [];
  medidor.atrasoMs = atrasoMs;
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
      consultas: medidor.consultas.slice(),
      classe: classificar(medidor.consultas),
    };
  } finally {
    medidor.ativo = false;
    medidor.atrasoMs = 0;
  }
}

function resumoMedicao(nome, med) {
  return {
    cenario: nome,
    consultas: med.classe.total,
    consultas_medicao: med.classe.medicoes,
    consultas_por_filial: med.classe.repetidaPorFilial,
    consultas_agrupadas: med.classe.agrupada,
    tempo_ms: Math.round(med.tempo * 10) / 10,
    heap_delta_bytes: med.heap,
  };
}

function porId(lista) {
  return [...(lista || [])].sort((a, b) => Number(a.pneu_id) - Number(b.pneu_id));
}

function canonPendencias(p) {
  return {
    troca: porId(p.troca),
    monitorar: porId(p.monitorar),
    diagnosticos: porId(p.diagnosticos),
    todos: porId(p.todos),
    recap: p.recap,
  };
}

function esperadoResumo(recap) {
  return {
    veiculos_ativos: 3,
    pneus_total: 5,
    pneus_ok: 1,
    pneus_alerta: 2,
    pneus_critico: 2,
    pneus_sem_dado: 0,
    pneus_em_recapagem: recap,
    pneus_em_descarte: 1,
    pneus_em_estoque: 1,
    compras: {
      pneus_para_comprar: 2,
      pneus_para_recap: recap,
      pneus_monitorar: 2,
    },
  };
}

function afirmarResumo(resumo, recap, rotulo) {
  const esp = esperadoResumo(recap);
  for (const [chave, valor] of Object.entries(esp)) {
    if (chave === 'compras') {
      assert.deepEqual(resumo.compras, valor, rotulo);
    } else {
      assert.equal(resumo[chave], valor, `${rotulo} ${chave}`);
    }
  }
  assert.equal(resumo.ultima_medicao, '2026-10-18', rotulo);
  const diff = Date.now() - new Date(`${resumo.ultima_medicao}T12:00:00`).getTime();
  const dias = Math.floor(diff / (1000 * 60 * 60 * 24));
  assert.equal(resumo.dias_sem_medicao, dias, rotulo);
  assert.equal(resumo.precisa_medir_semana, dias >= 7, rotulo);
  assert.equal(resumo.indicadores_uso.km.veiculos, 2, rotulo);
  assert.equal(resumo.indicadores_uso.horas.veiculos, 1, rotulo);
  assert.equal(resumo.indicadores_uso.km.critico, 2, rotulo);
  assert.equal(resumo.indicadores_uso.km.monitorar, 2, rotulo);
  assert.equal(resumo.indicadores_uso.horas.ok, 1, rotulo);
  assert.equal(resumo.acoes.troca, 2, rotulo);
  assert.equal(resumo.acoes.recap, recap, rotulo);
}

function afirmarUltimaMedicao(pendencias, rotulo) {
  assert.equal(pendencias.troca.length, 2, rotulo);
  for (const item of pendencias.troca) {
    assert.equal(item.menor_sulco, 2, rotulo);
    assert.equal(item.data_medicao, '2026-10-01', rotulo);
    assert.equal(item.sulcos.m1, 2, rotulo);
    assert.equal(contarLegado(item.acao_sugerida), 'troca', rotulo);
  }
  assert.equal(pendencias.monitorar.length, 2, rotulo);
  for (const item of pendencias.monitorar) {
    assert.equal(item.menor_sulco, 5, rotulo);
    assert.equal(item.data_medicao, '2026-10-10', rotulo);
    assert.equal(item.sulcos.m1, 5, rotulo);
  }
}

function contarLegado(codigo) {
  if (codigo === 'troca' || codigo === 'substituir' || codigo === 'corte' || codigo === 'dano_lateral') {
    return 'troca';
  }
  return codigo;
}

async function iniciarPglite() {
  const { PGlite } = await import(pathToFileURL(PGLITE).href);
  const { PGLiteSocketServer } = await import(pathToFileURL(SOCKET).href);
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({
    db,
    port: PG_PORT,
    host: '127.0.0.1',
    maxConnections: 20,
  });
  await server.start();
  return server;
}

async function main() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'teste-local-filiais-jwt';
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = SENHA;
  process.env.FRONTEND_URL = 'http://127.0.0.1:5173';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';

  if (!/127\.0\.0\.1|localhost/i.test(process.env.DATABASE_URL)) {
    throw new Error('Teste recusado: o banco não é local.');
  }

  const pg = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import('../src/database.js');
  const { getPool } = await import('../src/pg-db.js');
  const { limparCacheColunas } = await import('../src/schema-colunas.js');
  const {
    carregarPainelFiliais,
    calcularResumoFilial,
    calcularPendenciasFilial,
    sqlsDoPainel,
  } = await import('../src/services/filiais-painel.js');
  const { filtroCadastroCompleto } = await import('../src/schema-colunas.js');

  await initDatabase();
  const urlUsada = process.env.DATABASE_URL;
  if (!/127\.0\.0\.1/.test(urlUsada)) {
    throw new Error('Teste interrompido: a conexão deixou o localhost.');
  }

  const pool = getPool();
  const queryOriginal = pool.query.bind(pool);
  pool.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text || '');
    const params = Array.isArray(args[1]) ? args[1] : [];
    if (medidor.ativo) {
      medidor.consultas.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (medidor.atrasoMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, medidor.atrasoMs));
      }
    }
    return queryOriginal(...args);
  };

  const db = getDb();
  const hash = bcrypt.hashSync(SENHA, 10);
  const filiaisCriadas = [];

  async function veiculo(filialId, placa, tipo, layout, extra = {}) {
    const r = await db.prepare(`
      INSERT INTO veiculos (placa, tipo, layout_pneus, filial_id, ativo, cadastro_completo, km_atual, hr_atual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      placa,
      tipo,
      layout,
      filialId,
      extra.ativo ?? 1,
      extra.cadastro ?? 1,
      extra.km === undefined ? null : extra.km,
      extra.hr === undefined ? null : extra.hr,
    );
    return Number(r.lastInsertRowid);
  }

  async function pneu(filialId, veiculoId, posicao, status, fogo, extra = {}) {
    const r = await db.prepare(`
      INSERT INTO pneus (
        filial_id, veiculo_id, posicao, status_pneu, ativo, cadastro_completo, numero_fogo, marca, vida_recap
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Marca', ?)
    `).run(
      filialId,
      veiculoId,
      posicao,
      status,
      extra.ativo ?? 1,
      extra.cadastro ?? 1,
      fogo,
      extra.vida ?? 0,
    );
    return Number(r.lastInsertRowid);
  }

  async function medicao(pneuId, data, mm) {
    await db.prepare(`
      INSERT INTO medicoes (
        pneu_id, data_medicao, sulco_externo, sulco_central, sulco_interno, sulco_auxiliar
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(pneuId, data, mm, mm, mm, mm);
  }

  async function historico(pneuId, dataFinal, mmFinal, extra = null) {
    for (let i = 0; i < MEDICOES_ANTIGAS; i += 1) {
      await medicao(pneuId, '2024-01-01', 14);
    }
    await medicao(pneuId, dataFinal, mmFinal);
    if (extra) await medicao(pneuId, extra.data, extra.mm);
  }

  async function recap(filialId, fogo, dataEnvio, placa) {
    const id = await pneu(filialId, null, null, 'recapagem', fogo, { vida: 1 });
    await medicao(id, '2026-07-01', 4);
    await db.prepare(`
      INSERT INTO movimentacoes (pneu_id, tipo, data_evento, veiculo_placa, posicao)
      VALUES (?, 'retirada', '2026-07-20', ?, '2DE')
    `).run(id, placa);
    await db.prepare(`
      INSERT INTO movimentacoes (pneu_id, tipo, data_evento)
      VALUES (?, 'recap', ?)
    `).run(id, dataEnvio);
  }

  for (let n = 1; n <= FILIAIS; n += 1) {
    const codigo = `U${String(n).padStart(2, '0')}`;
    const criada = await db.prepare(`
      INSERT INTO filiais (nome, codigo, contrato, ativo) VALUES (?, ?, 'contrato-teste', 1)
    `).run(`Unidade ${String(n).padStart(2, '0')}`, codigo);
    const filialId = Number(criada.lastInsertRowid);
    filiaisCriadas.push({ id: filialId, codigo, nome: `Unidade ${String(n).padStart(2, '0')}` });

    const truck1 = await veiculo(filialId, `${codigo}T1`, 'Truck / Tração', 'truck_10', { km: 1000 });
    const truck2 = await veiculo(filialId, `${codigo}T2`, 'Truck / Tração', 'truck_10', { km: 1000 });
    const trator = await veiculo(filialId, `${codigo}H1`, 'Trator', 'trator_4', { hr: 50 });
    const incompleto = await veiculo(filialId, `${codigo}X1`, 'Truck / Tração', 'truck_10', { cadastro: 0, km: 1000 });
    const parado = await veiculo(filialId, `${codigo}Z1`, 'Truck / Tração', 'truck_10', { ativo: 0, km: 1000 });

    const c1 = await pneu(filialId, truck1, '1E', 'montado', `${codigo}-C1`);
    const m1 = await pneu(filialId, truck1, '1D', 'montado', `${codigo}-M1`);
    const c2 = await pneu(filialId, truck2, '1E', 'montado', `${codigo}-C2`);
    const m2 = await pneu(filialId, truck2, '1D', 'montado', `${codigo}-M2`);
    const ok = await pneu(filialId, trator, '1E', 'montado', `${codigo}-OK`);
    const escondido = await pneu(filialId, incompleto, '1E', 'montado', `${codigo}-ES`);
    const inativo = await pneu(filialId, parado, '1E', 'montado', `${codigo}-IN`);

    await historico(c1, '2026-10-01', 2, { data: '2026-09-01', mm: 9 });
    await historico(c2, '2026-10-01', 2, { data: '2026-09-01', mm: 9 });
    await historico(m1, '2026-10-10', 1);
    await medicao(m1, '2026-10-10', 5);
    await historico(m2, '2026-10-10', 1);
    await medicao(m2, '2026-10-10', 5);
    await historico(ok, '2026-10-18', 20);
    await medicao(escondido, '2026-10-20', 1);
    await medicao(inativo, '2026-10-21', 1);

    await pneu(filialId, null, null, 'estoque', `${codigo}-E1`);
    await pneu(filialId, null, null, 'estoque', `${codigo}-E0`, { cadastro: 0 });
    await pneu(filialId, null, null, 'estoque', `${codigo}-E2`, { ativo: 0 });
    await pneu(filialId, null, null, 'descarte', `${codigo}-D1`);
    await recap(filialId, `${codigo}-A`, n === 1 ? '2026-08-15' : '2026-08-10', `ORI${codigo}`);
    if (n === 1) await recap(filialId, `${codigo}-B`, '2026-08-01', `ANT${codigo}`);
  }

  const inativa = await db.prepare(`
    INSERT INTO filiais (nome, codigo, contrato, ativo) VALUES ('Z Inativa', 'INATIVA', 'fora', 0)
  `).run();
  const inativaId = Number(inativa.lastInsertRowid);
  const vInativo = await veiculo(inativaId, 'INAT1', 'Truck / Tração', 'truck_10', { km: 1000 });
  const pInativo = await pneu(inativaId, vInativo, '1E', 'montado', 'INATIVA-C');
  await historico(pInativo, '2026-10-01', 2, { data: '2026-09-01', mm: 9 });

  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES ('gerente_u01', ?, 'gerente', 'gerente_filial', ?, 1)
  `).run(hash, filiaisCriadas[0].id);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES ('presidente_teste', ?, 'presidente', 'presidente', NULL, 1)
  `).run(hash);

  const filiaisRouter = (await import('../src/routes/filiais.js')).default;
  const authRouter = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/filiais', filiaisRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ erro: err.message || 'erro' });
  });
  const http = app.listen(0);
  const base = `http://127.0.0.1:${http.address().port}/api`;

  async function req(metodo, caminho, token) {
    const res = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const texto = await res.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto }; }
    return { status: res.status, dados };
  }

  async function tokenDe(login) {
    const senha = login === 'compras' ? 'compras123' : (login === 'matriz' ? 'matriz123' : SENHA);
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, senha }),
    });
    const dados = await res.json();
    assert.equal(res.status, 200, `login ${login}`);
    return dados.token;
  }

  const admin = await tokenDe('admin');
  const gerente = await tokenDe('gerente_u01');
  const compras = await tokenDe('compras');
  const matriz = await tokenDe('matriz');
  const presidente = await tokenDe('presidente_teste');

  const semToken = await req('GET', '/filiais');
  assert.equal(semToken.status, 401);
  const papelFilial = await req('GET', '/filiais', matriz);
  assert.equal(papelFilial.status, 403);
  const papelPresidente = await req('GET', '/filiais', presidente);
  assert.equal(papelPresidente.status, 403);
  const consFilial = await req('GET', '/filiais/compras/consolidado', matriz);
  assert.equal(consFilial.status, 403);

  const idsAtivos = (await db.prepare(`SELECT id FROM filiais WHERE ativo = 1 ORDER BY nome`).all())
    .map((f) => Number(f.id));

  limparCacheColunas();
  const httpLista = await medir(() => req('GET', '/filiais', admin));
  assert.equal(httpLista.valor.status, 200);
  const lista = httpLista.valor.dados;
  assert.equal(lista.length, FILIAIS + 1);
  assert.equal(lista.some((f) => f.codigo === 'INATIVA'), false);
  assert.equal(lista.filter((f) => f.ativo === 1).length, lista.length);

  limparCacheColunas();
  const leve = await medir(() => req('GET', '/filiais?leve=1', admin));
  assert.equal(leve.valor.status, 200);
  assert.equal(leve.valor.dados.length, FILIAIS + 1);
  assert.equal(leve.valor.dados.every((f) => f.resumo == null), true);
  assert.equal(leve.classe.medicoes, 0);
  assert.equal(leve.classe.agrupada, 0);

  limparCacheColunas();
  const servicoLista = await medir(() => carregarPainelFiliais(db, idsAtivos));
  for (const filial of lista) {
    const calc = calcularResumoFilial(servicoLista.valor.get(Number(filial.id)));
    assert.deepEqual(filial.resumo, calc, filial.codigo);
    if (filial.codigo === 'MATRIZ') {
      assert.equal(filial.resumo.veiculos_ativos, 0);
      assert.equal(filial.resumo.pneus_total, 0);
      assert.equal(filial.resumo.ultima_medicao, null);
    } else {
      afirmarResumo(filial.resumo, filial.codigo === 'U01' ? 2 : 1, filial.codigo);
    }
  }

  const idsLista = idsDeFilial(httpLista.consultas);
  assert.deepEqual(idsLista, lista.map((f) => Number(f.id)).sort((a, b) => a - b));
  assert.equal(idsLista.includes(inativaId), false);

  limparCacheColunas();
  const httpCons = await medir(() => req('GET', '/filiais/compras/consolidado', admin));
  assert.equal(httpCons.valor.status, 200);
  const cons = httpCons.valor.dados;
  assert.equal(cons.totais.pneus_para_comprar, FILIAIS * 2);
  assert.equal(cons.totais.pneus_para_recap, 2 + (FILIAIS - 1));
  assert.equal(cons.totais.pneus_monitorar, FILIAIS * 2);
  assert.equal(cons.filiais.length, FILIAIS);
  assert.equal(cons.filiais.some((f) => f.codigo === 'MATRIZ' || f.codigo === 'INATIVA'), false);

  limparCacheColunas();
  const servicoCons = await medir(() => carregarPainelFiliais(db, idsAtivos, { comPendencias: true }));
  for (const filial of cons.filiais) {
    const painel = servicoCons.valor.get(Number(filial.filial_id));
    const pend = calcularPendenciasFilial(painel);
    assert.deepEqual(porId(filial.troca), porId(pend.troca), filial.codigo);
    assert.deepEqual(porId(filial.monitorar), porId(pend.monitorar), filial.codigo);
    assert.deepEqual(filial.recap, pend.recap, filial.codigo);
    assert.deepEqual(filial.compras, calcularResumoFilial(painel).compras, filial.codigo);
    afirmarUltimaMedicao(filial, filial.codigo);
    if (filial.codigo === 'U01') {
      assert.deepEqual(filial.recap.map((r) => r.numero_fogo), ['U01-A', 'U01-B']);
      assert.equal(filial.recap[0].data_medicao, '2026-08-15');
      assert.equal(filial.recap[0].placa, 'ORIU01');
      assert.equal(filial.recap[1].data_medicao, '2026-08-01');
      assert.equal(filial.recap[1].placa, 'ANTU01');
    }
  }

  const u01 = lista.find((f) => f.codigo === 'U01');
  const detalhe = await req('GET', `/filiais/${u01.id}`, admin);
  assert.equal(detalhe.status, 200);
  assert.deepEqual(detalhe.dados.resumo, u01.resumo);
  const painelU01 = servicoCons.valor.get(Number(u01.id));
  assert.deepEqual(
    canonPendencias(detalhe.dados.pendencias),
    canonPendencias(calcularPendenciasFilial(painelU01)),
  );
  afirmarUltimaMedicao(detalhe.dados.pendencias, 'detalhe');
  assert.deepEqual(
    detalhe.dados.pendencias.recap.map((r) => r.numero_fogo),
    ['U01-A', 'U01-B'],
  );

  const soTrator = await req('GET', `/filiais/${u01.id}?${new URLSearchParams({ tipo: 'Trator' })}`, admin);
  assert.equal(soTrator.status, 200);
  assert.equal(soTrator.dados.resumo.veiculos_ativos, 1);
  assert.equal(soTrator.dados.resumo.pneus_total, 1);
  assert.equal(soTrator.dados.resumo.pneus_ok, 1);
  assert.equal(soTrator.dados.resumo.pneus_critico, 0);
  assert.equal(soTrator.dados.pendencias.troca.length, 0);
  assert.deepEqual(soTrator.dados.resumo, calcularResumoFilial(painelU01, 'Trator'));
  assert.deepEqual(
    canonPendencias(soTrator.dados.pendencias),
    canonPendencias(calcularPendenciasFilial(painelU01, 'Trator')),
  );

  const soTruck = await req('GET', `/filiais/${u01.id}?${new URLSearchParams({ tipo: 'Truck / Tração' })}`, admin);
  assert.equal(soTruck.dados.resumo.veiculos_ativos, 2);
  assert.equal(soTruck.dados.resumo.pneus_total, 4);
  assert.equal(soTruck.dados.resumo.pneus_critico, 2);
  assert.equal(soTruck.dados.resumo.pneus_alerta, 2);
  assert.equal(soTruck.dados.resumo.pneus_ok, 0);
  assert.deepEqual(soTruck.dados.resumo, calcularResumoFilial(painelU01, 'Truck / Tração'));

  const detalheInativa = await req('GET', `/filiais/${inativaId}`, admin);
  assert.equal(detalheInativa.status, 200);
  assert.equal(detalheInativa.dados.ativo, 0);
  assert.equal(detalheInativa.dados.resumo.veiculos_ativos, 1);
  assert.equal(detalheInativa.dados.resumo.pneus_critico, 1);

  const gerenteLista = await medir(() => req('GET', '/filiais', gerente));
  assert.equal(gerenteLista.valor.status, 200);
  assert.equal(gerenteLista.valor.dados.length, 1);
  assert.equal(gerenteLista.valor.dados[0].codigo, 'U01');
  assert.deepEqual(idsDeFilial(gerenteLista.consultas), [filiaisCriadas[0].id]);
  const fora = await req('GET', `/filiais/${filiaisCriadas[1].id}`, gerente);
  assert.equal(fora.status, 403);
  const foraCons = await medir(() => req('GET', '/filiais/compras/consolidado', gerente));
  assert.equal(foraCons.valor.dados.filiais.length, 1);
  assert.equal(foraCons.valor.dados.totais.pneus_para_comprar, 2);
  assert.deepEqual(idsDeFilial(foraCons.consultas), [filiaisCriadas[0].id]);

  const comprasLista = await req('GET', '/filiais', compras);
  assert.equal(comprasLista.status, 200);
  assert.equal(comprasLista.dados.length, FILIAIS + 1);

  limparCacheColunas();
  const httpListaAtraso = await medir(() => req('GET', '/filiais', admin), { atrasoMs: ATRASO_REDE_MS });
  limparCacheColunas();
  const servicoListaAtraso = await medir(
    () => carregarPainelFiliais(db, idsAtivos),
    { atrasoMs: ATRASO_REDE_MS },
  );
  limparCacheColunas();
  const httpConsAtraso = await medir(
    () => req('GET', '/filiais/compras/consolidado', admin),
    { atrasoMs: ATRASO_REDE_MS },
  );
  limparCacheColunas();
  const servicoConsAtraso = await medir(
    () => carregarPainelFiliais(db, idsAtivos, { comPendencias: true }),
    { atrasoMs: ATRASO_REDE_MS },
  );
  assert.ok(servicoListaAtraso.tempo < httpListaAtraso.tempo);
  assert.ok(servicoConsAtraso.tempo < httpConsAtraso.tempo);

  limparCacheColunas();
  medidor.consultas = [];
  medidor.ativo = true;
  const tConc = performance.now();
  const lote = await Promise.all(Array.from({ length: 8 }, () => req('GET', '/filiais', admin)));
  const tempoConc = performance.now() - tConc;
  const consultasConc = medidor.consultas.length;
  medidor.ativo = false;
  for (const item of lote) {
    assert.equal(item.status, 200);
    assert.deepEqual(item.dados, lista);
  }

  medidor.consultas = [];
  medidor.ativo = true;
  const mistos = await Promise.all([
    req('GET', '/filiais', admin),
    req('GET', '/filiais', gerente),
    req('GET', '/filiais/compras/consolidado', admin),
    req('GET', '/filiais/compras/consolidado', gerente),
    req('GET', '/filiais', admin),
    req('GET', '/filiais', gerente),
    req('GET', '/filiais/compras/consolidado', admin),
    req('GET', '/filiais/compras/consolidado', gerente),
  ]);
  medidor.ativo = false;
  assert.equal(mistos[1].dados.length, 1);
  assert.equal(mistos[1].dados[0].codigo, 'U01');
  assert.equal(mistos[0].dados.length, FILIAIS + 1);
  assert.equal(mistos[3].dados.totais.pneus_para_comprar, 2);
  assert.equal(mistos[2].dados.totais.pneus_para_comprar, FILIAIS * 2);
  assert.deepEqual(mistos[5].dados, mistos[1].dados);
  assert.deepEqual(mistos[7].dados, mistos[3].dados);

  const vazio = await medir(() => carregarPainelFiliais(db, []));
  assert.equal(vazio.valor.size, 0);
  assert.equal(vazio.classe.total, 0);
  const invalidos = await medir(() => carregarPainelFiliais(db, [null, 'abc', -1, 0]));
  assert.equal(invalidos.valor.size, 0);
  assert.equal(invalidos.classe.total, 0);

  const indexes = await db.prepare(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'idx_medicoes_pneu_recente',
        'idx_pneus_filial',
        'idx_veiculos_filial',
        'idx_movimentacoes_pneu',
        'idx_usuarios_filial'
      )
    ORDER BY indexname
  `).all();
  assert.deepEqual(indexes.map((i) => i.indexname), [
    'idx_medicoes_pneu_recente',
    'idx_movimentacoes_pneu',
    'idx_pneus_filial',
    'idx_usuarios_filial',
    'idx_veiculos_filial',
  ]);

  const cadVeiculo = await filtroCadastroCompleto(db, 'veiculos');
  const cadVeiculoAlias = await filtroCadastroCompleto(db, 'veiculos', 'v.cadastro_completo');
  const cadPneu = await filtroCadastroCompleto(db, 'pneus');
  const sql = sqlsDoPainel({
    cadVeiculo,
    cadVeiculoAlias,
    cadPneu,
    quantidade: idsAtivos.length,
    comPendencias: true,
  });
  await db.exec('SET enable_seqscan = off');
  const planos = {};
  try {
    for (const [nome, texto] of Object.entries(sql)) {
      const linhas = await db.prepare(`EXPLAIN ${texto}`).all(...idsAtivos);
      planos[nome] = linhas.map((l) => l['QUERY PLAN'] || Object.values(l)[0]).join('\n');
    }
  } finally {
    await db.exec('SET enable_seqscan = on');
  }
  assert.match(planos.montados, /Index Scan using idx_medicoes_pneu/);
  assert.match(planos.veiculos, /idx_veiculos_filial/);
  assert.match(planos.contagens, /idx_pneus_filial/);
  assert.match(planos.recaps, /Index Scan using idx_medicoes_pneu/);
  assert.match(planos.recaps, /idx_movimentacoes_pneu/);

  const otimizado = httpLista.classe.agrupada >= 3 && httpCons.classe.agrupada >= 4;
  if (otimizado) {
    assert.ok(httpLista.classe.total <= 8, JSON.stringify(httpLista.classe));
    assert.equal(httpLista.classe.medicoes, 1);
    assert.equal(httpLista.classe.repetidaPorFilial, 0);
    assert.ok(httpCons.classe.total <= 10, JSON.stringify(httpCons.classe));
    assert.equal(httpCons.classe.medicoes, 2);
    assert.equal(httpCons.classe.repetidaPorFilial, 0);
    assert.equal(gerenteLista.classe.repetidaPorFilial, 0);
  }

  const relatorio = {
    otimizado,
    filiais_ativas: idsAtivos.length,
    lista_http: resumoMedicao('lista-http', httpLista),
    lista_servico: resumoMedicao('lista-servico', servicoLista),
    consolidado_http: resumoMedicao('consolidado-http', httpCons),
    consolidado_servico: resumoMedicao('consolidado-servico', servicoCons),
    lista_http_atraso_2ms: resumoMedicao('lista-http-atraso', httpListaAtraso),
    lista_servico_atraso_2ms: resumoMedicao('lista-servico-atraso', servicoListaAtraso),
    consolidado_http_atraso_2ms: resumoMedicao('consolidado-http-atraso', httpConsAtraso),
    consolidado_servico_atraso_2ms: resumoMedicao('consolidado-servico-atraso', servicoConsAtraso),
    concorrencia_8_lista_ms: Math.round(tempoConc * 10) / 10,
    concorrencia_8_consultas: consultasConc,
    indexes: indexes.map((i) => i.indexname),
    planos: {
      montados: (planos.montados.match(/idx_\w+/g) || []).filter((v, i, a) => a.indexOf(v) === i),
      recaps: (planos.recaps.match(/idx_\w+/g) || []).filter((v, i, a) => a.indexOf(v) === i),
      veiculos: (planos.veiculos.match(/idx_\w+/g) || []).filter((v, i, a) => a.indexOf(v) === i),
      contagens: (planos.contagens.match(/idx_\w+/g) || []).filter((v, i, a) => a.indexOf(v) === i),
    },
  };
  console.log(`METRICAS ${JSON.stringify(relatorio)}`);

  http.close();
  await closePool();
  if (pg?.stop) await pg.stop();
  console.log('OK filiais carregamento');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
