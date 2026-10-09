/**
 * Um chatbot para dois grupos de unidades diferentes. PGlite isolado.
 * O número do bot não é operador. Sessões não cruzam.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const BACKEND = 'C:/Projetos/pneusistemma/backend';
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55458;
const BOT = '5511900001111';
const toFileUrl = (p) => pathToFileURL(p).href;

let oks = 0;
let fails = 0;
const falhas = [];

function log(ok, rotulo, extra = '') {
  if (ok) oks += 1;
  else {
    fails += 1;
    falhas.push(extra ? `${rotulo} → ${extra}` : rotulo);
  }
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${rotulo}${extra ? ` → ${extra}` : ''}`);
}

async function iniciarPglite() {
  const pglitePkg = path.join(PGLITE_DIR, 'node_modules/@electric-sql/pglite');
  const socketPkg = path.join(PGLITE_DIR, 'node_modules/@electric-sql/pglite-socket');
  const { PGlite } = await import(toFileUrl(path.join(pglitePkg, 'dist/index.js')));
  const { PGLiteSocketServer } = await import(toFileUrl(path.join(socketPkg, 'dist/index.js')));
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  return { server };
}

function evento({ grupo, remetente, texto, id, fromMe = false, senderBot = false }) {
  return {
    type: 'Message',
    event: {
      Info: {
        Chat: grupo,
        Sender: senderBot ? `${BOT}@s.whatsapp.net` : `${remetente}@s.whatsapp.net`,
        SenderAlt: senderBot ? `${BOT}@lid` : `${remetente}@s.whatsapp.net`,
        IsGroup: true,
        IsFromMe: fromMe,
        ID: id,
      },
      Message: { conversation: texto },
    },
  };
}

async function main() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'dois-grupos';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
  delete process.env.WUZAPI_WEBHOOK_SECRET;
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { obterSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));
  const webhook = (await import(toFileUrl(path.join(BACKEND, 'src/routes/webhook.js')))).default;

  await initDatabase();
  const db = getDb();
  const a = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  await db.prepare(`INSERT INTO filiais (nome, codigo, ativo) VALUES (?, ?, 1)`).run('Unidade B', 'UNB');
  const b = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'UNB'`).get()).id;
  const grupoA = '120363100000000001@g.us';
  const grupoB = '120363100000000002@g.us';
  await db.prepare(`UPDATE filiais SET whatsapp = ?, whatsapp_grupo = ? WHERE id = ?`).run(BOT, grupoA, a);
  await db.prepare(`UPDATE filiais SET whatsapp = ?, whatsapp_grupo = ? WHERE id = ?`).run(BOT, grupoB, b);

  const opA = '5511911110001';
  const opB = '5511922220002';
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
    VALUES ('opa', 'x', 'filial', 'funcionario', ?, 1, ?)
  `).run(a, opA);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
    VALUES ('opb', 'x', 'filial', 'funcionario', ?, 1, ?)
  `).run(b, opB);
  const botUsuario = await db.prepare(`
    SELECT COUNT(*) AS n FROM usuarios WHERE regexp_replace(COALESCE(whatsapp, ''), '[^0-9]', '', 'g') = ?
  `).get(BOT);
  log(Number(botUsuario.n) === 0, 'Número do chatbot não está em usuarios.whatsapp');

  const truckA = await ops.criarVeiculo(a, { placa: 'AAA1A23', tipo: 'Truck / Tração', km_atual: 1000 });
  const truckB = await ops.criarVeiculo(b, { placa: 'BBB2B34', tipo: 'Truck / Tração', km_atual: 1000 });
  const pneuA = await ops.criarPneuEstoque(a, {
    numero_fogo: 'MATRIZ-8801', modelo: 'A', tipo_pneu: 'direcional', condicao: 'novo', sulco_inicial_mm: 16,
  });
  const pneuB = await ops.criarPneuEstoque(b, {
    numero_fogo: 'UNB-8802', modelo: 'B', tipo_pneu: 'direcional', condicao: 'novo', sulco_inicial_mm: 16,
  });
  await ops.montarPneu({ filialId: a, pneuId: pneuA.id, veiculoId: truckA.id, posicao: '1E' });
  await ops.montarPneu({ filialId: b, pneuId: pneuB.id, veiculoId: truckB.id, posicao: '1E' });

  const app = express();
  app.use(express.json());
  app.use('/api/webhook', webhook);
  const http = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const base = `http://127.0.0.1:${http.address().port}/api/webhook/whatsapp`;

  async function post(body) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dados = await res.json();
    return { status: res.status, dados };
  }
  async function qtd(id) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM medicoes WHERE pneu_id = ?`).get(id);
    return Number(row.n || 0);
  }
  async function esperar(cond, ms = 5000) {
    const inicio = Date.now();
    while (Date.now() - inicio < ms) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  }

  const fora = await post(evento({
    grupo: '120363100000000099@g.us', remetente: opA, texto: 'menu', id: 'fora',
  }));
  log(fora.dados.ignored === 'grupo_nao_selecionado', 'Grupo sem cadastro é ignorado');

  const eco = await post(evento({
    grupo: grupoA, remetente: opA, texto: 'AAA1A23 1E 3 3 3', id: 'eco-bot', fromMe: true, senderBot: true,
  }));
  log(eco.dados.ignored === 'from_me' && (await qtd(pneuA.id)) === 0, 'Mensagem do próprio bot não grava');

  await Promise.all([
    post(evento({ grupo: grupoA, remetente: opA, texto: 'AAA1A23 1E 14 14 14', id: 'med-a' })),
    post(evento({ grupo: grupoB, remetente: opB, texto: 'BBB2B34 1E 11 11 11', id: 'med-b' })),
  ]);
  await esperar(async () => (await obterSessao(a, opA, grupoA))?.passo === 'confirma'
    && (await obterSessao(b, opB, grupoB))?.passo === 'confirma');
  const sessA = await obterSessao(a, opA, grupoA);
  const sessB = await obterSessao(b, opB, grupoB);
  log(
    sessA?.passo === 'confirma' && sessA?.dados?.ok?.[0]?.posicao === '1E'
      && sessB?.passo === 'confirma' && Number(sessB?.dados?.ok?.[0]?.valores?.[0]) === 11
      && !(await obterSessao(a, opA, grupoB))
      && !(await obterSessao(b, opB, grupoA))
      && (await qtd(pneuA.id)) === 0
      && (await qtd(pneuB.id)) === 0,
    'Sessões simultâneas ficam isoladas por grupo e remetente',
  );

  await Promise.all([
    post(evento({ grupo: grupoA, remetente: opA, texto: '1', id: 'ok-a' })),
    post(evento({ grupo: grupoB, remetente: opB, texto: '1', id: 'ok-b' })),
  ]);
  await esperar(async () => (await qtd(pneuA.id)) === 1 && (await qtd(pneuB.id)) === 1);
  const medA = await db.prepare(`SELECT sulco_externo, responsavel FROM medicoes WHERE pneu_id = ?`).get(pneuA.id);
  const medB = await db.prepare(`SELECT sulco_externo, responsavel FROM medicoes WHERE pneu_id = ?`).get(pneuB.id);
  log(
    Number(medA?.sulco_externo) === 14
      && String(medA?.responsavel || '').includes(opA)
      && String(medA?.responsavel || '').includes(grupoA)
      && /unidade Matriz/i.test(String(medA?.responsavel || ''))
      && /WhatsApp/i.test(String(medA?.responsavel || ''))
      && Number(medB?.sulco_externo) === 11
      && String(medB?.responsavel || '').includes(opB)
      && String(medB?.responsavel || '').includes(grupoB)
      && /unidade Unidade B/i.test(String(medB?.responsavel || ''))
      && (await qtd(pneuA.id)) === 1
      && (await qtd(pneuB.id)) === 1,
    'Cada grupo grava só a medição da própria unidade, com telefone do remetente',
  );

  const visitante = '5511933330003';
  await post(evento({
    grupo: grupoB, remetente: visitante, texto: 'BBB2B34 1E 4 4 4', id: 'visitante-abre',
  }));
  await esperar(async () => (await obterSessao(b, visitante, grupoB))?.passo === 'confirma');
  log(
    (await obterSessao(b, visitante, grupoB))?.passo === 'confirma'
      && (await qtd(pneuB.id)) === 1
      && !(await obterSessao(a, visitante, grupoA)),
    'Participante sem cadastro no grupo B pede confirmação e não grava ainda',
  );
  await post(evento({
    grupo: grupoB, remetente: visitante, texto: '1', id: 'visitante-ok',
  }));
  await esperar(async () => (await qtd(pneuB.id)) === 2);
  const medVisitante = await db.prepare(`
    SELECT sulco_externo, responsavel FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1
  `).get(pneuB.id);
  log(
    (await qtd(pneuB.id)) === 2
      && Number(medVisitante?.sulco_externo) === 4
      && String(medVisitante?.responsavel || '').includes(visitante)
      && String(medVisitante?.responsavel || '').includes(grupoB),
    'Participante sem cadastro confirma e grava só na unidade do grupo',
  );

  const cruzado = await post(evento({
    grupo: grupoA, remetente: visitante, texto: 'BBB2B34 1E 2 2 2', id: 'cruzado',
  }));
  await new Promise((r) => setTimeout(r, 400));
  log(
    cruzado.status === 200 && (await qtd(pneuB.id)) === 2,
    'Mensagem no grupo A não altera a medição da unidade B',
  );
  await post(evento({ grupo: grupoA, remetente: visitante, texto: '0', id: 'cruzado-0' }));
  await new Promise((r) => setTimeout(r, 200));

  const nomeFalso = await post({
    type: 'Message',
    event: {
      Info: {
        Chat: '120363100000000099@g.us',
        PushName: 'Grupo Oficial A',
        Sender: `${visitante}@s.whatsapp.net`,
        IsGroup: true,
        ID: 'nome-falso',
      },
      Message: { conversation: 'AAA1A23 1E 1 1 1' },
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  log(
    nomeFalso.dados.ignored === 'grupo_nao_selecionado' && (await qtd(pneuA.id)) === 1,
    'Nome do grupo não autoriza; só o JID oficial',
  );

  const antesDup = await qtd(pneuA.id);
  await post(evento({
    grupo: grupoA, remetente: visitante, texto: 'AAA1A23 1E 7 7 7', id: 'dup-abre',
  }));
  await esperar(async () => (await obterSessao(a, visitante, grupoA))?.passo === 'confirma');
  await post(evento({ grupo: grupoA, remetente: visitante, texto: '1', id: 'dup-ok' }));
  await esperar(async () => (await qtd(pneuA.id)) === antesDup + 1);
  await post(evento({ grupo: grupoA, remetente: visitante, texto: '1', id: 'dup-ok' }));
  await new Promise((r) => setTimeout(r, 300));
  log((await qtd(pneuA.id)) === antesDup + 1, 'Confirmação duplicada não grava de novo');

  http.close();
  console.log(`\nGRUPOS ${oks} OK / ${fails} FAIL`);
  for (const f of falhas) console.log(' -', f);
  await closePool();
  await pglite.server.stop();
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
