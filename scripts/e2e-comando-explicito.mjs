/**
 * Regressão: o chatbot só age com comando explícito.
 * Frases comuns não abrem sessão, não gravam e não respondem.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseComandoNatural,
  parseConsultaWhatsApp,
  parseMedicaoWhatsApp,
} from '../src/services/whatsapp-comandos.js';

const BACKEND = 'C:/Projetos/pneusistemma/backend';
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55461;
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

function eq(texto, esperado) {
  const r = parseComandoNatural(texto);
  if (!esperado) return r == null;
  if (!r) return false;
  return Object.entries(esperado).every(([k, v]) => r[k] === v);
}

const FRASES = [
  'Pra cadastrar',
  'Preciso cadastrar',
  'Vou cadastrar amanhã',
  'Temos que medir os pneus',
  'Preciso consultar um veículo',
  'O menu está diferente',
  'Alguém consegue cadastrar?',
  'Vamos enviar para recapagem',
  'vamos enviar o 12345 para recapagem',
  'alguém consegue descartar o 10700002',
];

function comandosExplicitos() {
  for (const frase of FRASES) {
    log(parseComandoNatural(frase) == null, `Frase ignorada no parse: ${frase}`);
    log(parseConsultaWhatsApp(frase) == null, `Frase não é consulta: ${frase}`);
    log(parseMedicaoWhatsApp(frase) == null, `Frase não é medição: ${frase}`);
  }

  log(eq('menu', null), 'menu não é comando natural');
  log(eq('ajuda', null), 'ajuda não é comando natural');
  log(eq('cadastrar veiculo', { tipo: 'cadastrar_veiculo', placa: null, tipoVeiculo: null }), 'cadastrar veiculo');
  log(eq('CADASTRAR VEÍCULO', { tipo: 'cadastrar_veiculo', placa: null, tipoVeiculo: null }), 'cadastrar veículo com acento');
  log(eq('cadastrar pneu', { tipo: 'cadastrar_pneu', fogo: null }), 'cadastrar pneu');
  log(eq('cadastrar pneu 12345', { tipo: 'cadastrar_pneu', fogo: '12345' }), 'cadastrar pneu 12345');
  log(eq('cadastrar caminhão ABC1D23', {
    tipo: 'cadastrar_veiculo', placa: 'ABC1D23', tipoVeiculo: 'Truck / Tração',
  }), 'cadastrar caminhão ABC1D23');
  log(eq('trocar 10700002 por 10700045', { tipo: 'troca', fogo: '10700002', fogo2: '10700045' }), 'trocar A por B');
  log(eq('10700002 descarte', { tipo: 'descarte', fogo: '10700002' }), 'fogo descarte');
  log(eq('DESCARTE 10700002!!!', { tipo: 'descarte', fogo: '10700002' }), 'descarte com pontuação');
  log(eq('rec 10700002', { tipo: 'recap', fogo: '10700002' }), 'alias rec');
  log(eq('onde está o pneu 10700002', { tipo: 'onde', fogo: '10700002' }), 'onde está o pneu');
  log(eq('pneu 10700002 estoque', { tipo: 'estoque', fogo: '10700002' }), 'pneu fogo estoque');
  log(eq('manda o 0501-0042 para o estoque', { tipo: 'estoque', fogo: '0501-0042' }), 'manda para o estoque');
  log(eq('1E 14,14,14', null), 'medição não é comando natural');

  const estoque = parseConsultaWhatsApp('estoque');
  log(estoque?.tipo === 'estoque' && estoque.busca == null, 'estoque');
  const consultaEst = parseConsultaWhatsApp('consultar estoque');
  log(consultaEst?.tipo === 'estoque', 'consultar estoque');
  const placa = parseConsultaWhatsApp('consultar placa ABC1D23');
  log(placa?.tipo === 'placa' && placa.placa === 'abc1d23', 'consultar placa ABC1D23');
  const fogo = parseConsultaWhatsApp('consultar fogo 12345');
  log(fogo?.tipo === 'fogo' && fogo.fogo === '12345', 'consultar fogo 12345');
  const med = parseMedicaoWhatsApp('ABC1D23 1E 14 14 14');
  log(med?.tipo === 'medir' && med.placa === 'ABC1D23' && med.linhas?.[0]?.posicao === '1E', 'medição rápida');
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

async function sessaoAtiva() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'cmd-explicito';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';

  const pglite = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const { processarMensagemMenu } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js')));
  const { obterSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));

  await initDatabase();
  const db = getDb();
  const filialId = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  const grupo = '120363019999@g.us';
  const outro = '120363018888@g.us';
  await db.prepare(`UPDATE filiais SET whatsapp = ?, whatsapp_grupo = ? WHERE id = ?`).run('5511900001111', grupo, filialId);
  const op = '5511981003001';
  const vizinho = '5511981003002';
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
    VALUES ('opcmd', 'x', 'filial', 'funcionario', ?, 1, ?)
  `).run(filialId, op);

  async function msgs() {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM notificacoes_whatsapp`).get();
    return Number(row?.n || 0);
  }

  let seq = 0;
  async function falar(texto, phone = op, chat = grupo) {
    seq += 1;
    const antes = await msgs();
    const r = await processarMensagemMenu({
      filialId, phone, destino: phone, chatJid: chat, texto, mensagemId: `ex-${seq}`,
    });
    const sessao = await obterSessao(filialId, phone, chat);
    return { r, sessao, respondeu: (await msgs()) > antes };
  }

  for (const frase of FRASES) {
    const r = await falar(frase);
    log(r.r.handled === false && !r.sessao && !r.respondeu, `Grupo: ignora "${frase}"`);
  }

  const numeroSolto = await falar('1');
  log(numeroSolto.r.handled === false && !numeroSolto.sessao && !numeroSolto.respondeu, 'Número 1 sem sessão não abre fluxo');
  const zeroSolto = await falar('0');
  log(zeroSolto.r.handled === false && !zeroSolto.sessao && !zeroSolto.respondeu, 'Número 0 sem sessão não abre menu');

  const menu = await falar('menu');
  log(menu.r.handled === true && menu.sessao?.fluxo === 'menu' && menu.respondeu, 'menu abre sessão de opções');
  const duranteMenu = await falar('Pra cadastrar');
  log(
    duranteMenu.r.handled === false && duranteMenu.sessao?.fluxo === 'menu' && !duranteMenu.respondeu,
    'Durante o menu, frase comum não escolhe opção',
  );
  const medir = await falar('1');
  log(medir.sessao?.fluxo === 'medir' && medir.sessao?.passo === 'placa', 'Com o menu aberto, 1 mede');
  const fraseNaMedicao = await falar('Temos que medir os pneus');
  log(
    fraseNaMedicao.r.handled === false
      && fraseNaMedicao.sessao?.fluxo === 'medir'
      && fraseNaMedicao.sessao?.passo === 'placa'
      && !fraseNaMedicao.respondeu,
    'Durante a medição, conversa não vira placa',
  );

  const ajuda = await falar('ajuda', vizinho);
  log(ajuda.sessao?.fluxo === 'menu', 'ajuda abre o menu');
  const cad = await falar('cadastrar veiculo', vizinho);
  log(cad.sessao?.fluxo === 'pre_cadastro' && cad.sessao?.passo === 'placa', 'cadastrar veiculo pede a placa');
  const fraseNoCadastro = await falar('Preciso cadastrar', vizinho);
  log(
    fraseNoCadastro.r.handled === false && fraseNoCadastro.sessao?.passo === 'placa' && !fraseNoCadastro.respondeu,
    'Durante o cadastro, frase comum não vira placa',
  );
  const doVizinho = await obterSessao(filialId, op, grupo);
  log(doVizinho?.fluxo === 'medir', 'Sessão do vizinho não altera a do operador');
  const outroGrupo = await obterSessao(filialId, op, outro);
  log(!outroGrupo, 'Outro grupo não herda a sessão');

  const consulta = await falar('consultar fogo 12345', '5511981003099');
  log(consulta.r.handled === true && !consulta.sessao, 'consultar fogo responde e não abre sessão');
  const medirPneu = await falar('medir pneu', '5511981003099');
  log(medirPneu.sessao?.fluxo === 'medir' && medirPneu.sessao?.passo === 'placa', 'medir pneu abre a medição');

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }
}

comandosExplicitos();
sessaoAtiva().then(() => {
  console.log('');
  console.log(`EXPLICITO ${oks} OK / ${fails} FAIL`);
  if (falhas.length) {
    for (const f of falhas) console.log(' -', f);
  }
  process.exit(fails ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
