/**
 * Medição rápida segura no WhatsApp (PGlite isolado).
 * Uma linha, várias posições, usuário sem vínculo, confirmação repetida e sessões no grupo.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMedicaoWhatsApp } from '../src/services/whatsapp-comandos.js';

const ROOT = 'C:/Projetos/pneusistemma';
const BACKEND = path.join(ROOT, 'backend');
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55451;
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

function valores(parsed, pos) {
  return parsed?.linhas?.find((l) => l.posicao === pos)?.valores?.join() || '';
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

async function main() {
  const uma = parseMedicaoWhatsApp('ABC1D23 1E 14 14 14');
  log(uma?.placa === 'ABC1D23' && uma.linhas.length === 1 && valores(uma, '1E') === '14,14,14', 'Parse: uma linha placa + posição');
  log(!uma.linhas.some((l) => l.posicao === '14'), 'Parse: sulco 14 não vira posição');

  const multi = parseMedicaoWhatsApp('ABC1D23 1E 14 14 14 1D 13 13 12');
  log(
    multi?.linhas.length === 2 && valores(multi, '1E') === '14,14,14' && valores(multi, '1D') === '13,13,12',
    'Parse: duas posições na mesma mensagem',
  );
  const antiga = parseMedicaoWhatsApp('ABC1D23\n1E 14,14,14');
  log(antiga?.placa === 'ABC1D23' && valores(antiga, '1E') === '14,14,14', 'Parse: formato antigo em linhas');
  log(parseMedicaoWhatsApp('ABC1D23') == null, 'Parse: placa sozinha não é medição');

  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'medicao-rapida';
  process.env.FRONTEND_URL = 'https://app.pneusistemma.test';
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { processarMensagemMenu, limparDedupMemoriaTeste } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js')));
  const { obterSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));
  const { extrairTelefone } = await import(toFileUrl(path.join(BACKEND, 'src/routes/webhook.js')));

  log(
    extrairTelefone({
      Info: { Sender: '999001@lid', SenderAlt: '5511981002002@s.whatsapp.net', Chat: '120363019999@g.us', IsGroup: true },
    }) === '5511981002002',
    'Remetente: SenderAlt é o telefone real',
  );
  log(
    extrairTelefone({
      Info: { Sender: '999001@lid', Chat: '120363019999@g.us', IsGroup: true },
    }) == null,
    'Remetente: só LID não identifica',
  );

  await initDatabase();
  const db = getDb();
  const filialId = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get()).id;
  await db.prepare(`INSERT INTO filiais (nome, codigo, ativo) VALUES (?, ?, 1)`).run('Outra Unidade', 'OUT1');
  const outra = (await db.prepare(`SELECT id FROM filiais WHERE codigo = 'OUT1'`).get()).id;

  const truck = await ops.criarVeiculo(filialId, { placa: 'ABC1D23', tipo: 'Truck / Tração', km_atual: 1200 });
  const pneus = {};
  for (const [pos, fogo] of [['1E', 'MATRIZ-7710'], ['1D', 'MATRIZ-7711']]) {
    const p = await ops.criarPneuEstoque(filialId, {
      numero_fogo: fogo, modelo: 'Med', tipo_pneu: 'misto', condicao: 'novo', sulco_inicial_mm: 16,
    });
    await ops.montarPneu({ filialId, pneuId: p.id, veiculoId: truck.id, posicao: pos });
    pneus[pos] = p;
  }

  const grupo = '120363019999@g.us';
  const grupoOutra = '120363019998@g.us';
  const chip = '5511900001111';
  await db.prepare(`UPDATE filiais SET whatsapp = ?, whatsapp_grupo = ? WHERE id = ?`).run(chip, grupo, filialId);
  await db.prepare(`UPDATE filiais SET whatsapp_grupo = ? WHERE id = ?`).run(grupoOutra, outra);
  let msgSeq = 0;
  async function autorizar(phone, filial, { ativo = 1, papel = 'filial' } = {}) {
    const login = `rap${String(phone).replace(/\D/g, '')}`.slice(0, 48);
    await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
      VALUES (?, 'x', ?, 'funcionario', ?, ?, ?)
      ON CONFLICT (login) DO UPDATE SET
        whatsapp = EXCLUDED.whatsapp,
        ativo = EXCLUDED.ativo,
        papel = EXCLUDED.papel,
        filial_id = EXCLUDED.filial_id
    `).run(login, papel, filial, ativo, String(phone));
    return login;
  }

  async function falar(texto, { phone, mensagemId, filial, chat } = {}) {
    const id = mensagemId === undefined ? `rap-${(msgSeq += 1)}` : mensagemId;
    const fid = filial || filialId;
    const chatJid = chat || (Number(fid) === Number(outra) ? grupoOutra : grupo);
    const r = await processarMensagemMenu({
      filialId: fid,
      phone,
      destino: chatJid,
      chatJid,
      texto,
      mensagemId: id,
    });
    const sessao = phone ? await obterSessao(fid, phone, chatJid) : null;
    return { r, sessao };
  }

  async function qtd(pneuId) {
    const row = await db.prepare(`SELECT COUNT(*) as n FROM medicoes WHERE pneu_id = ?`).get(pneuId);
    return Number(row?.n || 0);
  }

  const opA = '5511981002001';
  const opB = '5511981002002';
  await autorizar(opA, filialId);
  await autorizar(opB, filialId);

  const simples = await falar('ABC1D23 1E 14 14 14', { phone: opA });
  log(
    simples.sessao?.fluxo === 'medir_wa'
      && simples.sessao?.passo === 'confirma'
      && simples.sessao?.dados?.ok?.length === 1
      && simples.sessao.dados.ok[0].posicao === '1E'
      && (await qtd(pneus['1E'].id)) === 0,
    'Simples: resumo antes de gravar',
  );
  await falar('0', { phone: opA });
  log((await qtd(pneus['1E'].id)) === 0, 'Simples: 0 cancela');

  await falar('ABC1D23 1E 14 14 14', { phone: opA });
  await falar('1', { phone: opA, mensagemId: 'conf-simples' });
  const gravada = await db.prepare(`
    SELECT sulco_externo, sulco_central, sulco_interno, responsavel, observacoes
    FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1
  `).get(pneus['1E'].id);
  log(
    Number(gravada?.sulco_externo) === 14
      && Number(gravada?.sulco_central) === 14
      && Number(gravada?.sulco_interno) === 14
      && String(gravada?.responsavel || '').includes(opA)
      && String(gravada?.responsavel || '').includes('WhatsApp')
      && String(gravada?.responsavel || '').includes(grupo)
      && /unidade Matriz/i.test(String(gravada?.responsavel || ''))
      && gravada?.observacoes === 'WhatsApp',
    'Simples: grava sulcos, telefone, grupo, unidade e origem',
  );

  const varias = await falar('ABC1D23 1E 12 12 12 1D 11 11 10', { phone: opA });
  log(
    varias.sessao?.passo === 'confirma' && varias.sessao?.dados?.ok?.length === 2,
    'Várias posições: as duas entram no resumo',
  );
  await falar('1', { phone: opA, mensagemId: 'conf-varias' });
  const m1d = await db.prepare(`SELECT sulco_externo FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1`).get(pneus['1D'].id);
  log(Number(m1d?.sulco_externo) === 11 && (await qtd(pneus['1D'].id)) === 1, 'Várias posições: 1D gravado na confirmação');

  const antesBloqueio = await qtd(pneus['1E'].id);
  const semCadastro = '5511966666666';
  const semVinculo = await falar('ABC1D23 1E 9 9 9', { phone: semCadastro });
  log(
    semVinculo.sessao?.passo === 'confirma'
      && (await qtd(pneus['1E'].id)) === antesBloqueio,
    'Sem cadastro prévio: pede 1 e não grava',
  );
  await falar('0', { phone: semCadastro });

  const inativo = '5511966666667';
  await autorizar(inativo, filialId, { ativo: 0 });
  const rInativo = await falar('ABC1D23 1E 9 9 9', { phone: inativo });
  log(
    rInativo.sessao?.passo === 'confirma' && (await qtd(pneus['1E'].id)) === antesBloqueio,
    'Usuário inativo no painel ainda chega na confirmação',
  );
  await falar('0', { phone: inativo });

  const rSemPapel = await falar('ABC1D23 1E 9 9 9', { phone: '5511977777777' });
  log(
    rSemPapel.sessao?.passo === 'confirma' && (await qtd(pneus['1E'].id)) === antesBloqueio,
    'Participante sem papel filial chega na confirmação',
  );
  await falar('0', { phone: '5511977777777' });

  const outraPessoa = '5511966666668';
  await autorizar(outraPessoa, outra);
  const rOutra = await falar('ABC1D23 1E 9 9 9', { phone: outraPessoa, filial: outra, chat: grupoOutra });
  log(
    !rOutra.sessao?.dados?.ok?.length && (await qtd(pneus['1E'].id)) === antesBloqueio,
    'Grupo da outra unidade não mede a placa da Matriz',
  );
  const rChip = await falar('ABC1D23 1E 9 9 9', { phone: chip });
  log(
    rChip.r.bloqueado === 'remetente' && !rChip.sessao && (await qtd(pneus['1E'].id)) === antesBloqueio,
    'Número do chatbot não grava',
  );

  const semNumero = await falar('ABC1D23 1E 9 9 9', { phone: null });
  log(semNumero.r.bloqueado === 'remetente' && (await qtd(pneus['1E'].id)) === antesBloqueio, 'Sem remetente: recusa escrita');

  await falar('ABC1D23 1E 8 8 8', { phone: opA, mensagemId: 'lote-8' });
  await falar('1', { phone: opA, mensagemId: 'conf-8' });
  const apos8 = await qtd(pneus['1E'].id);
  limparDedupMemoriaTeste();
  await falar('1', { phone: opA, mensagemId: 'conf-8' });
  log((await qtd(pneus['1E'].id)) === apos8, 'Confirmação repetida: o mesmo ID não grava de novo');

  await falar('ABC1D23 1E 6 6 6', { phone: opA, mensagemId: 'lote-6' });
  limparDedupMemoriaTeste();
  await falar('1', { phone: opA, mensagemId: 'conf-8' });
  const ainda8 = await db.prepare(`SELECT sulco_externo FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1`).get(pneus['1E'].id);
  log(
    Number(ainda8?.sulco_externo) === 8 && (await qtd(pneus['1E'].id)) === apos8,
    'Retry antigo não confirma a medição nova',
  );
  await falar('1', { phone: opA, mensagemId: 'conf-6' });
  const virou6 = await db.prepare(`SELECT sulco_externo FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1`).get(pneus['1E'].id);
  log(Number(virou6?.sulco_externo) === 6, 'Confirmação nova grava a medição pendente');

  await falar('ABC1D23 1E 7 7 7', { phone: opA, mensagemId: 'lote-7' });
  const antesPar = await qtd(pneus['1E'].id);
  await Promise.all([
    falar('1', { phone: opA, mensagemId: 'par-1' }),
    falar('1', { phone: opA, mensagemId: 'par-2' }),
  ]);
  log((await qtd(pneus['1E'].id)) === antesPar + 1, 'Duas confirmações simultâneas gravam uma vez');

  const sa = await falar('ABC1D23 1E 5 5 5', { phone: opA, mensagemId: 'grupo-a' });
  const sb = await falar('ABC1D23 1D 4 4 4', { phone: opB, mensagemId: 'grupo-b' });
  log(
    sa.sessao?.dados?.ok?.length === 1
      && sa.sessao.dados.ok[0].posicao === '1E'
      && sb.sessao?.dados?.ok?.length === 1
      && sb.sessao.dados.ok[0].posicao === '1D',
    'Grupo: cada participante tem a própria sessão',
  );
  await falar('1', { phone: opA, mensagemId: 'grupo-a-ok' });
  log((await qtd(pneus['1D'].id)) === 1 && (await obterSessao(filialId, opB, grupo))?.dados?.ok?.[0]?.posicao === '1D', 'Grupo: confirmar A não grava a medição de B');
  await falar('1', { phone: opB, mensagemId: 'grupo-b-ok' });
  const b4 = await db.prepare(`SELECT sulco_externo FROM medicoes WHERE pneu_id = ? ORDER BY id DESC LIMIT 1`).get(pneus['1D'].id);
  log(Number(b4?.sulco_externo) === 4, 'Grupo: B confirma a própria medição');

  const antesMenu = await qtd(pneus['1E'].id);
  const menu = await falar('1', { phone: opA, mensagemId: 'menu-1' });
  log(menu.sessao?.fluxo === 'medir', 'Menu 1: continua pedindo a placa');
  await falar('ABC1D23', { phone: opA, mensagemId: 'menu-placa' });
  log((await qtd(pneus['1E'].id)) === antesMenu && !(await obterSessao(filialId, opA, grupo)), 'Menu 1: placa segue para o link, sem gravar sulco');

  const formatoAntigo = await falar('ABC1D23\n1E 15,15,15', { phone: opA, mensagemId: 'antigo' });
  log(formatoAntigo.sessao?.passo === 'confirma' && formatoAntigo.sessao?.dados?.ok?.[0]?.valores?.join() === '15,15,15', 'Formato antigo: ainda chega na confirmação');

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }

  console.log('');
  console.log(`RAPIDA ${oks} OK / ${fails} FAIL`);
  if (falhas.length) {
    for (const f of falhas) console.log(' -', f);
  }
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
