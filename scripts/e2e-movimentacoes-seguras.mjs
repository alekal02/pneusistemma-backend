/**
 * Segurança das movimentações do chatbot (PGlite isolado).
 * Troca, montagem, retirada, recap, descarte: autorização, confirmação, retry e simultâneo.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = 'C:/Projetos/pneusistemma/backend';
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55452;
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
  process.env.JWT_SECRET = 'mov-segura';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { processarMensagemMenu, limparDedupMemoriaTeste } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js')));
  const { obterSessao, salvarSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));

  await initDatabase();
  const db = getDb();
  const filialId = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  const grupo = '120363018888@g.us';
  await db.prepare(`UPDATE filiais SET whatsapp = ?, whatsapp_grupo = ? WHERE id = ?`).run('5511900001111', grupo, filialId);
  const truck = await ops.criarVeiculo(filialId, { placa: 'MOV1A23', tipo: 'Truck / Tração', km_atual: 1000 });
  const op = '5511981003001';
  const login = 'opmov';
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
    VALUES (?, 'x', 'filial', 'funcionario', ?, 1, ?)
  `).run(login, filialId, op);

  let seq = 0;
  async function pneu(posicao = null) {
    seq += 1;
    const row = await ops.criarPneuEstoque(filialId, {
      numero_fogo: `MATRIZ-91${String(seq).padStart(2, '0')}`,
      modelo: 'Seg',
      tipo_pneu: 'misto',
      condicao: 'novo',
      sulco_inicial_mm: 16,
    });
    if (posicao) {
      await ops.montarPneu({ filialId, pneuId: row.id, veiculoId: truck.id, posicao });
    }
    return row;
  }

  async function estado(id) {
    return db.prepare(`SELECT status_pneu, posicao, veiculo_id FROM pneus WHERE id = ?`).get(id);
  }

  async function movs(id) {
    return db.prepare(`
      SELECT tipo, usuario, detalhes FROM movimentacoes WHERE pneu_id = ? ORDER BY id
    `).all(id);
  }

  async function falar(texto, { phone = op, mensagemId, filial = filialId } = {}) {
    const id = mensagemId === undefined ? `mov-${seq}-${Math.random().toString(16).slice(2, 8)}` : mensagemId;
    const r = await processarMensagemMenu({
      filialId: filial, phone, destino: phone, chatJid: '120363018888@g.us', texto, mensagemId: id,
    });
    const sessao = phone ? await obterSessao(filial, phone, '120363018888@g.us') : null;
    return { r, sessao };
  }

  const consulta = await pneu('1E');
  const semVinculo = await falar(`onde está o pneu ${consulta.numero_fogo}`, { phone: '5511966554433' });
  log(
    semVinculo.r.handled === true
      && (await estado(consulta.id)).status_pneu === 'montado'
      && !semVinculo.sessao,
    'Consulta: onde responde sem autorização de escrita',
  );
  const frota = await falar('frota', { phone: '5511966554433' });
  log(frota.r.handled === true && (await estado(consulta.id)).status_pneu === 'montado', 'Consulta: frota sem autorização de escrita');
  await falar('menu', { phone: '5511966554433' });
  const rel = await falar('8', { phone: '5511966554433' });
  log(rel.sessao?.fluxo === 'relatorio' && (await estado(consulta.id)).status_pneu === 'montado', 'Relatório: abre sem autorização de escrita');

  const bloqueio = await pneu('1D');
  const antesBloq = (await movs(bloqueio.id)).length;
  const atalho = await falar(`descarte ${bloqueio.numero_fogo}`, { phone: '5511966554444' });
  log(
    Boolean(atalho.sessao?.passo)
      && (await estado(bloqueio.id)).status_pneu === 'montado'
      && (await movs(bloqueio.id)).length === antesBloq,
    'Atalho: participante sem cadastro pede confirmação e não grava',
  );
  await falar('0', { phone: '5511966554444' });
  await falar('menu', { phone: '5511977777777' });
  const menu5 = await falar('5', { phone: '5511977777777' });
  log(
    menu5.sessao?.fluxo === 'estoque' && (await estado(bloqueio.id)).status_pneu === 'montado',
    'Menu 5: participante sem cadastro abre a movimentação',
  );
  await falar('0', { phone: '5511977777777' });
  const chip = await falar('5', { phone: '5511900001111' });
  log(chip.r.handled === false && !chip.sessao, 'Número 5 sem sessão não abre movimentação');
  const chipMenu = await falar('menu', { phone: '5511900001111' });
  log(chipMenu.r.bloqueado === 'remetente' && !chipMenu.sessao, 'Menu: número do chatbot não abre sessão');

  const origTroca = await pneu('2EE');
  const subTroca = await pneu();
  const troca = await falar(`trocar ${origTroca.numero_fogo} por ${subTroca.numero_fogo}`);
  log(
    troca.sessao?.passo === 'confirma' && (await estado(origTroca.id)).status_pneu === 'montado',
    'Troca: pede 1 antes de gravar',
  );
  await falar('0');
  log((await estado(origTroca.id)).status_pneu === 'montado', 'Troca: 0 cancela');
  await falar(`trocar ${origTroca.numero_fogo} por ${subTroca.numero_fogo}`);
  await falar('1', { mensagemId: 'troca-1' });
  const movTroca = await movs(origTroca.id);
  const ultTroca = movTroca[movTroca.length - 1];
  log(
    (await estado(origTroca.id)).status_pneu === 'estoque'
      && (await estado(subTroca.id)).posicao === '2EE'
      && ultTroca?.usuario === op
      && String(ultTroca?.detalhes || '').includes(grupo)
      && /unidade Matriz/i.test(String(ultTroca?.detalhes || ''))
      && /WhatsApp/i.test(ultTroca?.detalhes || ''),
    'Troca: grava retirada com login e origem',
  );

  const origRet = await pneu('2EI');
  const subRet = await pneu();
  await falar('menu');
  await falar('5');
  await falar(origRet.numero_fogo);
  await falar(subRet.numero_fogo);
  log((await estado(origRet.id)).status_pneu === 'montado', 'Retirada: substituto ainda não grava');
  await falar('1', { mensagemId: 'ret-1' });
  const ultRet = (await movs(origRet.id)).at(-1);
  log(
    (await estado(origRet.id)).status_pneu === 'estoque'
      && (await estado(subRet.id)).posicao === '2EI'
      && ultRet?.tipo === 'retirada'
      && ultRet?.usuario === op
      && /WhatsApp/i.test(ultRet?.detalhes || ''),
    'Retirada: confirmação grava com login e origem',
  );

  const livre = (await ops.posicoesLivres(truck.id))[0];
  const montar = await pneu();
  await salvarSessao({
    filialId,
    telefone: op,
    chatJid: '120363018888@g.us',
    fluxo: 'montar_pos',
    passo: 'fogo',
    dados: { veiculo_id: truck.id, posicao: livre, placa: truck.placa },
  });
  await falar(montar.numero_fogo);
  log((await estado(montar.id)).status_pneu === 'estoque', 'Montagem: fogo só pede confirmação');
  await falar('1', { mensagemId: 'mont-1' });
  const ultMont = (await movs(montar.id)).at(-1);
  log(
    (await estado(montar.id)).status_pneu === 'montado'
      && (await estado(montar.id)).posicao === livre
      && ultMont?.tipo === 'montagem'
      && ultMont?.usuario === op
      && /WhatsApp/i.test(ultMont?.detalhes || ''),
    'Montagem: confirmação grava com login e origem',
  );

  const recap = await pneu();
  await falar('menu');
  await falar('6');
  await falar(recap.numero_fogo);
  log((await estado(recap.id)).status_pneu === 'estoque', 'Recap: pede 1 antes de enviar');
  await falar('1', { mensagemId: 'recap-1' });
  const ultRecap = (await movs(recap.id)).at(-1);
  log(
    (await estado(recap.id)).status_pneu === 'recapagem'
      && ultRecap?.tipo === 'recap'
      && ultRecap?.usuario === op
      && /WhatsApp/i.test(ultRecap?.detalhes || ''),
    'Recap: envio gravado com login e origem',
  );
  await falar('menu');
  await falar('6');
  await falar(recap.numero_fogo);
  log((await obterSessao(filialId, op, '120363018888@g.us'))?.passo === 'devolver', 'Recap: retorno pede 1');
  await falar('1', { mensagemId: 'recap-volta' });
  const ultVolta = (await movs(recap.id)).at(-1);
  log(
    (await estado(recap.id)).status_pneu === 'estoque'
      && ultVolta?.tipo === 'retorno_recap'
      && ultVolta?.usuario === op,
    'Recap: retorno gravado com login',
  );

  const desc = await pneu();
  await falar('menu');
  await falar('7');
  await falar(desc.numero_fogo);
  await falar('corte lateral');
  log((await estado(desc.id)).status_pneu === 'estoque', 'Descarte: motivo ainda não grava');
  await falar('1', { mensagemId: 'desc-1' });
  const ultDesc = (await movs(desc.id)).at(-1);
  log(
    (await estado(desc.id)).status_pneu === 'descarte'
      && ultDesc?.usuario === op
      && /WhatsApp/i.test(ultDesc?.detalhes || '')
      && /corte lateral/i.test(ultDesc?.detalhes || ''),
    'Descarte: confirmação grava motivo, login e origem',
  );

  const origRetry = await pneu((await ops.posicoesLivres(truck.id))[0]);
  const subRetry = await pneu();
  const subRetry2 = await pneu();
  await falar(`trocar ${origRetry.numero_fogo} por ${subRetry.numero_fogo}`, { mensagemId: 'retry-abre' });
  await falar('1', { mensagemId: 'retry-ok' });
  const nRetry = (await movs(origRetry.id)).length;
  limparDedupMemoriaTeste();
  await falar(`trocar ${subRetry.numero_fogo} por ${subRetry2.numero_fogo}`, { mensagemId: 'retry-abre-2' });
  await falar('1', { mensagemId: 'retry-ok' });
  log(
    (await movs(origRetry.id)).length === nRetry
      && (await estado(subRetry.id)).status_pneu === 'montado',
    'Retry: o mesmo ID não repete a troca nem confirma a seguinte',
  );
  await falar('0', { mensagemId: 'retry-cancela' });

  const origPar = await pneu((await ops.posicoesLivres(truck.id))[0]);
  const subPar = await pneu();
  await falar(`trocar ${origPar.numero_fogo} por ${subPar.numero_fogo}`, { mensagemId: 'par-abre' });
  const nPar = (await movs(origPar.id)).length;
  await Promise.all([
    falar('1', { mensagemId: 'par-a' }),
    falar('1', { mensagemId: 'par-b' }),
  ]);
  log(
    (await movs(origPar.id)).length === nPar + 1
      && (await estado(subPar.id)).status_pneu === 'montado',
    'Simultâneo: duas confirmações gravam uma troca',
  );

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }
  console.log('');
  console.log(`MOVSEG ${oks} OK / ${fails} FAIL`);
  for (const f of falhas) console.log(' -', f);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
