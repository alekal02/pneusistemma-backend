/**
 * Pré-cadastro WhatsApp + dedup por ID de mensagem (PGlite isolado).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseComandoNatural } from '../src/services/whatsapp-comandos.js';

const ROOT = 'C:/Projetos/pneusistemma';
const BACKEND = path.join(ROOT, 'backend');
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55436;
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

function eqParse(texto, esperado) {
  const r = parseComandoNatural(texto);
  if (!esperado) return r == null;
  if (!r) return false;
  return Object.entries(esperado).every(([k, v]) => r[k] === v);
}

async function ultimaMsg(db, phone) {
  return db.prepare(`
    SELECT mensagem FROM notificacoes_whatsapp
    WHERE destinatario_whatsapp LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(`%${phone}%`);
}

async function main() {
  log(eqParse('cadastrar caminhão ABC1D23', {
    tipo: 'cadastrar_veiculo', placa: 'ABC1D23', tipoVeiculo: 'Truck / Tração',
  }), 'Parse: cadastrar caminhão ABC1D23');
  log(eqParse('cadastrar trator TR-015', {
    tipo: 'cadastrar_veiculo', placa: 'TR-015', tipoVeiculo: 'Trator',
  }), 'Parse: cadastrar trator TR-015');
  log(eqParse('cadastrar veículo ABC1D23', {
    tipo: 'cadastrar_veiculo', placa: 'ABC1D23', tipoVeiculo: null,
  }), 'Parse: cadastrar veículo ABC1D23');
  log(eqParse('cadastrar pneu 10700050', {
    tipo: 'cadastrar_pneu', fogo: '10700050',
  }), 'Parse: cadastrar pneu 10700050');
  log(eqParse('10700002 descarte', { tipo: 'descarte', fogo: '10700002' }), 'Parse: descarte anterior intacto');
  log(eqParse('1E 14,14,14', null), 'Parse: medição NÃO é cadastro');

  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'cadastro-wa';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  const { mensagemDuplicada } = await import(toFileUrl(path.join(BACKEND, 'src/routes/webhook.js')));
  log(mensagemDuplicada({ id: 'mid-1', filialId: 1, body: '1' }) === false, 'Dedup webhook: 1ª mensagem com ID');
  log(mensagemDuplicada({ id: 'mid-1', filialId: 1, body: '1' }) === true, 'Dedup webhook: mesmo ID bloqueia');
  log(mensagemDuplicada({ id: 'mid-2', filialId: 1, body: '1' }) === false, 'Dedup webhook: mesmo texto, outro ID passa');

  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { processarMensagemMenu, textoMenu } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js')));
  const { obterSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));
  const ar = await import(toFileUrl(path.join(BACKEND, 'src/services/acesso-rapido.js')));

  log(/1️⃣ Medir pneu/.test(textoMenu()) && /9️⃣ Frota/.test(textoMenu()), 'Menu 1–9 inalterado');

  await initDatabase();
  const db = getDb();
  const filialId = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  const grupo = '120363017137@g.us';
  await db.prepare(`UPDATE filiais SET whatsapp_grupo = ? WHERE id = ?`).run(grupo, filialId);
  await db.prepare(`INSERT INTO filiais (nome, codigo, ativo) VALUES (?, ?, 1)`).run('Londrina Teste', 'LDT');
  const outra = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'LDT'`).get();

  let phoneSeq = 11980000000;
  let msgSeq = 0;
  async function falar(texto, { phone, mensagemId } = {}) {
    const p = phone || String((phoneSeq += 1));
    const id = mensagemId === undefined ? `m-${(msgSeq += 1)}` : mensagemId;
    const r = await processarMensagemMenu({
      filialId, phone: p, destino: p, chatJid: grupo, texto, mensagemId: id,
    });
    const sessao = await obterSessao(filialId, p, grupo);
    const notif = await ultimaMsg(db, p);
    return { r, phone: p, sessao, msg: notif?.mensagem || '' };
  }

  const pre = await falar('cadastrar caminhão ABC1D23');
  log(pre.sessao?.passo === 'confirma', 'Pré-cadastro: pede confirmação');
  log(!(await ops.buscarPlacaFilial(filialId, 'ABC1D23')), 'Antes do sim: veículo ainda não existe');

  const cancel = await falar('cadastrar trator TR-015');
  await processarMensagemMenu({
    filialId, phone: cancel.phone, destino: cancel.phone, chatJid: grupo, texto: '0', mensagemId: `m-${(msgSeq += 1)}`,
  });
  log(!(await ops.buscarPlacaFilial(filialId, 'TR015')) && !(await ops.buscarPlacaFilial(filialId, 'TR-015')),
    'Cancelamento: nada gravado');

  const okPre = await falar('cadastrar caminhão ABC1D23');
  await processarMensagemMenu({
    filialId, phone: okPre.phone, destino: okPre.phone, chatJid: grupo, texto: '1', mensagemId: `m-${(msgSeq += 1)}`,
  });
  const veiculo = await ops.buscarPlacaFilial(filialId, 'ABC1D23');
  const msgOk = (await ultimaMsg(db, okPre.phone))?.mensagem || '';
  log(veiculo && Number(veiculo.cadastro_completo) === 0, 'Pré-cadastro: veículo incompleto gravado');
  log(
    /Pré-cadastro realizado/.test(msgOk)
      && /ABC1D23/.test(msgOk)
      && /acesso-rapido\/veiculo\?token=/.test(msgOk)
      && /só estará disponível para operações/.test(msgOk),
    'Mensagem de pré-cadastro com link'
  );

  const frota = await ops.listarFrota(filialId);
  log(!frota.some((v) => v.placa === 'ABC1D23'), 'Incompleto não entra na frota operacional');
  const nOp = await db.prepare(`
    SELECT COUNT(*) as n FROM veiculos
    WHERE filial_id = ? AND ativo = 1 AND COALESCE(cadastro_completo, 1) = 1
  `).get(filialId);
  const nPend = await db.prepare(`
    SELECT COUNT(*) as n FROM veiculos
    WHERE filial_id = ? AND ativo = 1 AND COALESCE(cadastro_completo, 1) = 0
  `).get(filialId);
  log(Number(nPend.n) === 1 && Number(nOp.n) === 0, 'Indicadores: incompleto fora da conta operacional');

  const pEst = await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-10990001', modelo: 'X', tipo_pneu: 'misto', condicao: 'novo',
  });
  let montouIncompleto = false;
  try {
    await ops.montarPneu({
      filialId, pneuId: pEst.id, veiculoId: veiculo.id, posicao: '1E',
    });
    montouIncompleto = true;
  } catch (err) {
    log(/pré-cadastro/i.test(err.message), 'Montagem em incompleto recusada');
  }
  if (montouIncompleto) log(false, 'Montagem em incompleto recusada');

  const dup = await falar('cadastrar caminhão ABC1D23');
  log(
    dup.r.handled === true
      && !dup.sessao
      && /já/.test(dup.msg),
    'Duplicidade: não cria segundo veículo'
  );
  const nPlaca = await db.prepare(`SELECT COUNT(*) as n FROM veiculos WHERE placa = 'ABC1D23'`).get();
  log(Number(nPlaca.n) === 1, 'Duplicidade: uma linha na tabela');

  const tokRow = await db.prepare(`
    SELECT * FROM tokens_acesso_rapido
    WHERE veiculo_id = ? AND tipo = 'cadastrar_veiculo'
    ORDER BY id DESC LIMIT 1
  `).get(veiculo.id);
  log(Boolean(tokRow?.token) && Number(tokRow.filial_id) === Number(filialId), 'Token vinculado à filial e ao veículo');

  const valido = await ar.validarTokenAcessoRapido(tokRow.token, ['cadastrar_veiculo']);
  log(Boolean(valido) && Number(valido.filial_id) === Number(filialId), 'Link válido: token aceito');

  await db.prepare(`
    UPDATE tokens_acesso_rapido SET expira_em = NOW() - INTERVAL '1 hour' WHERE id = ?
  `).run(tokRow.id);
  log((await ar.validarTokenAcessoRapido(tokRow.token, ['cadastrar_veiculo'])) == null, 'Link expirado recusado');

  const linkCad = ar.linkAcessoRapido('cadastrar_veiculo', 'tok');
  log(
    /^https:\/\/app\.pneusistemma\.test\/acesso-rapido\/veiculo\?token=/.test(linkCad)
      && !ar.urlFrontendEhLocal(linkCad),
    'Link de cadastro usa FRONTEND_URL pública'
  );
  log(/\/veiculo-acesso-rapido\?token=/.test(ar.linkAcessoRapido('medir', 'tok')), 'Link medir abre o formulário de medição');
  log(/\/acesso-rapido\/pneu\?token=/.test(ar.linkAcessoRapido('cadastrar_pneu', 'tok')), 'Link de pneu abre o formulário de pneu');
  log(/\/acesso-rapido\/troca\?token=/.test(ar.linkAcessoRapido('troca', 'tok')), 'Link de troca abre o formulário de troca');
  log(ar.urlFrontendEhLocal('http://localhost:5173') && !ar.urlFrontendEhLocal('https://pneusistemma-frontend.vercel.app'),
    'Localhost é recusado como URL pública');

  const { token: tokNovo } = await ar.gerarTokenAcessoRapido({
    tipo: 'cadastrar_veiculo',
    veiculoId: veiculo.id,
    filialId,
    whatsappOrigem: '11980000999',
  });
  const { token: tokOutra } = await ar.gerarTokenAcessoRapido({
    tipo: 'cadastrar_veiculo',
    veiculoId: veiculo.id,
    filialId: outra.id,
    whatsappOrigem: '11980000998',
  });
  log((await ar.validarTokenAcessoRapido(tokOutra, ['cadastrar_veiculo'])) == null, 'Token de outra filial recusado');

  let completouOutra = false;
  try {
    await ops.completarVeiculo(outra.id, veiculo.id, {
      marca: 'Mercedes', modelo: 'Atego', layout_pneus: 'truck_10',
    });
    completouOutra = true;
  } catch (err) {
    log(/não encontrado/i.test(err.message), 'Conclusão web: outra filial não altera o veículo');
  }
  if (completouOutra) log(false, 'Conclusão web: outra filial não altera o veículo');

  const express = (await import('express')).default;
  const authRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/auth.js')))).default;
  const arRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/acesso-rapido.js')))).default;
  const dashRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/dashboard.js')))).default;
  const veiculosRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/veiculos.js')))).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/acesso-rapido', arRouter);
  app.use('/api/dashboard', dashRouter);
  app.use('/api/veiculos', veiculosRouter);
  const httpServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const api = `http://127.0.0.1:${httpServer.address().port}/api`;
  async function http(metodo, caminho, { token, body } = {}) {
    const res = await fetch(`${api}${caminho}`, {
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

  const login = await http('POST', '/auth/login', { body: { login: 'matriz', senha: 'matriz123' } });
  const jwtTok = login.dados?.token;
  log(login.status === 200 && !!jwtTok, 'HTTP login matriz');

  const medirComCad = await http('GET', `/veiculos/acesso-rapido?token=${encodeURIComponent(tokNovo)}`);
  log(medirComCad.status === 401, 'Token de cadastro não abre o formulário de medição');

  const getAr = await http('GET', `/acesso-rapido?token=${encodeURIComponent(tokNovo)}`);
  log(
    getAr.status === 200
      && getAr.dados?.pre_cadastro === true
      && Number(getAr.dados?.veiculo?.cadastro_completo) === 0
      && getAr.dados?.veiculo?.placa === 'ABC1D23',
    'Formulário AR: GET carrega pré-cadastro do veículo'
  );

  const dashPend = await http('GET', '/dashboard/resumo', { token: jwtTok });
  const vDashPend = (dashPend.dados?.veiculos || []).find((v) => v.placa === 'ABC1D23');
  log(
    dashPend.status === 200
      && dashPend.dados?.veiculos_ativos === 0
      && vDashPend?.cadastro_pendente === true
      && vDashPend?.status_sulco === 'cadastro_pendente',
    'Dashboard: incompleto como Cadastro pendente e fora dos ativos'
  );

  const listaPend = await http('GET', '/veiculos', { token: jwtTok });
  const vListaPend = (listaPend.dados || []).find((v) => v.placa === 'ABC1D23');
  log(
    listaPend.status === 200
      && vListaPend?.cadastro_pendente === true
      && vListaPend?.status_sulco === 'cadastro_pendente',
    'Lista veículos: incompleto identificado como Cadastro pendente'
  );

  const postIncompleto = await http('POST', '/acesso-rapido/veiculo', {
    body: { token: tokNovo, marca: 'Mercedes', layout_pneus: 'truck_10' },
  });
  log(postIncompleto.status === 400, 'Formulário AR: conclusão sem modelo recusada');
  log(
    Number((await db.prepare(`SELECT cadastro_completo FROM veiculos WHERE id = ?`).get(veiculo.id)).cadastro_completo) === 0,
    'Formulário AR: cancelar/recusar não conclui o cadastro'
  );

  const postVeic = await http('POST', '/acesso-rapido/veiculo', {
    body: {
      token: tokNovo,
      marca: 'Mercedes',
      modelo: 'Atego',
      tipo: 'Truck / Tração',
      layout_pneus: 'truck_10',
      km_atual: 1000,
    },
  });
  const veiculoOk = await db.prepare(`SELECT * FROM veiculos WHERE id = ?`).get(veiculo.id);
  log(
    [200, 201].includes(postVeic.status)
      && Number(veiculoOk.cadastro_completo) === 1
      && veiculoOk.modelo === 'Atego'
      && veiculoOk.marca === 'Mercedes'
      && postVeic.dados?.total_posicoes > 0,
    'Formulário AR: conclusão de cadastro do veículo'
  );
  const frota2 = await ops.listarFrota(filialId);
  log(frota2.some((v) => v.placa === 'ABC1D23'), 'Após concluir: aparece na frota');

  const dashOk = await http('GET', '/dashboard/resumo', { token: jwtTok });
  const vDashOk = (dashOk.dados?.veiculos || []).find((v) => v.placa === 'ABC1D23');
  log(
    dashOk.dados?.veiculos_ativos === 1
      && vDashOk?.cadastro_pendente === false,
    'Dashboard: após concluir entra nos indicadores operacionais'
  );

  const pendCard = await ops.criarVeiculo(filialId, {
    placa: 'CARD1A1', tipo: 'Truck / Tração', preCadastro: true,
  });
  const semModelo = await http('POST', `/veiculos/${pendCard.id}/concluir`, {
    token: jwtTok,
    body: { marca: 'Volkswagen', layout_pneus: 'truck_10' },
  });
  log(semModelo.status === 400, 'Card: conclusão sem modelo recusada');
  const adminLogin = await http('POST', '/auth/login', { body: { login: 'admin', senha: 'admin123' } });
  const adminPost = await http('POST', `/veiculos/${pendCard.id}/concluir`, {
    token: adminLogin.dados?.token,
    body: { marca: 'Volkswagen', modelo: 'Delivery', layout_pneus: 'truck_10' },
  });
  log(adminLogin.status === 200 && adminPost.status === 403, 'Card: quem não é operador da unidade não conclui');
  const outraV = await ops.criarVeiculo(outra.id, { placa: 'OUT1B2', preCadastro: true });
  const fora = await http('POST', `/veiculos/${outraV.id}/concluir`, {
    token: jwtTok,
    body: { marca: 'Volkswagen', modelo: 'Delivery', layout_pneus: 'truck_10' },
  });
  log(fora.status === 404, 'Card: operador de outra filial não conclui');
  const okCard = await http('POST', `/veiculos/${pendCard.id}/concluir`, {
    token: jwtTok,
    body: {
      marca: 'Volkswagen', modelo: 'Delivery', tipo: 'Truck / Tração',
      layout_pneus: 'truck_10', km_atual: 10,
    },
  });
  const cardDb = await db.prepare(`SELECT cadastro_completo, modelo FROM veiculos WHERE id = ?`).get(pendCard.id);
  log(
    okCard.status === 200 && Number(cardDb.cadastro_completo) === 1 && cardDb.modelo === 'Delivery',
    'Card: operador autorizado conclui o cadastro'
  );

  await ops.montarPneu({ filialId, pneuId: pEst.id, veiculoId: veiculo.id, posicao: '1E' });
  log((await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(pEst.id)).status_pneu === 'montado',
    'Após concluir: montagem permitida');

  log((await ar.validarTokenAcessoRapido(tokNovo, ['cadastrar_veiculo'])) == null, 'Token usado não reabre o cadastro');

  const subEst = await ops.criarPneuEstoque(filialId, {
    numero_fogo: 'MATRIZ-10990002', modelo: 'Y', tipo_pneu: 'misto', condicao: 'novo',
  });
  const { token: tokTroca } = await ar.gerarTokenAcessoRapido({
    tipo: 'troca', veiculoId: veiculo.id, filialId,
  });
  const trocaSem = await http('POST', '/acesso-rapido/troca', {
    body: { token: tokTroca, retirar_pneu_id: pEst.id },
  });
  log(trocaSem.status === 400, 'Formulário AR: troca sem substituto recusada');
  log(
    (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(pEst.id)).status_pneu === 'montado'
      && (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(subEst.id)).status_pneu === 'estoque',
    'Formulário AR: cancelar troca não move pneus'
  );

  const trocaOk = await http('POST', '/acesso-rapido/troca', {
    body: { token: tokTroca, retirar_pneu_id: pEst.id, montar_pneu_id: subEst.id },
  });
  log(
    [200, 201].includes(trocaOk.status)
      && (await db.prepare(`SELECT status_pneu FROM pneus WHERE id = ?`).get(pEst.id)).status_pneu === 'estoque'
      && (await db.prepare(`SELECT status_pneu, posicao FROM pneus WHERE id = ?`).get(subEst.id)).status_pneu === 'montado',
    'Formulário AR: confirmar substituição de pneu'
  );

  const pneuInc = await ops.criarPneuEstoque(filialId, {
    numero_fogo: '10700050',
    modelo: 'Pendente',
    preCadastro: true,
  });
  log(pneuInc && Number(pneuInc.cadastro_completo) === 0, 'Pré-cadastro de pneu incompleto');
  const est = await ops.listarEstoque(filialId, 50);
  log(!est.some((p) => p.id === pneuInc.id), 'Pneu incompleto fora do estoque operacional');

  await ar.gerarTokenAcessoRapido({
    tipo: 'cadastrar_pneu',
    pneuId: pneuInc.id,
    filialId,
    whatsappOrigem: '5511900000099',
  });
  const tokPneuRow = await db.prepare(`
    SELECT * FROM tokens_acesso_rapido
    WHERE pneu_id = ? AND tipo = 'cadastrar_pneu'
    ORDER BY id DESC LIMIT 1
  `).get(pneuInc.id);
  const postPneu = await http('POST', '/acesso-rapido/pneu', {
    body: {
      token: tokPneuRow.token,
      marca: 'Michelin',
      modelo: 'X Multi D',
      tipo_pneu: 'misto',
      condicao: 'novo',
      sulco_inicial_mm: 14,
    },
  });
  const pneuDone = await db.prepare(`SELECT * FROM pneus WHERE id = ?`).get(pneuInc.id);
  log(
    [200, 201].includes(postPneu.status)
      && Number(pneuDone.cadastro_completo) === 1
      && pneuDone.modelo === 'X Multi D',
    'Formulário AR: conclusão de cadastro do pneu'
  );

  const d1 = await processarMensagemMenu({
    filialId, phone: '11980001111', destino: '11980001111', chatJid: grupo, texto: 'menu', mensagemId: 'same-id',
  });
  const d2 = await processarMensagemMenu({
    filialId, phone: '11980001112', destino: '11980001112', chatJid: grupo, texto: 'menu', mensagemId: 'same-id',
  });
  const d3 = await processarMensagemMenu({
    filialId, phone: '11980001113', destino: '11980001113', chatJid: grupo, texto: 'menu', mensagemId: 'other-id',
  });
  log(d1.handled === true && d1.duplicado !== true, 'Dedup menu: 1ª confirmação com ID passa');
  log(d2.duplicado === true, 'Dedup menu: mesmo ID bloqueia');
  log(d3.handled === true && d3.duplicado !== true, 'Dedup menu: outro ID com o mesmo texto passa');

  const tipoAsk = await falar('cadastrar veículo ZZ9Z99');
  log(tipoAsk.sessao?.passo === 'tipo', 'Cadastrar veículo sem tipo pede o tipo');

  await new Promise((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }

  console.log('');
  console.log(`CADASTRO ${oks} OK / ${fails} FAIL`);
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
