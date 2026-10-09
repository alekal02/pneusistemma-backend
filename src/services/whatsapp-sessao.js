/**
 * Sessões de conversa do chatbot WhatsApp (menu numerado).
 * Chave = filial + telefone real do remetente. Sem telefone não há sessão
 * e o fluxo de um participante não continua o de outro.
 */
import { getDb } from '../database.js';
import { telefoneConfiavel } from './whatsapp.js';

export function chaveSessao(filialId, telefone, chatJid = '') {
  const tel = telefoneConfiavel(telefone);
  if (!tel) return null;
  return `${Number(filialId)}:${tel}:${String(chatJid || '').slice(0, 40)}`;
}

function idGrupo(jid) {
  return String(jid || '').replace(/@g\.us$/i, '').replace(/[^\d]/g, '');
}

function mesmoGrupo(a, b) {
  return idGrupo(a) === idGrupo(b);
}

function parseDados(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    dados: parseDados(row.dados),
  };
}

export async function obterSessao(filialId, telefone, chatJid = '') {
  const db = getDb();
  await db.prepare(`DELETE FROM whatsapp_sessoes WHERE expira_em < NOW()`).run();

  const tel = telefoneConfiavel(telefone);
  if (!tel) return null;

  const chave = chaveSessao(filialId, tel, chatJid);
  let row = await db.prepare(`
    SELECT * FROM whatsapp_sessoes
    WHERE chave = ? AND fluxo <> 'recibo_medicao'
  `).get(chave);
  if (row) return mapRow(row);

  // O mesmo remetente em outro grupo não continua esta sessão.
  // Formatos diferentes do mesmo JID (com ou sem sufixo) continuam.
  const rows = await db.prepare(`
    SELECT * FROM whatsapp_sessoes
    WHERE filial_id = ?
      AND fluxo <> 'recibo_medicao'
      AND regexp_replace(COALESCE(telefone, ''), '[^0-9]', '', 'g') = ?
      AND expira_em >= NOW()
    ORDER BY atualizado_em DESC
  `).all(filialId, tel);
  row = (rows || []).find((r) => mesmoGrupo(r.chat_jid, chatJid));
  if (row) return mapRow(row);

  return null;
}

export async function salvarSessao({
  filialId,
  telefone,
  chatJid = null,
  fluxo,
  passo,
  dados = {},
}) {
  const db = getDb();
  const chave = chaveSessao(filialId, telefone, chatJid);
  if (!chave) return null;
  const dadosJson = JSON.stringify(dados || {});
  await db.prepare(`
    INSERT INTO whatsapp_sessoes (
      chave, filial_id, chat_jid, telefone, fluxo, passo, dados, atualizado_em, expira_em
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?::jsonb, NOW(), NOW() + INTERVAL '15 minutes'
    )
    ON CONFLICT (chave) DO UPDATE SET
      fluxo = EXCLUDED.fluxo,
      passo = EXCLUDED.passo,
      dados = EXCLUDED.dados,
      chat_jid = EXCLUDED.chat_jid,
      telefone = EXCLUDED.telefone,
      atualizado_em = NOW(),
      expira_em = NOW() + INTERVAL '15 minutes'
  `).run(
    chave,
    filialId,
    chatJid,
    telefone || null,
    fluxo,
    passo,
    dadosJson
  );
  return obterSessao(filialId, telefone, chatJid);
}

export async function limparSessao(filialId, telefone, chatJid = '') {
  const db = getDb();
  const tel = telefoneConfiavel(telefone);
  if (!tel) return;
  const chave = chaveSessao(filialId, tel, chatJid);
  const rows = await db.prepare(`
    SELECT chave, chat_jid FROM whatsapp_sessoes
    WHERE filial_id = ?
      AND fluxo <> 'recibo_medicao'
      AND regexp_replace(COALESCE(telefone, ''), '[^0-9]', '', 'g') = ?
  `).all(filialId, tel);
  for (const row of rows || []) {
    if (row.chave === chave || mesmoGrupo(row.chat_jid, chatJid)) {
      await db.prepare(`
        DELETE FROM whatsapp_sessoes WHERE chave = ? AND fluxo <> 'recibo_medicao'
      `).run(row.chave);
    }
  }
}

