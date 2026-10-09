/**
 * Webhook WuzAPI — placa → link de medição
 * Só responde no grupo selecionado no painel (passo 2). Privado e outros grupos são ignorados.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { enviarERegistrar, normalizarDestino, telefoneConfiavel } from '../services/whatsapp.js';
import { processarMensagemMenu, resolverUnidadeOficial } from '../services/whatsapp-menu.js';

const router = Router();

/** Rate limit simples: max 30 req/min por remetente (não pelo grupo inteiro) */
const rateBuckets = new Map();

function rateLimitOk(key) {
  const k = key || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(k);
  if (!bucket || now - bucket.start > 60_000) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(k, bucket);
  }
  bucket.count += 1;
  return bucket.count <= 30;
}

/** WuzAPI/WhatsApp reenvia o mesmo evento (ID, LID e @g.us). Sem isso menu, placa e fogo saem 2–3×. */
const mensagensVistas = new Map();
const DEDUP_ID_MS = 120_000;
const DEDUP_TEXTO_MS = 25_000;

function limparMensagensVistas(now) {
  if (mensagensVistas.size < 80) return;
  for (const [chave, visto] of mensagensVistas) {
    if (now - visto.ts > DEDUP_ID_MS) mensagensVistas.delete(chave);
  }
}

