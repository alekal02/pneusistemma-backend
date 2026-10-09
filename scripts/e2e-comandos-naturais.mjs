/**
 * Comandos naturais do WhatsApp + regressão atômica (PGlite).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseComandoNatural } from '../src/services/whatsapp-comandos.js';

const ROOT = 'C:/Projetos/pneusistemma';
const BACKEND = path.join(ROOT, 'backend');
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55435;
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
  return { db, server };
}

async function estadoPneu(db, id) {
  return db.prepare(`
    SELECT id, numero_fogo, status_pneu, veiculo_id, posicao, ativo, filial_id
    FROM pneus WHERE id = ?
  `).get(id);
}

async function qtdMov(db, pneuId) {
  const row = await db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE pneu_id = ?`).get(pneuId);
  return Number(row?.n || 0);
}

function eqParse(texto, esperado) {
  const r = parseComandoNatural(texto);
  if (!esperado) return r == null;
  if (!r) return false;
  return r.tipo === esperado.tipo
    && r.fogo === esperado.fogo
    && (esperado.fogo2 ? r.fogo2 === esperado.fogo2 : true);
}

async function main() {
  log(eqParse('10700002 descarte', { tipo: 'descarte', fogo: '10700002' }), 'Parse: 10700002 descarte');
  log(eqParse('10700002 recap', { tipo: 'recap', fogo: '10700002' }), 'Parse: 10700002 recap');
  log(eqParse('trocar 10700002 por 10700045', { tipo: 'troca', fogo: '10700002', fogo2: '10700045' }), 'Parse: trocar A por B');
  log(eqParse('pneu 10700002 estoque', { tipo: 'estoque', fogo: '10700002' }), 'Parse: pneu X estoque');
  log(eqParse('onde está o pneu 10700002', { tipo: 'onde', fogo: '10700002' }), 'Parse: onde está o pneu');
  log(eqParse('DESCARTE 10700002!!!', { tipo: 'descarte', fogo: '10700002' }), 'Parse: maiúsculas e pontuação');
  log(eqParse('rec 10700002', { tipo: 'recap', fogo: '10700002' }), 'Parse: abreviação rec');
  log(eqParse('localizar 10700002', { tipo: 'onde', fogo: '10700002' }), 'Parse: localizar');
  log(eqParse('1E 14,14,14', null), 'Parse: medição 1E 14,14,14 NÃO é comando');
  log(eqParse('fechou', null), 'Parse: conversa livre NÃO é comando');
  log(eqParse('menu', null), 'Parse: menu NÃO é comando natural');

  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'cmd-natural';
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { processarMensagemMenu, textoMenu } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js')));
  const { obterSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));

  log(/1️⃣ Medir pneu/.test(textoMenu()) && /9️⃣ Frota/.test(textoMenu()), 'Menu 1–9 inalterado');

  await initDatabase();
  const db = getDb();
  const filialId = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  const grupo = '120363017237@g.us';
  await db.prepare(`UPDATE filiais SET whatsapp_grupo = ? WHERE id = ?`).run(grupo, filialId);
  await db.prepare(`INSERT INTO filiais (nome, codigo, ativo) VALUES (?, ?, 1)`).run('Londrina Teste', 'LDT');
  const outra = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'LDT'`).get();

  const truck = await ops.criarVeiculo(filialId, { placa: 'CMD1A23', tipo: 'Truck / Tração', km_atual: 900 });

  async function pneuEstoque(fogo, extra = {}) {
    return ops.criarPneuEstoque(filialId, {
      numero_fogo: fogo,
      modelo: extra.modelo || 'Cmd',
      tipo_pneu: extra.tipo_pneu || 'misto',
      condicao: extra.condicao || 'novo',
      sulco_inicial_mm: 14,
    });
  }

  const pA = await pneuEstoque('MATRIZ-10700002');
  const pB = await pneuEstoque('MATRIZ-10700045');
  const pAmb = await pneuEstoque('MATRIZ-10700012');
  const pRecapado = await pneuEstoque('MATRIZ-10700999', { condicao: 'recapado' });
  const pOutra = await ops.criarPneuEstoque(outra.id, {
    numero_fogo: 'LDT-10700002', modelo: 'X', tipo_pneu: 'misto', condicao: 'novo',
  });
  await ops.montarPneu({ filialId, pneuId: pA.id, veiculoId: truck.id, posicao: '1E' });
  await ops.montarPneu({ filialId, pneuId: pAmb.id, veiculoId: truck.id, posicao: '2EE' });

  let phoneSeq = 11970000000;
  async function autorizar(phone) {
    const login = `nat${String(phone).replace(/\D/g, '')}`.slice(0, 48);
    await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
      VALUES (?, 'x', 'filial', 'funcionario', ?, 1, ?)
      ON CONFLICT (login) DO UPDATE SET
        whatsapp = EXCLUDED.whatsapp, ativo = 1, papel = 'filial', filial_id = EXCLUDED.filial_id
    `).run(login, filialId, String(phone));
  }
  async function falar(texto) {
    phoneSeq += 1;
    const phone = String(phoneSeq);
    await autorizar(phone);
    const r = await processarMensagemMenu({
      filialId, phone, destino: phone, chatJid: grupo, texto,
    });
    const sessao = await obterSessao(filialId, phone, grupo);
    return { r, phone, sessao };
  }

  const onde = await falar('onde está o pneu 10700002');
  log(onde.r.handled === true && !onde.sessao, 'Onde: responde e não abre sessão de mutação');

  const parcial = await ops.buscarPneusPorFogo(filialId, '00045');
  log(parcial.length === 1 && parcial[0].id === pB.id, 'Fogo parcial único encontra MATRIZ-10700045');

  const amb = await ops.buscarPneusPorFogo(filialId, '107000');
  log(amb.length >= 2, 'Fogo parcial ambíguo retorna vários');

  const ambChat = await falar('onde está o pneu 107000');
  log(ambChat.r.handled === true && ambChat.sessao?.passo === 'escolher', 'Chat: fogo ambíguo pede seleção');

  const outraBusca = await ops.buscarPneusPorFogo(filialId, 'LDT-10700002');
  log(outraBusca.length === 0, 'Outra filial: MATRIZ não vê LDT-10700002');
  const outraChat = await falar('descarte LDT-10700002');
  log(outraChat.r.handled === true && (await estadoPneu(db, pOutra.id)).status_pneu === 'estoque', 'Chat outra filial: não altera o pneu de LDT');

  const movAntes = await qtdMov(db, pA.id);
  const cancel = await falar('10700002 descarte');
  log(cancel.sessao?.passo === 'motivo' || cancel.sessao?.passo === 'substituto' || cancel.sessao?.passo === 'confirma', 'Descarte montado pede motivo antes de gravar');
  log((await estadoPneu(db, pA.id)).status_pneu === 'montado' && (await qtdMov(db, pA.id)) === movAntes, 'Antes da confirmação: original intacto');
  await processarMensagemMenu({
    filialId, phone: cancel.phone, destino: cancel.phone, chatJid: grupo, texto: '0',
  });
  log((await estadoPneu(db, pA.id)).status_pneu === 'montado', 'Cancelamento: nada alterado');

  const incomp = await falar('trocar 10700002 por 10700999');
  log(
    incomp.r.handled === true
      && (await estadoPneu(db, pA.id)).status_pneu === 'montado'
      && (await estadoPneu(db, pRecapado.id)).status_pneu === 'estoque',
    'Substituto incompatível (recapado em 1E): não grava'
  );

  const troca = await falar('trocar 10700002 por 10700045');
  log(troca.sessao?.passo === 'confirma', 'Troca natural chega na confirmação');
  log((await estadoPneu(db, pA.id)).status_pneu === 'montado', 'Troca: ainda montado antes do sim');
  await processarMensagemMenu({
    filialId, phone: troca.phone, destino: troca.phone, chatJid: grupo, texto: '1',
  });
  log(
    (await estadoPneu(db, pA.id)).status_pneu === 'estoque'
      && (await estadoPneu(db, pB.id)).status_pneu === 'montado'
      && (await estadoPneu(db, pB.id)).posicao === '1E',
    'Confirmação: troca atômica executada'
  );

  const pC = await pneuEstoque('MATRIZ-10700888');
  await ops.montarPneu({ filialId, pneuId: pC.id, veiculoId: truck.id, posicao: '2EI' });
  const pD = await pneuEstoque('MATRIZ-10700889');
  const rb = await falar(`trocar ${pC.numero_fogo} por ${pD.numero_fogo}`);
  process.env.PNEU_TEST_FALHAR_TX = '1';
  await processarMensagemMenu({
    filialId, phone: rb.phone, destino: rb.phone, chatJid: grupo, texto: 'sim',
  });
  delete process.env.PNEU_TEST_FALHAR_TX;
  log(
    (await estadoPneu(db, pC.id)).status_pneu === 'montado'
      && (await estadoPneu(db, pD.id)).status_pneu === 'estoque',
    'Rollback: falha na gravação restaura original e substituto'
  );

  const menuAberto = await falar('menu');
  await processarMensagemMenu({
    filialId, phone: menuAberto.phone, destino: menuAberto.phone, chatJid: grupo, texto: '1',
  });
  menuAberto.sessao = await obterSessao(filialId, menuAberto.phone, grupo);
  log(menuAberto.sessao?.fluxo === 'medir' && menuAberto.sessao?.passo === 'placa', 'Menu 1 abre medição por placa');
  const movMenu = await qtdMov(db, pA.id);
  await processarMensagemMenu({
    filialId, phone: menuAberto.phone, destino: menuAberto.phone, chatJid: grupo, texto: '10700002 descarte',
  });
  const sessaoMenu = await obterSessao(filialId, menuAberto.phone, grupo);
  log(
    sessaoMenu?.fluxo === 'medir'
      && (await estadoPneu(db, pA.id)).status_pneu === 'estoque'
      && (await qtdMov(db, pA.id)) === movMenu,
    'Comando natural não interrompe o menu de medição'
  );
  await processarMensagemMenu({
    filialId, phone: menuAberto.phone, destino: menuAberto.phone, chatJid: grupo, texto: '4',
  });
  const sessaoQuatro = await obterSessao(filialId, menuAberto.phone, grupo);
  log(sessaoQuatro?.fluxo === 'medir', 'Opção 4 dentro da medição não abre o menu de troca');

  const pConf = await pneuEstoque('MATRIZ-10700777');
  const emConfirma = await falar(`trocar ${pAmb.numero_fogo} por ${pConf.numero_fogo}`);
  log(emConfirma.sessao?.fluxo === 'cmd_natural' && emConfirma.sessao?.passo === 'confirma', 'Troca em confirmação antes do segundo comando');
  await processarMensagemMenu({
    filialId, phone: emConfirma.phone, destino: emConfirma.phone, chatJid: grupo, texto: '10700012 descarte',
  });
  const sessaoConf = await obterSessao(filialId, emConfirma.phone, grupo);
  log(
    sessaoConf?.fluxo === 'cmd_natural'
      && sessaoConf?.passo === 'confirma'
      && (await estadoPneu(db, pAmb.id)).status_pneu === 'montado'
      && (await estadoPneu(db, pConf.id)).status_pneu === 'estoque',
    'Durante a confirmação, outro comando natural não grava descarte'
  );

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }

  console.log('');
  console.log(`NATURAIS ${oks} OK / ${fails} FAIL`);
  if (falhas.length) {
    console.log('FALHAS:');
    for (const f of falhas) console.log(' -', f);
  }
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
