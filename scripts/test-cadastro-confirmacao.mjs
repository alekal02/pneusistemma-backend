/**
 * Cadastro de veículo e pneu: confirmação, duplicidade e link já usado.
 * PGlite isolado — não altera o banco real.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55449;
const toFileUrl = (p) => pathToFileURL(p).href;

let oks = 0;
let fails = 0;

function log(ok, rotulo, extra = '') {
  if (ok) oks += 1;
  else fails += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${rotulo}${extra ? ` → ${extra}` : ''}`);
}

async function iniciarPglite() {
  const { PGlite } = await import(toFileUrl(path.join(PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist/index.js')));
  const { PGLiteSocketServer } = await import(toFileUrl(path.join(PGLITE_DIR, 'node_modules/@electric-sql/pglite-socket/dist/index.js')));
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  return server;
}

async function main() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'cadastro-confirmacao';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';

  const pg = await iniciarPglite();
  const { initDatabase, getDb } = await import('../src/database.js');
  await initDatabase();

  const authRouter = (await import('../src/routes/auth.js')).default;
  const veiculosRouter = (await import('../src/routes/veiculos.js')).default;
  const pneusRouter = (await import('../src/routes/pneus.js')).default;
  const acessoRouter = (await import('../src/routes/acesso-rapido.js')).default;
  const { gerarTokenAcessoRapido } = await import('../src/services/acesso-rapido.js');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/veiculos', veiculosRouter);
  app.use('/api/pneus', pneusRouter);
  app.use('/api/acesso-rapido', acessoRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ erro: err.message || 'erro' });
  });
  const http = app.listen(0);
  const base = `http://127.0.0.1:${http.address().port}/api`;

  async function req(metodo, caminho, { token, body } = {}) {
    const res = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const texto = await res.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto }; }
    return { status: res.status, dados };
  }

  const login = await req('POST', '/auth/login', { body: { login: 'matriz', senha: 'matriz123' } });
  log(login.status === 200 && login.dados?.token, 'Login da unidade', login.status !== 200 ? JSON.stringify(login.dados) : '');
  const token = login.dados?.token;
  const db = getDb();

  const placa = 'CAD9T01';
  const criado = await req('POST', '/veiculos', {
    token,
    body: { placa, tipo: 'Truck / Tração', layout_pneus: 'truck_10', km_atual: 10 },
  });
  log(criado.status === 201 && criado.dados?.id && /cadastrado/i.test(criado.dados.mensagem || ''), 'POST veículo confirma id e mensagem', JSON.stringify(criado.dados));

  const lido = await req('GET', `/veiculos/${criado.dados?.id}`, { token });
  log(lido.status === 200 && lido.dados?.placa === placa, 'GET confirma o veículo gravado', lido.dados?.placa);

  const dup = await req('POST', '/veiculos', {
    token,
    body: { placa: placa.toLowerCase(), tipo: 'Truck / Tração', layout_pneus: 'truck_10' },
  });
  const nVeic = await db.prepare(`SELECT COUNT(*) AS n FROM veiculos WHERE UPPER(placa) = ?`).get(placa);
  log(dup.status === 409 && dup.dados?.codigo === 'duplicado' && Number(dup.dados?.id) === Number(criado.dados?.id) && Number(nVeic.n) === 1, 'Placa repetida não duplica e devolve o id existente', JSON.stringify(dup.dados));

  const pneu = await req('POST', '/pneus', {
    token,
    body: { modelo: 'X Multi', tipo_pneu: 'misto', condicao: 'novo' },
  });
  const fogo = pneu.dados?.pneu?.numero_fogo;
  const mov = pneu.dados?.pneu?.id
    ? await db.prepare(`SELECT COUNT(*) AS n FROM movimentacoes WHERE pneu_id = ? AND tipo = 'entrada_estoque'`).get(pneu.dados.pneu.id)
    : { n: 0 };
  log(pneu.status === 201 && pneu.dados?.pneu?.id && Number(mov.n) === 1, 'POST pneu confirma id e movimentação', JSON.stringify(pneu.dados)?.slice(0, 180));

  const dupPneu = await req('POST', '/pneus', {
    token,
    body: { numero_fogo: fogo, modelo: 'Outro', tipo_pneu: 'misto', condicao: 'novo' },
  });
  const nPneu = await db.prepare(`SELECT COUNT(*) AS n FROM pneus WHERE numero_fogo = ?`).get(fogo);
  log(dupPneu.status === 409 && dupPneu.dados?.codigo === 'duplicado' && Number(nPneu.n) === 1, 'Fogo repetido não duplica', JSON.stringify(dupPneu.dados));

  const filial = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ' OR id = 1 ORDER BY id LIMIT 1`).get();
  const link = await gerarTokenAcessoRapido({ tipo: 'cadastrar_veiculo', filialId: filial.id });
  const ar1 = await req('POST', '/acesso-rapido/veiculo', {
    body: {
      token: link.token,
      placa: 'CAD9T02',
      tipo: 'truck_tracao',
      marca: 'Mercedes',
      modelo: 'Atego',
      layout_pneus: 'truck_10',
    },
  });
  log(ar1.status === 201 && ar1.dados?.veiculo_id, 'Link de cadastro grava e confirma', JSON.stringify(ar1.dados));

  const ar2 = await req('POST', '/acesso-rapido/veiculo', {
    body: {
      token: link.token,
      placa: 'CAD9T03',
      tipo: 'truck_tracao',
      marca: 'Volvo',
      modelo: 'FH',
      layout_pneus: 'truck_10',
    },
  });
  const nAr = await db.prepare(`SELECT COUNT(*) AS n FROM veiculos WHERE placa IN ('CAD9T02', 'CAD9T03')`).get();
  log(ar2.status === 200 && ar2.dados?.ja_gravado === true && Number(nAr.n) === 1, 'Reenvio do link confirma o já gravado, sem segundo veículo', JSON.stringify(ar2.dados));

  const arGet = await req('GET', `/acesso-rapido?token=${link.token}`);
  log(arGet.status === 200 && arGet.dados?.ja_gravado === true, 'Reabrir o link não informa falha', arGet.dados?.mensagem);

  const linkPneu = await gerarTokenAcessoRapido({ tipo: 'cadastrar_pneu', filialId: filial.id });
  const arPneu = await req('POST', '/acesso-rapido/pneu', {
    body: { token: linkPneu.token, modelo: 'XZY', tipo_pneu: 'misto', condicao: 'novo' },
  });
  const arPneu2 = await req('POST', '/acesso-rapido/pneu', {
    body: { token: linkPneu.token, modelo: 'OUTRO', tipo_pneu: 'direcional', condicao: 'novo' },
  });
  const fogoLink = arPneu.dados?.pneu?.numero_fogo;
  const nLinkPneu = fogoLink
    ? await db.prepare(`SELECT COUNT(*) AS n FROM pneus WHERE numero_fogo = ?`).get(fogoLink)
    : { n: 0 };
  log(
    arPneu.status === 201 && arPneu.dados?.pneu?.id && arPneu2.status === 200 && arPneu2.dados?.ja_gravado === true && Number(nLinkPneu.n) === 1,
    'Link de pneu confirma e o reenvio não duplica',
    JSON.stringify(arPneu2.dados)
  );

  const linkDup = await gerarTokenAcessoRapido({ tipo: 'cadastrar_veiculo', filialId: filial.id });
  const arDup = await req('POST', '/acesso-rapido/veiculo', {
    body: {
      token: linkDup.token, placa: 'CAD9T02', tipo: 'truck_tracao',
      marca: 'Scania', modelo: 'R450', layout_pneus: 'truck_10',
    },
  });
  const tokenAindaLivre = await db.prepare(`SELECT usado_em FROM tokens_acesso_rapido WHERE token = ?`).get(linkDup.token);
  log(
    arDup.status === 409 && !tokenAindaLivre?.usado_em,
    'Placa repetida no link recusa sem consumir o token',
    JSON.stringify(arDup.dados)
  );

  const corrida = await Promise.all([
    req('POST', '/veiculos', { token, body: { placa: 'CAD9RACE', tipo: 'Truck / Tração', layout_pneus: 'truck_10' } }),
    req('POST', '/veiculos', { token, body: { placa: 'cad9race', tipo: 'Truck / Tração', layout_pneus: 'truck_10' } }),
  ]);
  const nRace = await db.prepare(`SELECT COUNT(*) AS n FROM veiculos WHERE UPPER(placa) = 'CAD9RACE'`).get();
  const statusRace = corrida.map((r) => r.status).sort();
  log(
    statusRace[0] === 201 && statusRace[1] === 409 && Number(nRace.n) === 1,
    'Dois envios simultâneos da mesma placa geram um só veículo',
    statusRace.join(',')
  );

  const pneuMontar = await req('POST', '/pneus', {
    token,
    body: { modelo: 'Montagem', tipo_pneu: 'misto', condicao: 'novo' },
  });
  const idMontar = pneuMontar.dados?.pneu?.id;
  const montou = await req('POST', `/pneus/${idMontar}/montar`, {
    token,
    body: { veiculo_id: criado.dados.id, posicao: '2EE' },
  });
  const estadoMontado = await db.prepare(`SELECT status_pneu, posicao, veiculo_id FROM pneus WHERE id = ?`).get(idMontar);
  const movMont = await db.prepare(`SELECT COUNT(*) AS n FROM movimentacoes WHERE pneu_id = ? AND tipo = 'montagem'`).get(idMontar);
  log(
    montou.status === 200 && estadoMontado?.status_pneu === 'montado' && estadoMontado?.posicao === '2EE' && Number(movMont.n) === 1,
    'Montagem confirma posição, status e movimentação',
    montou.dados?.mensagem || montou.dados?.erro
  );
  const montouDeNovo = await req('POST', `/pneus/${idMontar}/montar`, {
    token,
    body: { veiculo_id: criado.dados.id, posicao: '2EI' },
  });
  log(montouDeNovo.status === 400, 'Pneu já montado não muda de posição por esta rota', montouDeNovo.dados?.erro);

  const recap = await req('POST', '/pneus', {
    token,
    body: { modelo: 'Recap dianteira', tipo_pneu: 'misto', condicao: 'recapado' },
  });
  const recapMont = await req('POST', `/pneus/${recap.dados?.pneu?.id}/montar`, {
    token,
    body: { veiculo_id: criado.dados.id, posicao: '1E' },
  });
  const recapEstado = await db.prepare(`SELECT status_pneu, veiculo_id FROM pneus WHERE id = ?`).get(recap.dados?.pneu?.id);
  log(
    recapMont.status === 400 && recapEstado?.status_pneu === 'estoque' && recapEstado?.veiculo_id == null,
    'Recapado continua proibido na dianteira e permanece no estoque',
    recapMont.dados?.erro
  );

  const ops = await import('../src/services/whatsapp-ops.js');
  let rollbackErro = null;
  try {
    await db.transaction(async () => {
      await ops.criarVeiculo(filial.id, {
        placa: 'CAD9RB', tipo: 'Truck / Tração', layout_pneus: 'truck_10', marca: 'X', modelo: 'Y',
      });
      throw new Error('falha simulada apos insert');
    });
  } catch (err) {
    rollbackErro = err.message;
  }
  const nRb = await db.prepare(`SELECT COUNT(*) AS n FROM veiculos WHERE placa = 'CAD9RB'`).get();
  log(/falha simulada/.test(rollbackErro || '') && Number(nRb.n) === 0, 'Rollback desfaz o veículo se o passo seguinte falha');

  let rollbackPneu = null;
  try {
    await db.transaction(async () => {
      await ops.criarPneuEstoque(filial.id, { modelo: 'Rollback', tipo_pneu: 'misto', condicao: 'novo', auditoria: { login: 'teste' } });
      throw new Error('falha simulada apos pneu');
    });
  } catch (err) {
    rollbackPneu = err.message;
  }
  const nRbPneu = await db.prepare(`SELECT COUNT(*) AS n FROM pneus WHERE modelo = 'Rollback'`).get();
  log(/falha simulada/.test(rollbackPneu || '') && Number(nRbPneu.n) === 0, 'Rollback desfaz o pneu e a movimentação se o passo seguinte falha');

  await db.exec('ALTER TABLE movimentacoes RENAME TO movimentacoes_off');
  let postComTabelaOff = null;
  try {
    postComTabelaOff = await req('POST', '/pneus', {
      token,
      body: { modelo: 'SemMov', tipo_pneu: 'misto', condicao: 'novo' },
    });
  } finally {
    await db.exec('ALTER TABLE movimentacoes_off RENAME TO movimentacoes');
  }
  const nSemMov = await db.prepare(`SELECT COUNT(*) AS n FROM pneus WHERE modelo = 'SemMov'`).get();
  log(
    postComTabelaOff?.status === 500 && Number(nSemMov.n) === 0,
    'POST /pneus: falha na movimentação não deixa pneu gravado',
    postComTabelaOff?.dados?.erro
  );

  const pre = await ops.criarVeiculo(filial.id, { placa: 'CAD9PRE', tipo: 'Truck / Tração', preCadastro: true });
  const preRow = await db.prepare(`SELECT cadastro_completo FROM veiculos WHERE id = ?`).get(pre.id);
  const pneuPre = await req('POST', '/pneus', {
    token,
    body: { modelo: 'Pre', tipo_pneu: 'misto', condicao: 'novo' },
  });
  const montaPre = await req('POST', `/pneus/${pneuPre.dados?.pneu?.id}/montar`, {
    token,
    body: { veiculo_id: pre.id, posicao: '2EE' },
  });
  log(
    Number(preRow?.cadastro_completo) === 0 && montaPre.status === 400 && /pré-cadastro/i.test(montaPre.dados?.erro || ''),
    'Pré-cadastro continua incompleto e não aceita montagem',
    montaPre.dados?.erro
  );

  http.close();
  await pg.stop();
  console.log(`\n${oks} ok, ${fails} falha(s)`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
