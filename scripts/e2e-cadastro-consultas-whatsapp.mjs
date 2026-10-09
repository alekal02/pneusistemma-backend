/**
 * Fase 3 — cadastro completo, consultas e motivo de descarte (PGlite isolado).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = 'C:/Projetos/pneusistemma/backend';
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55453;
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

async function main() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'cadastro-consulta';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { processarMensagemMenu, limparDedupMemoriaTeste, textoMenu } = await import(
    toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js'))
  );
  const { obterSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));

  await initDatabase();
  const db = getDb();
  const filialId = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  const truck = await ops.criarVeiculo(filialId, { placa: 'CNS1A23', tipo: 'Truck / Tração', km_atual: 5000 });
  const op = '5511981009401';
  const chat = '120363019403@g.us';
  const chip = '5511900001111';
  await db.prepare(`UPDATE filiais SET whatsapp = ?, whatsapp_grupo = ? WHERE id = ?`).run(chip, chat, filialId);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
    VALUES ('opcad', 'x', 'filial', 'funcionario', ?, 1, ?)
  `).run(filialId, op);

  log(/1️⃣ Medir pneu/.test(textoMenu()) && /9️⃣ Frota/.test(textoMenu()), 'Menu 1–9 inalterado');

  let seq = 0;
  async function falar(texto, { phone = op, mensagemId } = {}) {
    seq += 1;
    const id = mensagemId === undefined ? `cad-${seq}` : mensagemId;
    const r = await processarMensagemMenu({
      filialId, phone, destino: phone, chatJid: chat, texto, mensagemId: id,
    });
    const sessao = phone ? await obterSessao(filialId, phone, chat) : null;
    const notif = await db.prepare(`
      SELECT mensagem FROM notificacoes_whatsapp
      WHERE destinatario_whatsapp LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(`%${String(phone).slice(-8)}%`);
    return { r, sessao, msg: notif?.mensagem || '' };
  }

  async function contar(fogo) {
    const row = await db.prepare(`
      SELECT COUNT(*) AS n FROM pneus WHERE filial_id = ? AND numero_fogo = ?
    `).get(filialId, fogo);
    return Number(row?.n || 0);
  }

  async function preencher(fogo, { ate = 'confirma' } = {}) {
    await falar(`cadastrar pneu ${fogo}`);
    await falar('X Multi D');
    await falar('Michelin');
    await falar('2');
    await falar('1');
    if (ate === 'sulco') return;
    await falar('14');
  }

  const semOp = await falar('cadastrar pneu MATRIZ-9401', { phone: '5511900002222' });
  log(
    semOp.sessao?.fluxo === 'cadastro_pneu'
      && (await contar('MATRIZ-9401')) === 0,
    'Cadastro: participante sem usuário pede os dados e não grava',
  );
  await falar('0', { phone: '5511900002222' });
  const botCad = await falar('cadastrar pneu MATRIZ-9401', { phone: chip });
  log(
    botCad.r.bloqueado === 'remetente' && (await contar('MATRIZ-9401')) === 0 && !botCad.sessao,
    'Cadastro: número do chatbot não grava',
  );

  await preencher('MATRIZ-9401', { ate: 'sulco' });
  await falar('14');
  log((await contar('MATRIZ-9401')) === 0, 'Cadastro: antes do 1 o pneu não existe');
  const cancelado = await falar('0');
  log(
    (await contar('MATRIZ-9401')) === 0 && cancelado.sessao?.fluxo === 'menu' && /Medir pneu/.test(cancelado.msg),
    'Cadastro: 0 cancela e não grava',
  );

  await preencher('MATRIZ-9401');
  const gravou = await falar('1', { mensagemId: 'cad-ok' });
  const criado = await db.prepare(`
    SELECT * FROM pneus WHERE filial_id = ? AND numero_fogo = ?
  `).get(filialId, 'MATRIZ-9401');
  const mov = await db.prepare(`
    SELECT tipo, usuario, detalhes FROM movimentacoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1
  `).get(criado?.id);
  log(
    Number(criado?.cadastro_completo) === 1
      && criado?.modelo === 'X Multi D'
      && criado?.marca === 'Michelin'
      && criado?.tipo_pneu === 'misto'
      && criado?.condicao === 'novo'
      && Number(criado?.sulco_inicial_mm) === 14
      && criado?.status_pneu === 'estoque'
      && mov?.tipo === 'entrada_estoque'
      && mov?.usuario === op
      && /WhatsApp/i.test(mov?.detalhes || '')
      && String(mov?.detalhes || '').includes(chat)
      && /unidade Matriz/i.test(String(mov?.detalhes || ''))
      && /cadastrado/i.test(gravou.msg),
    'Cadastro: 1 grava completo, login e origem',
  );

  const dup = await falar('cadastrar pneu MATRIZ-9401');
  log(
    /já existe/i.test(dup.msg) && (await contar('MATRIZ-9401')) === 1 && !dup.sessao,
    'Cadastro: fogo duplicado não cria outro pneu',
  );

  await preencher('MATRIZ-9402');
  limparDedupMemoriaTeste();
  await falar('1', { mensagemId: 'cad-retry' });
  log((await contar('MATRIZ-9402')) === 1, 'Cadastro: primeira confirmação grava');
  await preencher('MATRIZ-9403');
  limparDedupMemoriaTeste();
  const replay = await falar('1', { mensagemId: 'cad-retry' });
  log(
    (await contar('MATRIZ-9403')) === 0
      && /já foi registrada/i.test(replay.msg),
    'Cadastro: mesmo ID de confirmação não grava de novo',
  );
  await falar('0');

  await preencher('MATRIZ-9404');
  const antesPar = await contar('MATRIZ-9404');
  await Promise.all([
    falar('1', { mensagemId: 'cad-par-a' }),
    falar('1', { mensagemId: 'cad-par-b' }),
  ]);
  log(antesPar === 0 && (await contar('MATRIZ-9404')) === 1, 'Cadastro: duas confirmações simultâneas gravam um pneu');

  const montado = await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-9410',
    marca: 'Pirelli',
    modelo: 'TR01',
    tipo_pneu: 'direcional',
    condicao: 'novo',
    sulco_inicial_mm: 16,
  });
  await ops.montarPneu({ filialId, pneuId: montado.id, veiculoId: truck.id, posicao: '1E' });
  await db.prepare(`
    INSERT INTO medicoes (pneu_id, sulco_externo, sulco_central, sulco_interno, responsavel)
    VALUES (?, 14, 14, 13, 'teste')
  `).run(montado.id);

  const placa = await falar('consultar placa CNS1A23', { phone: '5511900002222' });
  log(
    placa.r.handled === true
      && !placa.sessao
      && /pneus montados/i.test(placa.msg)
      && /MATRIZ-9410/.test(placa.msg)
      && /1E/.test(placa.msg)
      && /14\/14\/13/.test(placa.msg)
      && /ok|alerta|crítico|sem medição/.test(placa.msg),
    'Consulta placa: posição, fogo, sulcos e situação',
  );

  const soPlaca = await falar('CNS1A23', { phone: '5511900002222' });
  log(
    soPlaca.r.handled === true && !/pneus montados/i.test(soPlaca.msg),
    'Placa sozinha continua no fluxo de medição',
  );

  const fogo = await falar('consultar fogo MATRIZ-9410', { phone: '5511900002222' });
  log(
    /montado/i.test(fogo.msg)
      && /CNS1A23/.test(fogo.msg)
      && /novo/i.test(fogo.msg)
      && /14\/14\/13/.test(fogo.msg)
      && /vida/i.test(fogo.msg)
      && !fogo.sessao,
    'Consulta fogo: local, condição, sulcos e vida',
  );

  await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-9420',
    marca: 'Goodyear',
    modelo: 'KMax',
    tipo_pneu: 'misto',
    condicao: 'novo',
  });
  await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-9421',
    marca: 'Bandag',
    modelo: 'BDR',
    tipo_pneu: 'borrachudo',
    condicao: 'recapado',
  });
  const estoque = await falar('estoque', { phone: '5511900002222' });
  log(
    /Estoque da unidade/.test(estoque.msg)
      && /Novos/.test(estoque.msg)
      && /Recapados/.test(estoque.msg)
      && /MATRIZ-9420/.test(estoque.msg)
      && /MATRIZ-9421/.test(estoque.msg)
      && !estoque.sessao,
    'Estoque: lista organizada sem abrir retirada',
  );
  const busca = await falar('consultar estoque 9421', { phone: '5511900002222' });
  log(
    /MATRIZ-9421/.test(busca.msg) && !/MATRIZ-9420/.test(busca.msg) && !busca.sessao,
    'Estoque: busca por fogo',
  );

  const desc = await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-9430',
    modelo: 'Desc',
    tipo_pneu: 'misto',
    condicao: 'novo',
  });
  async function statusDesc() {
    return (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(desc.id)).status_pneu;
  }
  await falar('menu');
  await falar('7');
  await falar(desc.numero_fogo);
  for (const ruim of ['-', '.', 'pular']) {
    const r = await falar(ruim);
    log(
      r.sessao?.fluxo === 'descarte'
        && r.sessao?.passo === 'motivo'
        && (await statusDesc()) === 'estoque',
      `Descarte menu: "${ruim}" não aceita e não grava`,
    );
  }
  await falar('0');

  const desc2 = await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-9431',
    modelo: 'Desc2',
    tipo_pneu: 'misto',
    condicao: 'novo',
  });
  await falar(`descarte ${desc2.numero_fogo}`);
  for (const ruim of ['-', 'pular']) {
    const r = await falar(ruim);
    log(
      r.sessao?.fluxo === 'cmd_natural'
        && r.sessao?.passo === 'motivo'
        && (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(desc2.id)).status_pneu === 'estoque',
      `Descarte texto: "${ruim}" não aceita e não grava`,
    );
  }
  await falar('furo na banda');
  log(
    (await obterSessao(filialId, op, chat))?.passo === 'confirma'
      && (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(desc2.id)).status_pneu === 'estoque',
    'Descarte texto: motivo válido pede 1 antes de gravar',
  );
  await falar('1', { mensagemId: 'desc-ok' });
  const ult = await db.prepare(`
    SELECT usuario, detalhes FROM movimentacoes WHERE pneu_id = ? AND tipo = 'descarte' ORDER BY id DESC LIMIT 1
  `).get(desc2.id);
  log(
    (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(desc2.id)).status_pneu === 'descarte'
      && ult?.usuario === op
      && String(ult?.detalhes || '').includes(chat)
      && /furo na banda/i.test(ult?.detalhes || '')
      && /WhatsApp/i.test(ult?.detalhes || ''),
    'Descarte texto: motivo, login e origem gravados',
  );

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }
  console.log('');
  console.log(`CADCON ${oks} OK / ${fails} FAIL`);
  for (const f of falhas) console.log(' -', f);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
