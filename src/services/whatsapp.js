/**
 * Cliente WuzAPI — envio de mensagens WhatsApp
 * Spec: POST /chat/send/text com header `token` e body { Phone, Body, LinkPreview? }
 * Phone = número (DDI…) ou JID de grupo (…@g.us)
 * Token = por filial (wuzapi_token) ou fallback .env
 */
import { config } from '../config.js';
import { getDb } from '../database.js';

export function limparTelefone(phone) {
  if (!phone) return '';
  return String(phone).replace(/@.*$/, '').replace(/\D/g, '');
}

/** Normaliza destino: número pessoal ou grupo WhatsApp */
export function normalizarDestino(destino) {
  const raw = String(destino || '').trim();
  if (!raw) return null;

  if (/@g\.us$/i.test(raw) || raw.toLowerCase().includes('@g.us')) {
    const id = raw.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
    if (!id) return null;
    return {
      phone: `${id}@g.us`,
      isGroup: true,
      logKey: `${id}@g.us`,
    };
  }

  const onlyId = raw.replace(/[^\d-]/g, '');
  if (/^\d{15,}-?\d*$/.test(onlyId) || (onlyId.includes('-') && onlyId.length >= 15)) {
    return {
      phone: `${onlyId}@g.us`,
      isGroup: true,
      logKey: `${onlyId}@g.us`,
    };
  }

  const phone = limparTelefone(raw);
  if (!phone || phone.length < 10) return null;
  return { phone, isGroup: false, logKey: phone };
}

/** Placeholder do .env.example não conta como token real */
export function tokenWuzapiUtil(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  if (/^TOKEN[_A-Z0-9]*$/i.test(t)) return '';
  if (/^(change-me|seu_token|coloque)/i.test(t)) return '';
  return t;
}

export function wuzapiConfigurado(token = null) {
  const t = tokenWuzapiUtil(token || config.wuzapiToken);
  return Boolean(config.wuzapiBaseUrl && t);
}

/** Token WuzAPI da filial, com fallback no .env */
export async function tokenWuzapiFilial(filialId) {
  if (filialId) {
    const db = getDb();
    const row = await db.prepare(`
      SELECT wuzapi_token FROM filiais WHERE id = ? AND ativo = 1
    `).get(filialId);
    const local = tokenWuzapiUtil(row?.wuzapi_token);
    if (local) return local;
  }
  return tokenWuzapiUtil(config.wuzapiToken);
}

/**
 * Envia texto via WuzAPI POST /chat/send/text
 * @param {string} phoneOrGroup
 * @param {string} text
 * @param {{ linkPreview?: boolean, token?: string, filialId?: number }} [opts]
 */
export async function enviarMensagemWhatsApp(phoneOrGroup, text, opts = {}) {
  const dest = normalizarDestino(phoneOrGroup);
  if (!dest?.phone) throw new Error('Destino WhatsApp inválido');
  if (!text?.trim()) throw new Error('Mensagem vazia');

  const tokens = [];
  const primary = tokenWuzapiUtil(opts.token) || (await tokenWuzapiFilial(opts.filialId));
  if (primary) tokens.push(primary);
  const fallback = tokenWuzapiUtil(config.wuzapiToken);
  if (fallback && !tokens.includes(fallback)) tokens.push(fallback);

  if (!tokens.length || !config.wuzapiBaseUrl) {
    console.warn('[whatsapp] WuzAPI não configurado — mensagem não enviada:', dest.logKey);
    return {
      skipped: true,
      reason: 'wuzapi_nao_configurado',
      Phone: dest.phone,
      Body: text,
    };
  }

  const payload = {
    Phone: dest.phone,
    Body: text,
  };
  if (opts.linkPreview) payload.LinkPreview = true;

  let lastErr = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const tSend = performance.now();
    const res = await fetch(`${config.wuzapiBaseUrl}/chat/send/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    if (res.ok) {
      if (performance.now() - tSend > 1500) {
        console.warn('[whatsapp] envio lento', Math.round(performance.now() - tSend), 'ms');
      }
      return data;
    }

    const msg = data?.error || data?.erro || JSON.stringify(data);
    lastErr = new Error(`WuzAPI erro ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    // Se o token da filial não tem sessão, tenta o token global (.env)
    if (/no session/i.test(String(msg)) && i < tokens.length - 1) {
      console.warn('[whatsapp] Token sem sessão — tentando fallback .env');
      continue;
    }
    throw lastErr;
  }

  throw lastErr || new Error('Falha ao enviar WhatsApp');
}

export async function enviarMensagemWhatsAppComLink(phone, text, opts = {}) {
  return enviarMensagemWhatsApp(phone, text, { ...opts, linkPreview: true });
}

export async function registrarNotificacao({
  tipo,
  destinatario,
  mensagem,
  veiculoId = null,
  medicaoId = null,
  status = 'enviado',
  respostaApi = null,
  filialId = null,
}) {
  const db = getDb();
  const dest = normalizarDestino(destinatario);
  let filial = filialId || null;
  if (!filial && veiculoId) {
    const v = await db.prepare('SELECT filial_id FROM veiculos WHERE id = ?').get(veiculoId);
    filial = v?.filial_id || null;
  }
  return db.prepare(`
    INSERT INTO notificacoes_whatsapp (
      tipo, destinatario_whatsapp, veiculo_id, medicao_id,
      mensagem, status, resposta_api, filial_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tipo,
    dest?.logKey || String(destinatario || ''),
    veiculoId,
    medicaoId,
    mensagem,
    status,
    respostaApi != null ? JSON.stringify(respostaApi) : null,
    filial
  );
}

/**
 * Envia e registra; em falha grava status=erro
 * @param {{ filialId?: number, token?: string }} extra
 */
export async function enviarERegistrar({
  tipo,
  destinatario,
  mensagem,
  veiculoId = null,
  medicaoId = null,
  linkPreview = false,
  filialId = null,
  token = null,
}) {
  const dest = normalizarDestino(destinatario);
  if (!dest?.phone) {
    await registrarNotificacao({
      tipo,
      destinatario: destinatario || '',
      mensagem,
      veiculoId,
      medicaoId,
      status: 'erro',
      respostaApi: { erro: 'WhatsApp não cadastrado' },
      filialId,
    });
    return { ok: false, erro: 'sem_whatsapp' };
  }

  try {
    const resp = await enviarMensagemWhatsApp(dest.phone, mensagem, {
      linkPreview,
      filialId,
      token,
    });
    const status = resp?.skipped ? 'erro' : 'enviado';
    await registrarNotificacao({
      tipo,
      destinatario: dest.logKey,
      mensagem,
      veiculoId,
      medicaoId,
      status,
      respostaApi: resp,
      filialId,
    });
    return { ok: status === 'enviado', resp };
  } catch (err) {
    console.error(`[whatsapp] Falha ao enviar para ${dest.logKey}:`, err.message);
    await registrarNotificacao({
      tipo,
      destinatario: dest.logKey,
      mensagem,
      veiculoId,
      medicaoId,
      status: 'erro',
      respostaApi: { erro: err.message },
      filialId,
    });
    return { ok: false, erro: err.message };
  }
}
