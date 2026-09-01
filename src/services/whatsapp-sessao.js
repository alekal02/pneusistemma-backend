/**
 * Sessões de conversa do chatbot WhatsApp (menu numerado).
 * Chave = filial + remetente (cada pessoa no grupo tem seu fluxo).
 */
import { getDb } from '../database.js';

const TTL_MIN = 15;

export function chaveSessao(filialId, telefone, chatJid = '') {
  const tel = String(telefone || '').replace(/\D/g, '') || 'anon';
  return `${Number(filialId)}:${tel}:${String(chatJid || '').slice(0, 40)}`;
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

  const chave = chaveSessao(filialId, telefone, chatJid);
  let row = await db.prepare(`
    SELECT * FROM whatsapp_sessoes WHERE chave = ?
  `).get(chave);
  if (row) return mapRow(row);

  // Fallback: mesmo telefone na filial (chat_jid pode variar entre eventos do WuzAPI)
  const tel = String(telefone || '').replace(/\D/g, '');
  if (tel) {
    row = await db.prepare(`
      SELECT * FROM whatsapp_sessoes
      WHERE filial_id = ? AND telefone = ? AND expira_em >= NOW()
      ORDER BY atualizado_em DESC
      LIMIT 1
    `).get(filialId, telefone);
    if (!row) {
      row = await db.prepare(`
        SELECT * FROM whatsapp_sessoes
        WHERE filial_id = ?
          AND regexp_replace(COALESCE(telefone, ''), '[^0-9]', '', 'g') = ?
          AND expira_em >= NOW()
        ORDER BY atualizado_em DESC
        LIMIT 1
      `).get(filialId, tel);
    }
    if (row) return mapRow(row);
  }

  // Fallback: mesmo grupo na filial (telefone às vezes vem vazio)
  const jid = String(chatJid || '').trim();
  if (jid) {
    row = await db.prepare(`
      SELECT * FROM whatsapp_sessoes
      WHERE filial_id = ? AND chat_jid = ? AND expira_em >= NOW()
      ORDER BY atualizado_em DESC
      LIMIT 1
    `).get(filialId, jid);
    if (row) return mapRow(row);
  }

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
  const chave = chaveSessao(filialId, telefone, chatJid);
  await db.prepare(`DELETE FROM whatsapp_sessoes WHERE chave = ?`).run(chave);

  // Limpa também sessões “órfãs” do mesmo telefone/grupo (fallbacks)
  const tel = String(telefone || '').replace(/\D/g, '');
  if (tel) {
    await db.prepare(`
      DELETE FROM whatsapp_sessoes
      WHERE filial_id = ?
        AND regexp_replace(COALESCE(telefone, ''), '[^0-9]', '', 'g') = ?
    `).run(filialId, tel);
  }
  const jid = String(chatJid || '').trim();
  if (jid) {
    await db.prepare(`
      DELETE FROM whatsapp_sessoes
      WHERE filial_id = ? AND chat_jid = ?
    `).run(filialId, jid);
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
