/**
 * Medição de sulco pelo WhatsApp (PGlite isolado).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseComandoNatural,
  parseMedicaoWhatsApp,
  pareceMedicaoWhatsApp,
  parseValoresSulco,
} from '../src/services/whatsapp-comandos.js';

const ROOT = 'C:/Projetos/pneusistemma';
const BACKEND = path.join(ROOT, 'backend');
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55437;
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

const LOTE = [
  'ABC1D23',
  '1E 14,14,14',
  '1D 13,13,12',
  '2EE 11,11,10',
  '2EI 12,12,12',
  '2DI 10,10,9',
  '2DE 13,12,12',
].join('\n');

async function main() {
  const parsed = parseMedicaoWhatsApp(LOTE);
  log(parsed?.tipo === 'medir' && parsed.placa === 'ABC1D23' && parsed.linhas.length === 6, 'Parse: lote placa + 6 posições');
  log(parsed.linhas[0].posicao === '1E' && parsed.linhas[0].valores?.join() === '14,14,14', 'Parse: 1E 3 valores');
  log(parseMedicaoWhatsApp('1E 14,14,14,13')?.linhas[0].valores?.length === 4, 'Parse: 4 valores');
  log(parseComandoNatural(LOTE) == null, 'Parse: lote NÃO é comando natural');
  log(parseComandoNatural('1E 14,14,14') == null, 'Parse: 1E 14,14,14 NÃO é comando natural');
  log(pareceMedicaoWhatsApp('1E 14,14,14'), 'Parse: linha avulsa é medição');
  log(!pareceMedicaoWhatsApp('ABC1D23'), 'Parse: placa sozinha NÃO é medição');
  log(!pareceMedicaoWhatsApp('trocar 10700002 por 10700045'), 'Parse: troca NÃO é medição');
  log(parseMedicaoWhatsApp('9ZZ 14,14,14')?.linhas[0].erro === 'posicao_desconhecida', 'Parse: posição desconhecida');
  log(parseValoresSulco('14.5,14.5,14.5').join() === '14.5,14.5,14.5', 'Parse: decimal com ponto');
  log(parseValoresSulco('14,5;14,5;14,5').join() === '14.5,14.5,14.5', 'Parse: decimal BR com ponto-e-vírgula');
  log(parseValoresSulco('14,5 14,5 14,5').join() === '14.5,14.5,14.5', 'Parse: decimal BR com espaço');
  log(parseValoresSulco('14,14,14').join() === '14,14,14', 'Parse: inteiros com vírgula');
  log(parseValoresSulco('14,5,14,5,14,5').length === 6, 'Parse: 14,5,14,5,14,5 é ambíguo (6 valores)');
  log(parseMedicaoWhatsApp('ABC1D23\nKM 150000\n1E 14.5,14.5,14.5')?.km === 150000, 'Parse: KM opcional no lote');

  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'medicao-wa';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
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
  await db.prepare(`INSERT INTO filiais (nome, codigo, ativo) VALUES (?, ?, 1)`).run('Londrina Teste', 'LDT');
  const outra = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'LDT'`).get();

  const truck = await ops.criarVeiculo(filialId, { placa: 'ABC1D23', tipo: 'Truck / Tração', km_atual: 1200 });
  const posicoes = ['1E', '1D', '2EE', '2EI', '2DI', '2DE'];
  const pneus = {};
  for (let i = 0; i < posicoes.length; i += 1) {
    const p = await ops.criarPneuEstoque(filialId, {
      numero_fogo: `MATRIZ-880${i}`, modelo: 'Med', tipo_pneu: 'misto', condicao: 'novo', sulco_inicial_mm: 16,
    });
    await ops.montarPneu({ filialId, pneuId: p.id, veiculoId: truck.id, posicao: posicoes[i] });
    pneus[posicoes[i]] = p;
  }

  let phoneSeq = 11981000000;
  let msgSeq = 0;
  async function falar(texto, { phone, mensagemId, filial } = {}) {
    const p = phone || String((phoneSeq += 1));
    const id = mensagemId === undefined ? `med-${(msgSeq += 1)}` : mensagemId;
    const fid = filial || filialId;
    const r = await processarMensagemMenu({
      filialId: fid, phone: p, destino: p, chatJid: '', texto, mensagemId: id,
    });
    const sessao = await obterSessao(fid, p, '');
    return { r, phone: p, sessao };
  }

  async function qtdMed(pneuId) {
    const row = await db.prepare(`SELECT COUNT(*) as n FROM medicoes WHERE pneu_id = ?`).get(pneuId);
    return Number(row?.n || 0);
  }

  const soPlaca = await falar('ABC1D23');
  log(soPlaca.r.handled === true && !soPlaca.sessao, 'Placa sozinha: link (sem sessão de medição chat)');

  const lote = await falar(LOTE);
  log(lote.sessao?.fluxo === 'medir_wa' && lote.sessao?.passo === 'confirma', 'Lote: chega no resumo/confirmação');
  log((await qtdMed(pneus['1E'].id)) === 0, 'Lote: ainda não grava antes do sim');

  const cancel = await falar(LOTE);
  await processarMensagemMenu({
    filialId, phone: cancel.phone, destino: cancel.phone, chatJid: '', texto: '0', mensagemId: `med-${(msgSeq += 1)}`,
  });
  log((await qtdMed(pneus['1E'].id)) === 0, 'Cancelamento: histórico intacto');

  const conf = await falar(LOTE);
  await processarMensagemMenu({
    filialId, phone: conf.phone, destino: conf.phone, chatJid: '', texto: '1', mensagemId: `med-${(msgSeq += 1)}`,
  });
  const m1e = await db.prepare(`
    SELECT * FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1
  `).get(pneus['1E'].id);
  log(
    m1e
      && Number(m1e.sulco_externo) === 14
      && Number(m1e.sulco_central) === 14
      && Number(m1e.sulco_interno) === 14
      && m1e.sulco_auxiliar == null
      && m1e.responsavel
      && m1e.data_medicao
      && m1e.created_at,
    'Confirmação: 1E no histórico com data e responsável'
  );
  log((await qtdMed(pneus['2DE'].id)) === 1, 'Confirmação: lote inteiro gravado');

  const sepPhone = String((phoneSeq += 1));
  await processarMensagemMenu({
    filialId, phone: sepPhone, destino: sepPhone, chatJid: '',
    texto: 'ABC1D23\n1E 15,15,15', mensagemId: `med-${(msgSeq += 1)}`,
  });
  await processarMensagemMenu({
    filialId, phone: sepPhone, destino: sepPhone, chatJid: '',
    texto: '1D 14,14,14,13', mensagemId: `med-${(msgSeq += 1)}`,
  });
  const sepSess = await obterSessao(filialId, sepPhone, '');
  log(sepSess?.passo === 'confirma' && sepSess.dados?.ok?.length === 2, 'Separadas: acumula 1E + 1D (4 valores)');
  log((await qtdMed(pneus['1E'].id)) === 1, 'Separadas: não grava até confirmar');
  await processarMensagemMenu({
    filialId, phone: sepPhone, destino: sepPhone, chatJid: '', texto: '1', mensagemId: `med-${(msgSeq += 1)}`,
  });
  const m1e2 = await db.prepare(`SELECT sulco_externo, sulco_auxiliar FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1`).get(pneus['1E'].id);
  const m1d = await db.prepare(`SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1`).get(pneus['1D'].id);
  log(Number(m1e2.sulco_externo) === 15, 'Separadas: 1E atualizado após confirmação');
  log(Number(m1d.sulco_auxiliar) === 13, 'Separadas: 1D com 4º valor');

  const kmBaixo = await falar('ABC1D23\nKM 100\n1E 14,14,14');
  log(Boolean(kmBaixo.sessao?.dados?.km_erro) && (await qtdMed(pneus['1E'].id)) === 2, 'KM menor que o atual recusado');

  const kmOk = await falar('ABC1D23\nKM 150000\n1E 14.5,14.5,14.5');
  log(kmOk.sessao?.passo === 'confirma' && kmOk.sessao.dados?.km_informado === 150000, 'KM 150000 aceito no resumo');
  await processarMensagemMenu({
    filialId, phone: kmOk.phone, destino: kmOk.phone, chatJid: '', texto: '1', mensagemId: `med-${(msgSeq += 1)}`,
  });
  const medKm = await db.prepare(`
    SELECT sulco_externo, km_veiculo FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1
  `).get(pneus['1E'].id);
  const kmVeic = await db.prepare(`SELECT km_atual FROM veiculos WHERE id = ?`).get(truck.id);
  log(Number(medKm.sulco_externo) === 14.5 && Number(medKm.km_veiculo) === 150000, 'KM informado gravado na medição');
  log(Number(kmVeic.km_atual) === 150000, 'KM do veículo atualizado');

  const inv = await falar('ABC1D23\n1E 16,16,16\n9ZZ 14,14,14');
  log(
    inv.sessao?.passo === 'coletar'
      && inv.sessao.dados?.ok?.some((i) => i.posicao === '1E')
      && inv.sessao.dados?.erros?.some((e) => e.posicao === '9ZZ')
      && (await qtdMed(pneus['1E'].id)) === 3,
    'Posição inválida: pede correção e mantém 1E válido (sem gravar)'
  );

  const vazio = await falar('ABC1D23\n3EE 14,14,14');
  log(
    vazio.sessao?.dados?.erros?.some((e) => /montado/i.test(e.motivo))
      && (await qtdMed(pneus['1E'].id)) === 3,
    'Pneu não montado: recusa 3EE'
  );

  const outraFilial = await falar(LOTE, { filial: outra.id });
  log(
    outraFilial.r.handled === true
      && (await qtdMed(pneus['1E'].id)) === 3
      && !outraFilial.sessao?.dados?.ok?.length,
    'Outra filial: não mede nem grava o veículo da MATRIZ'
  );

  const d1 = await processarMensagemMenu({
    filialId, phone: '11981001111', destino: '11981001111', chatJid: '', texto: LOTE, mensagemId: 'dup-med',
  });
  const d2 = await processarMensagemMenu({
    filialId, phone: '11981001112', destino: '11981001112', chatJid: '', texto: LOTE, mensagemId: 'dup-med',
  });
  log(d1.handled === true && d1.duplicado !== true, 'Dedup: 1ª medição com ID passa');
  log(d2.duplicado === true, 'Dedup: reenvio do mesmo ID bloqueia');

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }

  console.log('');
  console.log(`MEDICAO ${oks} OK / ${fails} FAIL`);
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