function chaveTextoWebhook(filialId, body) {
  const placa = normalizarPlacaTexto(body);
  if (placa.length >= 3 && placa.length <= 12 && /[A-Z]/.test(placa) && /[0-9]/.test(placa)) {
    return `p:${Number(filialId) || 0}|${placa}`;
  }
  const texto = String(body || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `t:${Number(filialId) || 0}|${texto}`;
}

/** true = já tratamos; false = primeira vez (marca na hora, antes do próximo await) */
export function mensagemDuplicada({ id, filialId, body }) {
  const now = Date.now();
  limparMensagensVistas(now);
  if (id) {
    const chaveId = `id:${id}`;
    const prev = mensagensVistas.get(chaveId);
    if (prev && now - prev.ts < DEDUP_ID_MS) return true;
    mensagensVistas.set(chaveId, { ts: now });
    return false;
  }
  const texto = String(body || '').trim();
  if (texto) {
    const chaveTxt = chaveTextoWebhook(filialId, texto);
    const prev = mensagensVistas.get(chaveTxt);
    if (prev && now - prev.ts < DEDUP_TEXTO_MS) return true;
    mensagensVistas.set(chaveTxt, { ts: now });
  }
  return false;
}

function normalizarPlacaTexto(texto) {
  return String(texto || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function validarHmacWebhook(req) {
  const secret = config.wuzapiWebhookSecret;
  if (!secret) return true;

  const signature = req.headers['x-hmac-signature'] || req.headers['x-hub-signature'];
  if (!signature) {
    // Secret no .env sem HMAC ativo no WuzAPI — não bloquear o fluxo placa→link
    console.warn('[webhook] HMAC configurado mas assinatura ausente — aceitando mensagem');
    return true;
  }

  const raw = typeof req.rawBody === 'string'
    ? req.rawBody
    : JSON.stringify(req.body || {});
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const received = String(signature).replace(/^sha256=/i, '');

  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(received, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return expected === received;
  }
}

/** Raiz do payload (WuzAPI real: `event`; legado/testes: `data`) */
export function desempacotarPayloadWuzapi(payload) {
  if (!payload || typeof payload !== 'object') return payload || {};
  const packed = payload.jsonData ?? payload.json;
  if (typeof packed === 'string' && packed.trim()) {
    try {
      const parsed = JSON.parse(packed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignora JSON inválido
    }
  }
  if (packed && typeof packed === 'object') return packed;
  return payload;
}

export function raizPayloadMensagem(payload) {
  const p = desempacotarPayloadWuzapi(payload);
  if (!p || typeof p !== 'object') return {};
  const d = p.data;
  if (d && typeof d === 'object' && (d.Info || d.info || d.Message || d.message)) return d;
  const e = p.event;
  if (e && typeof e === 'object' && !Array.isArray(e)
    && (e.Info || e.info || e.Message || e.message || e.Conversation || e.conversation)) {
    return e;
  }
  return p;
}

function ehMensagemPropria(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const flags = [
    info.IsFromMe,
    info.isFromMe,
    info.FromMe,
    info.fromMe,
    root.fromMe,
    event?.fromMe,
    event?.isFromMe,
  ];
  return flags.some((v) => v === true || v === 'true' || v === 1 || v === '1');
}

/** O chip único do chatbot não é operador. Eco e mensagem enviada pelo bot não abrem sessão. */
function deveIgnorarMensagemPropria(event) {
  return ehMensagemPropria(event);
}

export function extrairIdMensagem(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const source = info.MessageSource || info.messageSource || {};
  const candidates = [
    info.ID,
    info.Id,
    info.id,
    info.StanzaID,
    info.stanzaId,
    info.MessageID,
    info.messageId,
    source.ID,
    source.Id,
    source.id,
    root.ID,
    root.id,
    event?.id,
    event?.messageId,
    event?.stanzaId,
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s) return s;
  }
  return null;
}

export function extrairChatJid(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const candidates = [
    info.Chat,
    info.chat,
    info.RemoteJid,
    info.remoteJid,
    info.MessageSource?.Chat,
    info.MessageSource?.chat,
    root.chat,
    root.Chat,
    root.from,
    event?.from,
  ];
  const grupos = [];
  const outros = [];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    if (s.includes('@g.us')) grupos.push(s);
    else if (s.includes('@s.whatsapp.net') || s.includes('@lid') || /\d/.test(s)) outros.push(s);
  }
  return grupos[0] || outros[0] || null;
}

export function extrairTelefone(event, ignorar = []) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const source = info.MessageSource || info.messageSource || {};
  const bloqueados = new Set(
    (Array.isArray(ignorar) ? ignorar : [ignorar])
      .map((n) => telefoneConfiavel(n))
      .filter(Boolean),
  );
  // SenderAlt costuma ser o número real quando Sender vem como @lid.
  // O número do chatbot, se aparecer no payload, não substitui o remetente.
  const candidates = [
    info.SenderAlt,
    info.senderAlt,
    source.SenderAlt,
    source.senderAlt,
    info.Sender,
    info.sender,
    source.Sender,
    source.sender,
    info.Participant,
    info.participant,
    root.participant,
    root.sender,
    root.from,
    event?.participant,
    event?.sender,
    event?.from,
    event?.Phone,
  ];
  for (const c of candidates) {
    const phone = telefoneConfiavel(c);
    if (phone && !bloqueados.has(phone)) return phone;
  }
  return null;
}

export function extrairTextoMensagem(event) {
  if (typeof event?.body === 'string' && event.body.trim()) return event.body.trim();
  if (typeof event?.text === 'string' && event.text.trim()) return event.text.trim();
  if (typeof event?.Body === 'string' && event.Body.trim()) return event.Body.trim();

  const root = raizPayloadMensagem(event);
  const msg = root.Message || root.message || root;
  if (!msg || typeof msg !== 'object') return null;

  const nested = msg.message || msg.Message || msg;
  const text =
    nested.conversation
    || nested.Conversation
    || nested.extendedTextMessage?.text
    || nested.ExtendedTextMessage?.Text
    || nested.extendedTextMessage?.Text
    || nested.ExtendedTextMessage?.text
    || nested.text
    || nested.Text
    || nested.caption
    || nested.Caption
    || msg.conversation
    || msg.Conversation
    || msg.text
    || null;

  return text ? String(text).trim() : null;
}

function ehMensagemDeGrupo(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const flag = [info.IsGroup, info.isGroup, info.IsGroupMessage, root.isGroup, event?.isGroup]
    .some((v) => v === true || v === 'true' || v === 1 || v === '1');
  if (flag) return true;
  const jid = extrairChatJid(event) || '';
  return String(jid).includes('@g.us');
}

/** Resolve canal só pelo JID oficial gravado. Nome do grupo e texto não identificam a unidade. */
async function resolverCanalFilial(chatJid) {
  const filial = await resolverUnidadeOficial(chatJid);
  if (!filial) return null;
  const replyTo = normalizarDestino(filial.whatsapp_grupo)?.phone
    || String(filial.whatsapp_grupo).trim();
  return { filial, replyTo, escopoFilialId: filial.id };
}

router.post('/whatsapp', async (req, res) => {
  try {
    if (!validarHmacWebhook(req)) {
      return res.status(401).json({ erro: 'Assinatura HMAC inválida' });
    }

    const event = desempacotarPayloadWuzapi(req.body || {});
    // WuzAPI envia type:"Message" e event:<objeto>; não usar event.event como nome
    const eventName = event.type || event.Event
      || (typeof event.event === 'string' ? event.event : '')
      || '';

    const temMensagem = Boolean(
      extrairTextoMensagem(event)
      || event?.data?.message
      || event?.data?.Message
      || event?.message
      || event?.Message
      || (event?.event && typeof event.event === 'object' && (event.event.Message || event.event.message))
    );

    // Só Message. ReadReceipt/HistorySync às vezes trazem o mesmo texto e repetem o menu.
    if (eventName && !/^message$/i.test(String(eventName).trim())) {
      return res.status(200).json({ ok: true, ignored: true, tipo: eventName });
    }
    if (!eventName && !temMensagem) {
      return res.status(200).json({ ok: true, ignored: true, tipo: '(vazio)' });
    }

    if (deveIgnorarMensagemPropria(event)) {
      return res.status(200).json({ ok: true, ignored: 'from_me' });
    }

    const chatJid = extrairChatJid(event);
    const isGroup = ehMensagemDeGrupo(event) || Boolean(normalizarDestino(chatJid)?.isGroup);
    let phone = extrairTelefone(event);
    const body = extrairTextoMensagem(event);
    const msgId = extrairIdMensagem(event);

    console.log('[webhook] msg', {
      event: eventName || '(sem nome)',
      id: msgId,
      chat: chatJid,
      isGroup,
      phone,
      body: body ? String(body).slice(0, 80) : null,
      filial_hint: null,
      from_me: ehMensagemPropria(event),
    });

    if (!body) {
      return res.status(200).json({ ok: true, ignored: 'sem_texto' });
    }

    const canal = await resolverCanalFilial(chatJid);

    if (!canal) {
      console.info('[webhook] ignorado (fora do grupo selecionado)', {
        chat: chatJid,
        isGroup,
        filial_hint: null,
      });
      return res.status(200).json({
        ok: true,
        ignored: isGroup ? 'grupo_nao_selecionado' : 'somente_grupo_selecionado',
        chat: chatJid,
      });
    }

    // 3 POSTs do mesmo comando (ID repetido, LID vs telefone, placa com token diferente).
    if (mensagemDuplicada({
      id: msgId,
      filialId: canal.escopoFilialId,
      body,
    })) {
      console.info('[webhook] ignorado (duplicada)', {
        id: msgId,
        chat: chatJid,
        filial: canal.escopoFilialId,
        body: String(body).slice(0, 40),
      });
      return res.status(200).json({ ok: true, ignored: 'duplicada', id: msgId });
    }

    phone = extrairTelefone(event, [canal.filial.whatsapp]);
    const destinoEnvio = canal.replyTo;
    if (!destinoEnvio) {
      return res.status(200).json({ ok: true, ignored: 'sem_destino' });
    }

    // Rate limit por remetente (não pelo grupo — evita bloquear a frota inteira)
    const rateKey = phone || destinoEnvio;
    if (!rateLimitOk(rateKey)) {
      console.warn(`[webhook] Rate limit: ${rateKey}`);
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem: '⏳ Muitas consultas em pouco tempo. Aguarde 1 minuto e envie a placa novamente.',
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: null,
      });
      return res.status(200).json({ ok: true, rate_limited: true });
    }

    const texto = String(body || '').trim();

    // Menu numerado + fluxos A/B/C (medir, cadastros, troca, recap, descarte, relatório…)
    res.status(200).json({ ok: true, aceito: true, via: 'menu' });
    processarMensagemMenu({
      texto,
      phone,
      destino: destinoEnvio,
      filialId: canal?.escopoFilialId || null,
      chatJid: chatJid || null,
      mensagemId: msgId || null,
    }).then((r) => {
      if (r?.handled) {
        console.log('[webhook] menu handled', {
          phone,
          filial: canal?.escopoFilialId || null,
          texto: texto.slice(0, 40),
        });
        return;
      }
      // Conversa livre no grupo — não responde
      console.log('[webhook] ignorado (conversa)', { texto: texto.slice(0, 40) });
    }).catch((err) => {
      console.error('[webhook] menu falhou:', err.message);
      enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem: `❌ Erro: ${err.message}\n\nDigite *menu*.`,
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: null,
      }).catch(() => {});
    });
    return;
  } catch (err) {
    console.error('Webhook WhatsApp erro:', err);
    if (!res.headersSent) {
      res.status(500).json({ erro: err.message });
    }
  }
});

export default router;
