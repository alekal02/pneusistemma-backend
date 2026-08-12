/**
 * Webhook WuzAPI — placa → link de medição
 * Aceita chat privado ou grupo cadastrado na filial.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getDb } from '../database.js';
import { config } from '../config.js';
import { enviarERegistrar, limparTelefone, normalizarDestino } from '../services/whatsapp.js';
import {
  gerarTokenAcessoRapido,
  resumoStatusPneusVeiculoRapido,
} from '../services/acesso-rapido.js';

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
    // remove zero-width / invisíveis comuns do WhatsApp
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function listarFrotaMensagem(db, filialId = null) {
  let sql = `
    SELECT v.placa, v.apelido, v.tipo, f.nome AS filial_nome
    FROM veiculos v
    JOIN filiais f ON f.id = v.filial_id
    WHERE v.ativo = 1
  `;
  const params = [];
  if (filialId) {
    sql += ` AND v.filial_id = ?`;
    params.push(filialId);
  }
  sql += ` ORDER BY f.nome, v.placa`;
  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    return '📋 Nenhum veículo ativo cadastrado na frota.';
  }
  const linhas = rows.map((v) => {
    const apelido = v.apelido ? ` — ${v.apelido}` : '';
    return `• *${v.placa}*${apelido} (${v.tipo})`;
  });
  const titulo = filialId
    ? `📋 *Frota cadastrada* (${rows.length}):`
    : `📋 *Frota completa* (${rows.length}):`;
  return `${titulo}\n${linhas.join('\n')}\n\nEnvie a *placa* para abrir a medição.`;
}

function buscarVeiculosPorPlaca(db, placaLimpa, filialPreferida = null) {
  const baseSql = `
    SELECT v.*, f.nome as filial_nome,
      REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') AS placa_norm
    FROM veiculos v
    JOIN filiais f ON f.id = v.filial_id
    WHERE v.ativo = 1
      AND (
        REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') LIKE ?
        OR REPLACE(REPLACE(UPPER(IFNULL(v.apelido,'')), '-', ''), ' ', '') LIKE ?
      )
  `;

  const like = `%${placaLimpa}%`;

  // 1) Prioriza frota da unidade do grupo
  if (filialPreferida) {
    const locais = db.prepare(`${baseSql} AND v.filial_id = ? ORDER BY v.placa LIMIT 20`)
      .all(like, like, filialPreferida);
    if (locais.length) return { veiculos: locais, escopo: 'filial' };
  }

  // 2) Fallback: frota inteira (todas as filiais)
  const todos = db.prepare(`${baseSql} ORDER BY v.placa LIMIT 20`).all(like, like);
  return { veiculos: todos, escopo: filialPreferida ? 'todas' : 'todas' };
}

function escolherVeiculoExato(veiculos, placaLimpa) {
  if (!veiculos?.length) return [];
  const exatos = veiculos.filter((v) => {
    const p = String(v.placa_norm || v.placa || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return p === placaLimpa;
  });
  return exatos.length ? exatos : veiculos;
}

function validarHmacWebhook(req) {
  const secret = config.wuzapiWebhookSecret;
  if (!secret) return true;

  const signature = req.headers['x-hmac-signature'] || req.headers['x-hub-signature'];
  if (!signature) {
    console.warn('[webhook] HMAC configurado mas assinatura ausente');
    return false;
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

export function extrairChatJid(event) {
  const candidates = [
    event?.data?.Info?.Chat,
    event?.data?.chat,
    event?.data?.from,
    event?.from,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    if (s.includes('@g.us') || s.includes('@s.whatsapp.net') || /\d/.test(s)) {
      return s;
    }
  }
  return null;
}

export function extrairTelefone(event) {
  const candidates = [
    event?.data?.Info?.Sender,
    event?.data?.from,
    event?.data?.Info?.Chat,
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
  const msg = event?.data?.message
    || event?.data?.Message
    || event?.message
    || event?.Message
    || event?.data;

  if (typeof event?.body === 'string' && event.body.trim()) return event.body.trim();
  if (typeof event?.text === 'string' && event.text.trim()) return event.text.trim();
  if (typeof event?.Body === 'string' && event.Body.trim()) return event.Body.trim();

  if (!msg || typeof msg !== 'object') {
    return null;
  }

  // Alguns payloads WuzAPI trazem o texto em data.Message.conversation
  // ou em campos aninhados (extendedText / ephemeral)
  const nested = msg.message || msg.Message || msg;
  const text =
    nested.conversation
    || nested.Conversation
    || nested.extendedTextMessage?.text
    || nested.ExtendedTextMessage?.Text
    || nested.extendedTextMessage?.Text
    || nested.text
    || nested.Text
    || nested.caption
    || nested.Caption
    || msg.conversation
    || msg.text
    || null;

  return text ? String(text).trim() : null;
}

function ehMensagemDeGrupo(event) {
  const jid = extrairChatJid(event) || '';
  return String(jid).includes('@g.us');
}

/** Resolve canal da unidade a partir do chat (grupo ou número do chatbot) */
function resolverCanalFilial(db, chatJid, phone, filialIdHint = null) {
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
  const filiais = db.prepare(sql).all(...params);

  const chatNorm = normalizarDestino(chatJid);
  const phoneNorm = phone ? limparTelefone(phone) : '';

  for (const f of filiais) {
    if (f.whatsapp_grupo) {
      const g = normalizarDestino(f.whatsapp_grupo);
      if (g && chatNorm && g.logKey === chatNorm.logKey) {
        return { filial: f, replyTo: g.phone, escopoFilialId: f.id };
      }
    }
    if (f.whatsapp && phoneNorm) {
      const n = limparTelefone(f.whatsapp);
      // Remetente usa o chip do chatbot da filial, ou chat privado com o bot
      if (n && n === phoneNorm) {
        return { filial: f, replyTo: n, escopoFilialId: f.id };
      }
    }
  }

  // Webhook veio com ?filial_id= — escopo forçado mesmo sem match de grupo
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

router.post('/whatsapp', async (req, res) => {
  try {
    if (!validarHmacWebhook(req)) {
      return res.status(401).json({ erro: 'Assinatura HMAC inválida' });
    }

    const event = req.body || {};
    const eventName = event.event || event.type || event.Event || '';

    if (eventName && !/message/i.test(String(eventName)) && !event?.data?.message && !event?.message) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const chatJid = extrairChatJid(event);
    const isGroup = ehMensagemDeGrupo(event);
    const phone = extrairTelefone(event);
    const body = extrairTextoMensagem(event);

    console.log('[webhook] msg', {
      event: eventName || '(sem nome)',
      chat: chatJid,
      isGroup,
      phone,
      body: body ? String(body).slice(0, 80) : null,
      filial_hint: Number(req.query.filial_id) || null,
    });

    if (!body) {
      return res.status(200).json({ ok: true, ignored: 'sem_texto' });
    }

    const db = getDb();
    const filialIdHint = Number(req.query.filial_id) || null;
    const canal = resolverCanalFilial(db, chatJid, phone, filialIdHint);

    // Grupo não cadastrado em nenhuma filial → ignora
    if (isGroup && !canal) {
      console.warn('[webhook] grupo sem filial cadastrada:', chatJid);
      return res.status(200).json({ ok: true, ignored: 'grupo_nao_cadastrado' });
    }

    const replyTo = canal?.replyTo || phone;
    if (!replyTo) {
      return res.status(200).json({ ok: true });
    }

    // Rate limit por remetente (não pelo grupo — evita bloquear a frota inteira)
    const rateKey = phone || replyTo;
    if (!rateLimitOk(rateKey)) {
      console.warn(`[webhook] Rate limit: ${rateKey}`);
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: replyTo,
        mensagem: '⏳ Muitas consultas em pouco tempo. Aguarde 1 minuto e envie a placa novamente.',
        filialId: canal?.escopoFilialId || null,
      });
      return res.status(200).json({ ok: true, rate_limited: true });
    }

    const texto = String(body || '').trim();
    const cmd = texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

    // Comandos de frota / ajuda
    if (/^(frota|placas|lista|ajuda|help|menu|\?)$/i.test(cmd) || /^(frota|placas)\b/i.test(cmd)) {
      const mensagem = `${listarFrotaMensagem(db, null)}\n\n_Comandos: frota | placa do caminhão_`;
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: replyTo,
        mensagem,
        filialId: canal?.escopoFilialId || null,
      });
      return res.status(200).json({ ok: true, comando: 'frota' });
    }

    const placaLimpa = normalizarPlacaTexto(texto);
    if (!placaLimpa || placaLimpa.length < 3) {
      return res.status(200).json({ ok: true, ignored: 'texto_curto' });
    }

    const { veiculos: encontrados } = buscarVeiculosPorPlaca(
      db,
      placaLimpa,
      canal?.escopoFilialId || null
    );
    const veiculos = escolherVeiculoExato(encontrados, placaLimpa);

    if (veiculos.length === 0) {
      const lista = listarFrotaMensagem(db, null);
      const mensagem = `❌ Placa *${texto}* não encontrada.\n\n${lista}`;
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: replyTo,
        mensagem,
        filialId: canal?.escopoFilialId || null,
      });
      return res.status(200).json({ ok: true, encontrados: 0 });
    }

    if (veiculos.length > 1) {
      const lista = veiculos.map((v) => `• ${v.placa}${v.apelido ? ` — ${v.apelido}` : ''} (${v.tipo}) - ${v.filial_nome}`).join('\n');
      const mensagem = `🔍 Encontrei ${veiculos.length} veículos:\n${lista}\n\nEnvie a placa exata para abrir a medição.`;
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: replyTo,
        mensagem,
        filialId: canal?.escopoFilialId || null,
      });
      return res.status(200).json({ ok: true, encontrados: veiculos.length });
    }

    const veiculo = veiculos[0];
    const t0 = performance.now();
    console.log('[webhook] veiculo encontrado', { id: veiculo.id, placa: veiculo.placa, filial_id: veiculo.filial_id });

    const { link } = gerarTokenAcessoRapido({
      veiculoId: veiculo.id,
      filialId: veiculo.filial_id,
      whatsappOrigem: phone || replyTo,
    });
    const tToken = performance.now();

    const { criticos, alertas, ultimaMedicao } = resumoStatusPneusVeiculoRapido(veiculo.id);
    const tResumo = performance.now();

    let mensagem = `🚛 *${veiculo.placa}* — ${veiculo.tipo}\n`;
    if (veiculo.apelido) mensagem += `🏷️ ${veiculo.apelido}\n`;
    mensagem += `📍 Filial: ${veiculo.filial_nome}\n\n`;

    if (ultimaMedicao) {
      mensagem += `📊 Última medição: ${ultimaMedicao.data_medicao}\n`;
      mensagem += `Posição ${ultimaMedicao.posicao}${ultimaMedicao.numero_fogo ? ` — Fogo ${ultimaMedicao.numero_fogo}` : ''}\n`;
      mensagem += `Sulco: ${ultimaMedicao.menor_sulco ?? '-'}mm\n\n`;
    }

    if (criticos > 0) {
      mensagem += `🚨 *${criticos} pneu(s) em estado CRÍTICO*\n`;
    }
    if (alertas > 0) {
      mensagem += `⚠️ *${alertas} pneu(s) em ALERTA*\n`;
    }
    if (criticos === 0 && alertas === 0) {
      mensagem += `✅ Todos os pneus estão OK\n`;
    }

    mensagem += `\n👉 *Abrir medição de sulcos:*\n${link}\n\n`;
    mensagem += `Meça todas as posições e salve.\n`;
    mensagem += `_Link válido por 24 horas._`;

    // Responde o WuzAPI na hora e envia a mensagem em paralelo (não bloqueia o webhook)
    res.status(200).json({
      ok: true,
      veiculo_id: veiculo.id,
      placa: veiculo.placa,
      canal_filial_id: canal?.escopoFilialId || null,
      aceito: true,
    });

    const tAntesEnvio = performance.now();
    enviarERegistrar({
      tipo: 'link_veiculo',
      destinatario: replyTo,
      mensagem,
      veiculoId: veiculo.id,
      linkPreview: false,
      filialId: veiculo.filial_id,
    }).then((envio) => {
      console.log('[webhook] timing_ms', {
        placa: veiculo.placa,
        token: Math.round(tToken - t0),
        resumo: Math.round(tResumo - tToken),
        prep: Math.round(tAntesEnvio - t0),
        envio: Math.round(performance.now() - tAntesEnvio),
        total: Math.round(performance.now() - t0),
        enviado: Boolean(envio?.ok),
        erro: envio?.erro || null,
      });
    }).catch((err) => {
      console.error('[webhook] falha ao enviar link', err.message);
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
