/**
 * Testes isolados (PGlite) da Etapa 1: troca / recap / descarte atômicos.
 * Não toca produção.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Projetos/pneusistemma';
const BACKEND = path.join(ROOT, 'backend');
const PGLITE_DIR = 'C:/Users/Sistemma/AppData/Local/Temp/pneu-pglite2';
const PG_PORT = 55434;
const toFileUrl = (p) => pathToFileURL(p).href;

let oks = 0;
let fails = 0;
const aprovados = [];
const falhas = [];

function log(ok, rotulo, extra = '') {
  if (ok) {
    oks += 1;
    aprovados.push(rotulo);
  } else {
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

async function ocupante(db, veiculoId, posicao) {
  return db.prepare(`
    SELECT id, numero_fogo, status_pneu, veiculo_id, posicao, ativo
    FROM pneus
    WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
  `).get(veiculoId, posicao);
}

async function estadoPneu(db, id) {
  return db.prepare(`
    SELECT id, numero_fogo, status_pneu, veiculo_id, posicao, ativo, vida_recap, condicao, filial_id
    FROM pneus WHERE id = ?
  `).get(id);
}

async function qtdMov(db, pneuId) {
  const row = await db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE pneu_id = ?`).get(pneuId);
  return Number(row?.n || 0);
}

async function expectThrow(fn, contem) {
  try {
    await fn();
    return { ok: false, msg: 'não lançou' };
  } catch (err) {
    const m = String(err.message || '');
    if (contem && !contem.test(m)) return { ok: false, msg: m };
    return { ok: true, msg: m };
  }
}

async function main() {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'development';
  process.env.WUZAPI_BASE_URL = 'http://127.0.0.1:9';
  process.env.WHATSAPP_ALERTAS_ENABLED = 'false';
  process.env.JWT_SECRET = 'etapa1-mov';
  delete process.env.PNEU_TEST_FALHAR_TX;

  const pglite = await iniciarPglite();
  console.log('PGlite ok', PG_PORT);

  const { initDatabase, getDb, closePool } = await import(toFileUrl(path.join(BACKEND, 'src/database.js')));
  const ops = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-ops.js')));
  const { processarMensagemMenu, textoMenu } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-menu.js')));
  const { salvarSessao } = await import(toFileUrl(path.join(BACKEND, 'src/services/whatsapp-sessao.js')));

  log(/1️⃣ Medir pneu/.test(textoMenu()) && /9️⃣ Frota/.test(textoMenu()), 'Menu 1–9 inalterado');

  await initDatabase();
  const db = getDb();
  const filial = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get();
  const filialId = filial.id;
  const grupo = '120363017337@g.us';
  await db.prepare(`UPDATE filiais SET whatsapp_grupo = ? WHERE id = ?`).run(grupo, filialId);

  await db.prepare(`INSERT INTO filiais (nome, codigo, ativo) VALUES (?, ?, 1)`).run('Londrina Teste', 'LDT');
  const outra = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'LDT'`).get();

  const truck = await ops.criarVeiculo(filialId, {
    placa: 'ETP1A23',
    tipo: 'Truck / Tração',
    km_atual: 2000,
  });
  const pos1E = '1E';
  const posTracao = '2EE';

  async function pneuEstoque(fogo, extra = {}) {
    return ops.criarPneuEstoque(filialId, {
      numero_fogo: fogo,
      modelo: extra.modelo || 'Teste',
      tipo_pneu: extra.tipo_pneu || 'misto',
      condicao: extra.condicao || 'novo',
      sulco_inicial_mm: 14,
    });
  }

  const origA = await pneuEstoque('MATRIZ-8801');
  const subIncomp = await pneuEstoque('MATRIZ-8802', { condicao: 'recapado' });
  await ops.montarPneu({ filialId, pneuId: origA.id, veiculoId: truck.id, posicao: pos1E });

  const t1 = await expectThrow(
    () => ops.trocarPorEstoque({ filialId, pneuMontadoId: origA.id, pneuEstoqueId: subIncomp.id }),
    /recapado|dianteira|direcional/i
  );
  log(t1.ok, 'Substituto incompatível (recapado em 1E) rejeitado', t1.ok ? '' : t1.msg);
  const a1 = await estadoPneu(db, origA.id);
  const b1 = await estadoPneu(db, subIncomp.id);
  const oc1 = await ocupante(db, truck.id, pos1E);
  log(
    a1.status_pneu === 'montado' && a1.posicao === pos1E && b1.status_pneu === 'estoque' && Number(oc1?.id) === Number(origA.id),
    'Incompatível: original continua montado e posição íntegra'
  );

  const subIndisp = await pneuEstoque('MATRIZ-8803');
  await ops.registrarRecap({ filialId, pneuId: subIndisp.id });
  const t2 = await expectThrow(
    () => ops.trocarPorEstoque({ filialId, pneuMontadoId: origA.id, pneuEstoqueId: subIndisp.id }),
    /indisponível|recapagem/i
  );
  log(t2.ok, 'Substituto indisponível (em recapagem) rejeitado', t2.ok ? '' : t2.msg);
  const a2 = await estadoPneu(db, origA.id);
  log(a2.status_pneu === 'montado' && a2.posicao === pos1E, 'Indisponível: original continua montado');

  const subOutra = await ops.criarPneuEstoque(outra.id, {
    numero_fogo: 'LDT-0001',
    modelo: 'Outra',
    tipo_pneu: 'misto',
    condicao: 'novo',
  });
  const t3 = await expectThrow(
    () => ops.trocarPorEstoque({ filialId, pneuMontadoId: origA.id, pneuEstoqueId: subOutra.id }),
    /outra filial/i
  );
  log(t3.ok, 'Substituto de outra filial rejeitado', t3.ok ? '' : t3.msg);
  const a3 = await estadoPneu(db, origA.id);
  const o3 = await estadoPneu(db, subOutra.id);
  log(
    a3.status_pneu === 'montado' && o3.status_pneu === 'estoque' && Number(o3.filial_id) === Number(outra.id),
    'Outra filial: nenhum pneu alterado'
  );

  const movAntesCancel = await qtdMov(db, origA.id);
  await salvarSessao({
    filialId,
    telefone: '11988887777',
    chatJid: grupo,
    fluxo: 'recap',
    passo: 'substituto',
    dados: {
      pneu_id: origA.id,
      fogo: origA.numero_fogo,
      veiculo_id: truck.id,
      posicao: pos1E,
      placa: truck.placa,
    },
  });
  await processarMensagemMenu({
    filialId,
    phone: '11988887777',
    destino: '11988887777',
    chatJid: grupo,
    texto: '0',
  });
  const aCancel = await estadoPneu(db, origA.id);
  const movDepoisCancel = await qtdMov(db, origA.id);
  log(
    aCancel.status_pneu === 'montado' && aCancel.posicao === pos1E && movDepoisCancel === movAntesCancel,
    'Cancelamento no chatbot: original montado, sem gravar movimentação'
  );

  const tRecapSemSub = await expectThrow(
    () => ops.registrarRecap({ filialId, pneuId: origA.id }),
    /Informe o pneu do estoque/i
  );
  log(tRecapSemSub.ok, 'Recap montado sem substituto recusa e não esvazia', tRecapSemSub.ok ? '' : tRecapSemSub.msg);
  log((await estadoPneu(db, origA.id)).status_pneu === 'montado', 'Recap sem substituto: posição segue ocupada');

  const subTx = await pneuEstoque('MATRIZ-8804');
  const snapOrig = await estadoPneu(db, origA.id);
  const snapSub = await estadoPneu(db, subTx.id);
  const movOrigAntes = await qtdMov(db, origA.id);
  const movSubAntes = await qtdMov(db, subTx.id);
  process.env.PNEU_TEST_FALHAR_TX = '1';
  const tTx = await expectThrow(
    () => ops.trocarPorEstoque({ filialId, pneuMontadoId: origA.id, pneuEstoqueId: subTx.id }),
    /falha simulada/i
  );
  delete process.env.PNEU_TEST_FALHAR_TX;
  log(tTx.ok, 'Erro durante a transação lança falha', tTx.ok ? '' : tTx.msg);
  const afterOrig = await estadoPneu(db, origA.id);
  const afterSub = await estadoPneu(db, subTx.id);
  log(
    afterOrig.status_pneu === snapOrig.status_pneu
      && afterOrig.posicao === snapOrig.posicao
      && afterSub.status_pneu === snapSub.status_pneu
      && (await qtdMov(db, origA.id)) === movOrigAntes
      && (await qtdMov(db, subTx.id)) === movSubAntes,
    'Erro na transação: rollback restaura original, substituto e histórico'
  );

  const origRecap = await pneuEstoque('MATRIZ-8805');
  const subRecap = await pneuEstoque('MATRIZ-8806');
  await ops.montarPneu({ filialId, pneuId: origRecap.id, veiculoId: truck.id, posicao: posTracao });
  const recapOk = await ops.registrarRecap({
    filialId,
    pneuId: origRecap.id,
    pneuEstoqueId: subRecap.id,
  });
  const stRecapOrig = await estadoPneu(db, origRecap.id);
  const stRecapSub = await estadoPneu(db, subRecap.id);
  const ocRecap = await ocupante(db, truck.id, posTracao);
  const movRecapOrig = await db.prepare(`
    SELECT tipo FROM movimentacoes WHERE pneu_id = ? ORDER BY id
  `).all(origRecap.id);
  const tiposRecap = movRecapOrig.map((r) => r.tipo);
  log(recapOk.estava_montado === true && recapOk.substituto?.fogo === subRecap.numero_fogo, 'Recap bem-sucedida retorna substituto montado');
  log(
    stRecapOrig.status_pneu === 'recapagem'
      && stRecapOrig.veiculo_id == null
      && Number(stRecapOrig.vida_recap) >= 1
      && stRecapOrig.condicao === 'recapado'
      && stRecapSub.status_pneu === 'montado'
      && stRecapSub.posicao === posTracao
      && Number(ocRecap?.id) === Number(subRecap.id),
    'Recap: original em recapagem e posição ocupada pelo substituto'
  );
  log(tiposRecap.includes('retirada') && tiposRecap.includes('recap'), 'Recap: histórico retirada + recap');
  log(
    (await db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE pneu_id = ? AND tipo = 'montagem'`).get(subRecap.id)).n >= 1,
    'Recap: histórico de montagem do substituto'
  );

  const origDesc = await pneuEstoque('MATRIZ-8807');
  const subDesc = await pneuEstoque('MATRIZ-8808');
  const posDesc = '2EI';
  await ops.montarPneu({ filialId, pneuId: origDesc.id, veiculoId: truck.id, posicao: posDesc });
  const descOk = await ops.registrarDescarte({
    filialId,
    pneuId: origDesc.id,
    motivo: 'fim de vida teste',
    pneuEstoqueId: subDesc.id,
  });
  const stDescOrig = await estadoPneu(db, origDesc.id);
  const stDescSub = await estadoPneu(db, subDesc.id);
  const ocDesc = await ocupante(db, truck.id, posDesc);
  log(descOk.estava_montado === true && descOk.substituto?.fogo === subDesc.numero_fogo, 'Descarte bem-sucedido retorna substituto montado');
  log(
    stDescOrig.status_pneu === 'descarte'
      && Number(stDescOrig.ativo) === 0
      && stDescOrig.veiculo_id == null
      && stDescSub.status_pneu === 'montado'
      && stDescSub.posicao === posDesc
      && Number(ocDesc?.id) === Number(subDesc.id),
    'Descarte: original inativo e posição ocupada pelo substituto'
  );
  const tiposDesc = (await db.prepare(`SELECT tipo FROM movimentacoes WHERE pneu_id = ?`).all(origDesc.id)).map((r) => r.tipo);
  log(tiposDesc.includes('retirada') && tiposDesc.includes('descarte'), 'Descarte: histórico retirada + descarte');
  log(!(await ops.buscarPneuPorFogo(filialId, origDesc.numero_fogo)), 'Descarte: fogo original some da consulta ativa');

  const origTroca = await pneuEstoque('MATRIZ-8809');
  const subTroca = await pneuEstoque('MATRIZ-8810');
  const posTroca = '2DI';
  await ops.montarPneu({ filialId, pneuId: origTroca.id, veiculoId: truck.id, posicao: posTroca });
  const trocaOk = await ops.trocarPorEstoque({
    filialId,
    pneuMontadoId: origTroca.id,
    pneuEstoqueId: subTroca.id,
  });
  const stTrocaOrig = await estadoPneu(db, origTroca.id);
  const stTrocaSub = await estadoPneu(db, subTroca.id);
  const ocTroca = await ocupante(db, truck.id, posTroca);
  log(/Trocou/i.test(trocaOk.mensagem || ''), 'Troca bem-sucedida', trocaOk.mensagem);
  log(
    stTrocaOrig.status_pneu === 'estoque'
      && stTrocaOrig.veiculo_id == null
      && stTrocaSub.status_pneu === 'montado'
      && stTrocaSub.posicao === posTroca
      && Number(ocTroca?.id) === Number(subTroca.id),
    'Troca: original no estoque e substituto na mesma posição'
  );

  const recapEstoque = await pneuEstoque('MATRIZ-8811');
  const recapEst = await ops.registrarRecap({ filialId, pneuId: recapEstoque.id });
  log(recapEst.estava_montado === false && (await estadoPneu(db, recapEstoque.id)).status_pneu === 'recapagem', 'Recap de pneu já em estoque segue sem substituto');

  // --- Menu 5 e gestão web (mesmas ops atômicas) ---
  const origM5 = await estadoPneu(db, origA.id);
  log(origM5.status_pneu === 'montado' && origM5.posicao === pos1E, 'Pré-condição menu 5: original ainda montado em 1E');

  await salvarSessao({
    filialId,
    telefone: '11977770001',
    chatJid: grupo,
    fluxo: 'estoque',
    passo: 'fogo',
    dados: {},
  });
  await processarMensagemMenu({
    filialId,
    phone: '11977770001',
    destino: '11977770001',
    chatJid: grupo,
    texto: origA.numero_fogo,
  });
  const aposFogoM5 = await estadoPneu(db, origA.id);
  log(
    aposFogoM5.status_pneu === 'montado' && aposFogoM5.posicao === pos1E,
    'Menu 5: informar fogo montado NÃO desmonta antes do substituto'
  );

  await salvarSessao({
    filialId,
    telefone: '11977770002',
    chatJid: grupo,
    fluxo: 'estoque',
    passo: 'substituto',
    dados: {
      pneu_id: origA.id,
      fogo: origA.numero_fogo,
      veiculo_id: truck.id,
      posicao: pos1E,
      placa: truck.placa,
    },
  });
  await processarMensagemMenu({
    filialId,
    phone: '11977770002',
    destino: '11977770002',
    chatJid: grupo,
    texto: 'cancelar',
  });
  log(
    (await estadoPneu(db, origA.id)).status_pneu === 'montado',
    'Menu 5 cancelamento: original permanece montado'
  );

  await salvarSessao({
    filialId,
    telefone: '11977770003',
    chatJid: grupo,
    fluxo: 'estoque',
    passo: 'substituto',
    dados: {
      pneu_id: origA.id,
      fogo: origA.numero_fogo,
      veiculo_id: truck.id,
      posicao: pos1E,
      placa: truck.placa,
    },
  });
  await processarMensagemMenu({
    filialId,
    phone: '11977770003',
    destino: '11977770003',
    chatJid: grupo,
    texto: subIncomp.numero_fogo,
  });
  log(
    (await estadoPneu(db, origA.id)).status_pneu === 'montado'
      && (await estadoPneu(db, subIncomp.id)).status_pneu === 'estoque',
    'Menu 5 substituto incompatível: posição íntegra'
  );

  const tGestaoSemSub = await expectThrow(
    () => ops.registrarRecap({ filialId, pneuId: origA.id, pneuEstoqueId: null }),
    /Informe o pneu do estoque/i
  );
  log(tGestaoSemSub.ok, 'Gestão: recap montado sem substituto recusa', tGestaoSemSub.ok ? '' : tGestaoSemSub.msg);

  const tGestaoFilial = await expectThrow(
    () => ops.registrarDescarte({ filialId, pneuId: origA.id, pneuEstoqueId: subOutra.id }),
    /outra filial/i
  );
  log(tGestaoFilial.ok, 'Gestão: substituto de outra filial recusado', tGestaoFilial.ok ? '' : tGestaoFilial.msg);
  log((await estadoPneu(db, origA.id)).status_pneu === 'montado', 'Gestão outra filial: original intacto');

  const subM5 = await pneuEstoque('MATRIZ-8820');
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo, whatsapp)
    VALUES ('opm5', 'x', 'filial', 'funcionario', ?, 1, '11977770004')
  `).run(filialId);
  await salvarSessao({
    filialId,
    telefone: '11977770004',
    chatJid: grupo,
    fluxo: 'estoque',
    passo: 'substituto',
    dados: {
      pneu_id: origA.id,
      fogo: origA.numero_fogo,
      veiculo_id: truck.id,
      posicao: pos1E,
      placa: truck.placa,
    },
  });
  await processarMensagemMenu({
    filialId,
    phone: '11977770004',
    destino: '11977770004',
    chatJid: grupo,
    texto: subM5.numero_fogo,
    mensagemId: 'm5-sub',
  });
  log(
    (await estadoPneu(db, origA.id)).status_pneu === 'montado'
      && (await estadoPneu(db, subM5.id)).status_pneu === 'estoque',
    'Menu 5: substituto só pede confirmação'
  );
  await processarMensagemMenu({
    filialId,
    phone: '11977770004',
    destino: '11977770004',
    chatJid: grupo,
    texto: '1',
    mensagemId: 'm5-ok',
  });
  const stM5orig = await estadoPneu(db, origA.id);
  const stM5sub = await estadoPneu(db, subM5.id);
  const ocM5 = await ocupante(db, truck.id, pos1E);
  log(
    stM5orig.status_pneu === 'estoque'
      && stM5sub.status_pneu === 'montado'
      && stM5sub.posicao === pos1E
      && Number(ocM5?.id) === Number(subM5.id),
    'Menu 5 bem-sucedido: original no estoque e substituto montado'
  );

  const origG = await pneuEstoque('MATRIZ-8821');
  const subG = await pneuEstoque('MATRIZ-8822');
  await ops.montarPneu({ filialId, pneuId: origG.id, veiculoId: truck.id, posicao: '2DE' });
  const gestaoRecap = await ops.registrarRecap({
    filialId,
    pneuId: origG.id,
    pneuEstoqueId: subG.id,
  });
  log(
    gestaoRecap.substituto?.fogo === subG.numero_fogo
      && (await estadoPneu(db, origG.id)).status_pneu === 'recapagem'
      && (await ocupante(db, truck.id, '2DE'))?.id === subG.id,
    'Gestão recap bem-sucedida (ops atômico)'
  );

  const origGd = await pneuEstoque('MATRIZ-8823');
  const subGd = await pneuEstoque('MATRIZ-8824');
  const posLivre = (await ops.posicoesLivres(truck.id))[0];
  await ops.montarPneu({ filialId, pneuId: origGd.id, veiculoId: truck.id, posicao: posLivre });
  const gestaoDesc = await ops.registrarDescarte({
    filialId,
    pneuId: origGd.id,
    motivo: 'gestao',
    pneuEstoqueId: subGd.id,
  });
  log(
    gestaoDesc.substituto?.fogo === subGd.numero_fogo
      && (await estadoPneu(db, origGd.id)).status_pneu === 'descarte'
      && Number((await ocupante(db, truck.id, posLivre))?.id) === Number(subGd.id),
    'Gestão descarte bem-sucedido (ops atômico)'
  );

  const origVazio = await pneuEstoque('MATRIZ-8830');
  const posVazio = (await ops.posicoesLivres(truck.id))[0];
  await ops.montarPneu({ filialId, pneuId: origVazio.id, veiculoId: truck.id, posicao: posVazio });
  const tSemAuth = await expectThrow(
    () => ops.enviarAoEstoqueOuTrocar({ filialId, pneuId: origVazio.id }),
    /permitir_vazio|Informe o pneu do estoque/i
  );
  log(tSemAuth.ok, 'Desmontar sem substituto e sem autorização recusa', tSemAuth.ok ? '' : tSemAuth.msg);
  log(
    (await estadoPneu(db, origVazio.id)).status_pneu === 'montado'
      && Number((await ocupante(db, truck.id, posVazio))?.id) === Number(origVazio.id),
    'Desmontar recusado: posição continua ocupada'
  );

  const simples = await ops.enviarAoEstoqueOuTrocar({
    filialId,
    pneuId: origVazio.id,
    permitirVazio: true,
    detalhes: 'teste desmontagem simples',
  });
  log(
    simples.modo === 'desmontagem_simples'
      && (await estadoPneu(db, origVazio.id)).status_pneu === 'estoque'
      && !(await ocupante(db, truck.id, posVazio)),
    'Desmontagem simples autorizada esvazia a posição de propósito'
  );

  const origHttp = await pneuEstoque('MATRIZ-8831');
  const subHttp = await pneuEstoque('MATRIZ-8832');
  const subHttp2 = await pneuEstoque('MATRIZ-8833');
  const origHttp2 = await pneuEstoque('MATRIZ-8834');
  const origHttp3 = await pneuEstoque('MATRIZ-8835');
  const livresHttp = await ops.posicoesLivres(truck.id);
  await ops.montarPneu({ filialId, pneuId: origHttp.id, veiculoId: truck.id, posicao: livresHttp[0] });
  await ops.montarPneu({ filialId, pneuId: origHttp2.id, veiculoId: truck.id, posicao: livresHttp[1] });
  await ops.montarPneu({ filialId, pneuId: origHttp3.id, veiculoId: truck.id, posicao: livresHttp[2] });

  const express = (await import('express')).default;
  const authRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/auth.js')))).default;
  const pneusRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/pneus.js')))).default;
  const arRouter = (await import(toFileUrl(path.join(BACKEND, 'src/routes/acesso-rapido.js')))).default;
  const { gerarTokenAcessoRapido } = await import(toFileUrl(path.join(BACKEND, 'src/services/acesso-rapido.js')));

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/pneus', pneusRouter);
  app.use('/api/acesso-rapido', arRouter);
  const httpServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = httpServer.address();
  const api = `http://127.0.0.1:${port}/api`;

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
  log(login.status === 200 && !!jwtTok, 'HTTP login matriz para testar endpoints');

  const semFlag = await http('POST', `/pneus/${origHttp.id}/desmontar`, { token: jwtTok, body: {} });
  log(semFlag.status === 400, 'POST /desmontar sem substituto e sem flag → 400', String(semFlag.dados?.erro || semFlag.status));
  log(
    (await estadoPneu(db, origHttp.id)).status_pneu === 'montado',
    'POST /desmontar recusado: original permanece montado'
  );

  const montado1E = await ocupante(db, truck.id, pos1E);
  const incomp = await http('POST', `/pneus/${montado1E.id}/desmontar`, {
    token: jwtTok,
    body: { montar_pneu_id: subIncomp.id },
  });
  log(incomp.status === 400, 'POST /desmontar substituto incompatível → 400', String(incomp.dados?.erro || incomp.status));
  log(
    (await estadoPneu(db, montado1E.id)).status_pneu === 'montado'
      && (await estadoPneu(db, subIncomp.id)).status_pneu === 'estoque',
    'POST /desmontar incompatível: nada gravado'
  );

  const outraFil = await http('POST', `/pneus/${origHttp.id}/desmontar`, {
    token: jwtTok,
    body: { montar_pneu_id: subOutra.id },
  });
  log(outraFil.status === 400, 'POST /desmontar outra filial → 400', String(outraFil.dados?.erro || outraFil.status));
  log((await estadoPneu(db, origHttp.id)).status_pneu === 'montado', 'POST /desmontar outra filial: original intacto');

  const trocaHttp = await http('POST', `/pneus/${origHttp.id}/desmontar`, {
    token: jwtTok,
    body: { montar_pneu_id: subHttp.id },
  });
  log(
    [200, 201].includes(trocaHttp.status)
      && (await estadoPneu(db, origHttp.id)).status_pneu === 'estoque'
      && (await estadoPneu(db, subHttp.id)).status_pneu === 'montado',
    'POST /desmontar com montar_pneu_id faz troca atômica'
  );

  const simplesHttp = await http('POST', `/pneus/${origHttp2.id}/desmontar`, {
    token: jwtTok,
    body: { permitir_vazio: true, detalhes: 'HTTP desmontagem simples' },
  });
  log(
    simplesHttp.status === 200
      && (await estadoPneu(db, origHttp2.id)).status_pneu === 'estoque'
      && simplesHttp.dados?.modo === 'desmontagem_simples',
    'POST /desmontar com permitir_vazio autoriza desmontagem simples'
  );

  const { token: tokAr } = await gerarTokenAcessoRapido({
    tipo: 'medir',
    veiculoId: truck.id,
    filialId,
  });
  const arSem = await http('POST', '/acesso-rapido/pneu-acao', {
    body: { token: tokAr, acao: 'estoque', pneu_id: origHttp3.id },
  });
  log(arSem.status === 400, 'pneu-acao estoque sem substituto → 400', String(arSem.dados?.erro || arSem.status));
  log((await estadoPneu(db, origHttp3.id)).status_pneu === 'montado', 'pneu-acao estoque recusado: posição íntegra');

  const arTroca = await http('POST', '/acesso-rapido/pneu-acao', {
    body: {
      token: tokAr,
      acao: 'estoque',
      pneu_id: origHttp3.id,
      montar_pneu_id: subHttp2.id,
    },
  });
  log(
    [200, 201].includes(arTroca.status)
      && (await estadoPneu(db, origHttp3.id)).status_pneu === 'estoque'
      && (await estadoPneu(db, subHttp2.id)).status_pneu === 'montado',
    'pneu-acao estoque com montar_pneu_id: troca atômica (modal do link)'
  );

  const origArSimples = await pneuEstoque('MATRIZ-8836');
  const posArSimples = (await ops.posicoesLivres(truck.id))[0];
  await ops.montarPneu({ filialId, pneuId: origArSimples.id, veiculoId: truck.id, posicao: posArSimples });
  const arSimples = await http('POST', '/acesso-rapido/pneu-acao', {
    body: {
      token: tokAr,
      acao: 'estoque',
      pneu_id: origArSimples.id,
      permitir_vazio: true,
    },
  });
  log(
    arSimples.status === 200 && (await estadoPneu(db, origArSimples.id)).status_pneu === 'estoque',
    'pneu-acao estoque com permitir_vazio: desmontagem simples'
  );

  await new Promise((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });

  await closePool();
  try { await pglite.server?.stop?.(); } catch { /* ignore */ }

  console.log('');
  console.log(`RESULTADO ${oks} OK / ${fails} FAIL`);
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
