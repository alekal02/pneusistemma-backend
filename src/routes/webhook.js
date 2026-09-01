/**
 * Webhook WuzAPI — placa → link de medição
 * Aceita chat privado ou grupo cadastrado na filial.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getDb } from '../database.js';
import { config } from '../config.js';
import { enviarERegistrar, limparTelefone, normalizarDestino, idGrupoCanonico } from '../services/whatsapp.js';
import { processarMensagemMenu } from '../services/whatsapp-menu.js';

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

/**
 * WuzAPI default (WEBHOOK_FORMAT=form) manda { jsonData: "<json>", token }.
 * Sem isso o texto some e o bot ignora menu/placa em silêncio.
 */
export function desempacotarPayloadWuzapi(payload) {
  if (!payload || typeof payload !== 'object') return payload || {};
  const packed = payload.jsonData ?? payload.json;
  if (typeof packed === 'string' && packed.trim()) {
    try {
      const parsed = JSON.parse(packed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // payload inválido — segue o original
    }
  }
  if (packed && typeof packed === 'object') return packed;
  return payload;
}

/** Raiz do payload (WuzAPI real: `event`; legado/testes: `data`) */
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

/** Ignora eco do bot; permite testar placa/comando pelo próprio chip */
function deveIgnorarMensagemPropria(event) {
  if (!ehMensagemPropria(event)) return false;
  const text = String(extrairTextoMensagem(event) || '').trim();
  if (!text) return true;
  // Eco das respostas do sistema
  if (/Abrir medi|Link v[aá]lido|ALERTA DE PNEU|Frota cadastrada|Frota completa|n[aã]o encontrada|relat[oó]rio gerencial|Gerando o \*relat|PneuSistemma — Menu|Confirma |enviado para recap|recebido da recap|\*Enviar pneu para recap\*|j[aá] est[aá] em recapagem|Posi[cç][aã]o vaga/i.test(text)) {
    return true;
  }
  // Comandos e placa pura → processa mesmo se fromMe
  const cmd = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (/^(frota|placas|lista|ajuda|help|menu|\?|cancelar|cancela|sair|voltar)$/i.test(cmd)) return false;
  if (/^(relatorio|report|pdf)\b/i.test(cmd)) return false;
  if (/^[0-9]$/.test(cmd)) return false;
  if (/^(recap|recapagem|receber(\s+recap)?|pneu\s+fogo)\b/i.test(cmd)) return false;
  const placa = normalizarPlacaTexto(text);
  if (/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) return false;
  return true;
}

function jidsGrupoIguais(a, b) {
  const idA = idGrupoCanonico(a);
  const idB = idGrupoCanonico(b);
  if (idA && idB && idA === idB) return true;
  const na = normalizarDestino(a);
  const nb = normalizarDestino(b);
  if (na?.isGroup && nb?.isGroup && na.logKey === nb.logKey) return true;
  return false;
}

export function extrairChatJid(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const src = info.MessageSource || info.messageSource || {};
  const candidates = [
    info.Chat,
    info.chat,
    info.RemoteJid,
    info.remoteJid,
    info.RecipientAlt,
    info.recipientAlt,
    info.ChatAlt,
    info.chatAlt,
    src.Chat,
    src.chat,
    src.RecipientAlt,
    src.recipientAlt,
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

function flagMensagemGrupo(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  return [info.IsGroup, info.isGroup, info.IsGroupMessage, root.isGroup, event?.isGroup, event?.IsGroup]
    .some((v) => v === true || v === 'true' || v === 1 || v === '1');
}

function extrairJidGrupo(event) {
  const jid = extrairChatJid(event);
  if (jid && String(jid).includes('@g.us')) return String(jid);
  if (jid && idGrupoCanonico(jid)) {
    const id = idGrupoCanonico(jid);
    return `${id}@g.us`;
  }
  return null;
}

export function extrairTelefone(event) {
  const root = raizPayloadMensagem(event);
  const info = root.Info || root.info || {};
  const candidates = [
    info.Sender,
    info.sender,
    info.Participant,
    info.participant,
    root.from,
    info.Chat,
    event?.from,
    event?.sender,
    event?.Phone,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (String(c).includes('@g.us')) continue;
    const phone = limparTelefone(c);
    if (phone) return phone;
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
  if (flagMensagemGrupo(event)) return true;
  const jid = extrairJidGrupo(event) || extrairChatJid(event) || '';
  return String(jid).includes('@g.us') || Boolean(idGrupoCanonico(jid));
}

function ehChatDeGrupo(chatJid, isGroupFlag = false) {
  if (isGroupFlag) return true;
  const jid = String(chatJid || '');
  return jid.includes('@g.us') || Boolean(idGrupoCanonico(jid));
}

/** Resolve canal da unidade a partir do chat (grupo ou número do chatbot) */
async function resolverCanalFilial(db, chatJid, phone, filialIdHint = null, isGroup = false) {
  const chatDeGrupo = ehChatDeGrupo(chatJid, isGroup);

  let sql = `
    SELECT id, nome, codigo, whatsapp, whatsapp_grupo, wuzapi_token
    FROM filiais
    WHERE ativo = 1
  `;
  const params = [];
  if (filialIdHint) {
    sql += ` AND id = ?`;
    params.push(filialIdHint);
  } else {
    sql += ` AND (
      (whatsapp IS NOT NULL AND TRIM(whatsapp) != '')
      OR (whatsapp_grupo IS NOT NULL AND TRIM(whatsapp_grupo) != '')
    )`;
  }
  const filiais = await db.prepare(sql).all(...params);

  const chatNorm = normalizarDestino(chatJid);
  const phoneNorm = phone ? limparTelefone(phone) : '';

  // Grupo: só responde se o JID for exatamente o grupo salvo na unidade.
  // ?filial_id= do webhook NÃO autoriza outros grupos (WuzAPI manda JID sem @g.us).
  if (chatDeGrupo) {
    for (const f of filiais) {
      if (!f.whatsapp_grupo) continue;
      if (!jidsGrupoIguais(f.whatsapp_grupo, chatJid)) continue;
      const replyTo = chatNorm?.phone
        || normalizarDestino(chatJid)?.phone
        || normalizarDestino(f.whatsapp_grupo)?.phone;
      return { filial: f, replyTo, escopoFilialId: f.id };
    }
    return null;
  }

  for (const f of filiais) {
    if (f.whatsapp && phoneNorm) {
      const n = limparTelefone(f.whatsapp);
      if (n && n === phoneNorm) {
        return { filial: f, replyTo: n, escopoFilialId: f.id };
      }
    }
  }

  // Hint ?filial_id= só no privado; em grupo o JID precisa bater com o grupo salvo
  if (filialIdHint && filiais[0]) {
    const f = filiais[0];
    const replyTo = chatNorm?.isGroup
      ? chatNorm.phone
      : (phoneNorm || limparTelefone(f.whatsapp) || chatNorm?.phone);
    if (replyTo) {
      return { filial: f, replyTo, escopoFilialId: f.id };
    }
  }

  return null;
}

/** Releitura no banco: mensagem de grupo só segue se for o grupo salvo da unidade. */
async function mensagemNoGrupoEscolhido(db, filialId, chatJid) {
  if (!filialId || !chatJid) return false;
  const f = await db.prepare(`
    SELECT whatsapp_grupo FROM filiais
    WHERE id = ? AND ativo = 1
  `).get(filialId);
  const salvo = String(f?.whatsapp_grupo || '').trim();
  if (!salvo) return false;
  return jidsGrupoIguais(salvo, chatJid);
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

    if (eventName && !/message/i.test(String(eventName)) && !temMensagem) {
      return res.status(200).json({ ok: true, ignored: true, tipo: eventName });
    }

    if (deveIgnorarMensagemPropria(event)) {
      return res.status(200).json({ ok: true, ignored: 'from_me' });
    }

    const chatJid = extrairJidGrupo(event) || extrairChatJid(event);
    const isGroup = ehMensagemDeGrupo(event)
      || Boolean(extrairJidGrupo(event))
      || Boolean(normalizarDestino(chatJid)?.isGroup);
    const phone = extrairTelefone(event);
    const body = extrairTextoMensagem(event);

    console.log('[webhook] msg', {
      event: eventName || '(sem nome)',
      chat: chatJid,
      isGroup,
      phone,
      body: body ? String(body).slice(0, 80) : null,
      filial_hint: Number(req.query.filial_id) || null,
      from_me: ehMensagemPropria(event),
    });

    if (!body) {
      console.warn('[webhook] sem_texto', {
        keys: Object.keys(req.body || {}),
        tem_jsonData: Boolean(req.body?.jsonData || req.body?.json),
        chat: chatJid,
      });
      return res.status(200).json({ ok: true, ignored: 'sem_texto' });
    }

    const db = getDb();
    const filialIdHint = Number(req.query.filial_id) || null;
    const canal = await resolverCanalFilial(db, chatJid, phone, filialIdHint, isGroup);
    const chatDeGrupo = isGroup || ehChatDeGrupo(chatJid, isGroup);

    if (chatDeGrupo) {
      if (!canal) {
        console.warn('[webhook] grupo sem filial cadastrada:', chatJid, 'hint=', filialIdHint);
        return res.status(200).json({
          ok: true,
          ignored: 'grupo_nao_cadastrado',
          chat: chatJid,
          dica: 'Salve o grupo no painel WhatsApp e clique em Conectar / QR para reaplicar o webhook.',
        });
      }
      const filialId = canal.escopoFilialId || filialIdHint;
      const noGrupoEscolhido = await mensagemNoGrupoEscolhido(db, filialId, chatJid);
      if (!noGrupoEscolhido) {
        console.info('[webhook] grupo ignorado (não é o selecionado)', {
          chat: chatJid,
          filial_id: filialId,
        });
        return res.status(200).json({
          ok: true,
          ignored: 'grupo_nao_selecionado',
          chat: chatJid,
        });
      }
    }

    const replyTo = canal?.replyTo || phone;
    if (!replyTo) {
      return res.status(200).json({ ok: true });
    }
    // Responde só no grupo salvo (nunca no JID de outro grupo)
    const destinoEnvio = chatDeGrupo
      ? (normalizarDestino(canal?.filial?.whatsapp_grupo)?.phone
        || canal?.replyTo
        || chatJid)
      : replyTo;

    // Rate limit por remetente (não pelo grupo — evita bloquear a frota inteira)
    const rateKey = phone || destinoEnvio;
    if (!rateLimitOk(rateKey)) {
      console.warn(`[webhook] Rate limit: ${rateKey}`);
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem: '⏳ Muitas consultas em pouco tempo. Aguarde 1 minuto e envie a placa novamente.',
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: phone,
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
    }).then((r) => {
      if (r?.handled) {
        console.log('[webhook] menu handled', {
          phone,
          filial: canal?.escopoFilialId || null,
          texto: texto.slice(0, 40),
        });
        return;
      }
      console.log('[webhook] ignorado (conversa)', { texto: texto.slice(0, 40) });
    }).catch((err) => {
      console.error('[webhook] menu falhou:', err.message);
      enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem: `❌ Erro: ${err.message}\n\nDigite *menu*.`,
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: phone,
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