/**
 * Reserva a confirmação da medição de forma atômica.
 * O recibo pelo ID da mensagem impede um retry do webhook de gravar de novo,
 * mesmo depois que a deduplicação em memória expira ou o processo reinicia.
 * Deve rodar dentro da mesma transação que grava as medições.
 */
function listaSegura(valores, fallback) {
  const itens = (Array.isArray(valores) && valores.length ? valores : fallback)
    .map((v) => String(v || '').trim())
    .filter((v) => /^[a-z0-9_]+$/i.test(v));
  return itens.length ? itens : fallback;
}

export async function reivindicarGravacaoMedicao({
  filialId, telefone, chatJid, mensagemId, fluxos, passos,
}) {
  const db = getDb();
  const tel = telefoneConfiavel(telefone);
  if (!tel || !chaveSessao(filialId, tel, chatJid)) {
    const err = new Error('Não identifiquei seu número neste grupo.');
    err.codigo = 'remetente';
    throw err;
  }
  const fluxosOk = listaSegura(fluxos, ['medir_wa']);
  const passosOk = listaSegura(passos, ['confirma']);
  const candidatas = await db.prepare(`
    SELECT id, chat_jid FROM whatsapp_sessoes
    WHERE filial_id = ?
      AND fluxo IN (${fluxosOk.map(() => '?').join(', ')})
      AND passo IN (${passosOk.map(() => '?').join(', ')})
      AND expira_em >= NOW()
      AND regexp_replace(COALESCE(telefone, ''), '[^0-9]', '', 'g') = ?
    ORDER BY atualizado_em DESC
    FOR UPDATE
  `).all(filialId, ...fluxosOk, ...passosOk, tel);
  const row = (candidatas || []).find((r) => mesmoGrupo(r.chat_jid, chatJid));
  if (!row) {
    const err = new Error('Essa confirmação já foi registrada.');
    err.codigo = 'duplicada';
    throw err;
  }
  const claimed = await db.prepare(`
    UPDATE whatsapp_sessoes
    SET passo = 'gravando', atualizado_em = NOW()
    WHERE id = ? AND passo IN (${passosOk.map(() => '?').join(', ')})
    RETURNING id
  `).get(row.id, ...passosOk);
  if (!claimed) {
    const err = new Error('Essa confirmação já foi registrada.');
    err.codigo = 'duplicada';
    throw err;
  }
  const idMsg = String(mensagemId || '').trim();
  if (!idMsg) return;
  const recibo = `recibo:${Number(filialId)}:${idMsg.slice(0, 180)}`;
  const ins = await db.prepare(`
    INSERT INTO whatsapp_sessoes (
      chave, filial_id, chat_jid, telefone, fluxo, passo, dados, atualizado_em, expira_em
    ) VALUES (
      ?, ?, NULL, ?, 'recibo_medicao', 'gravado', '{}'::jsonb, NOW(), NOW() + INTERVAL '90 days'
    )
    ON CONFLICT (chave) DO NOTHING
  `).run(recibo, filialId, telefoneConfiavel(telefone));
  if (!ins.changes) {
    const err = new Error('Essa confirmação já foi registrada.');
    err.codigo = 'duplicada';
    throw err;
  }
}

export async function atualizarDadosSessao(sessao, patch, { passo, fluxo } = {}) {
  return salvarSessao({
    filialId: sessao.filial_id,
    telefone: sessao.telefone,
    chatJid: sessao.chat_jid,
    fluxo: fluxo || sessao.fluxo,
    passo: passo || sessao.passo,
    dados: { ...(sessao.dados || {}), ...patch },
  });
}
