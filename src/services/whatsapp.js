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

  // Já é JID de grupo — preserva o user exatamente (só limpa sufixo/espaço)
  if (/@g\.us$/i.test(raw)) {
    const user = raw.replace(/@g\.us$/i, '').trim();
    if (!user) return null;
    return {
      phone: `${user}@g.us`,
      isGroup: true,
      logKey: `${user}@g.us`,
    };
  }

  if (raw.toLowerCase().includes('@g.us')) {
    const id = raw.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
    if (!id) return null;
    return {
      phone: `${id}@g.us`,
      isGroup: true,
      logKey: `${id}@g.us`,
    };
  }

  const onlyId = raw.replace(/[^\d-]/g, '');
  // Grupo clássico WhatsApp: 120363… — não confundir com LID/telefone
  if (/^120363\d{8,}$/.test(onlyId) || (onlyId.includes('-') && onlyId.length >= 15)) {
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

/** Id canônico de grupo (parte antes de @g.us), para comparar JIDs. */
export function idGrupoCanonico(destino) {
  const raw = String(destino || '').trim();
  if (!raw) return '';
  const gUs = raw.match(/^([^@\s]+)@g\.us$/i);
  if (gUs) return gUs[1].replace(/:[0-9]+$/, '');
  if (raw.toLowerCase().includes('@g.us')) {
    return raw.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  }
  // Só trata como grupo o padrão WhatsApp 120363… (não LID/telefone)
  const onlyId = raw.replace(/[^\d-]/g, '');
  if (/^120363\d{8,}$/.test(onlyId)) return onlyId;
  return '';
}

function erroEnvioGrupo(errMsg) {
  const m = String(errMsg || '');
  return /group members|bad-request|not in group|no group|group info|iq.*400/i.test(m);
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

function tokenNaoEAdmin(token) {
  const t = tokenWuzapiUtil(token);
  if (!t) return '';
  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (admin && t === admin) return '';
  return t;
}

async function fetchAdminUsers() {
  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin || !config.wuzapiBaseUrl) return [];
  try {
    const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
      headers: { Authorization: admin },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

async function gravarTokenFilial(filialId, token) {
  const t = tokenNaoEAdmin(token);
  if (!filialId || !t) return;
  try {
    const db = getDb();
    await db.prepare(`
      UPDATE filiais SET wuzapi_token = ?, updated_at = NOW() WHERE id = ? AND ativo = 1
    `).run(t, filialId);
  } catch (err) {
    console.warn('[whatsapp] não gravou token ativo:', err.message);
  }
}

/** Tokens para envio: filial → sessão logada no WuzAPI → .env */
async function listarTokensEnvio(filialId, explicitToken) {
  const tokens = [];
  const add = (t) => {
    const u = tokenNaoEAdmin(t);
    if (u && !tokens.includes(u)) tokens.push(u);
  };
  add(explicitToken);
  add(await tokenWuzapiFilial(filialId));

  const users = await fetchAdminUsers();
  for (const u of users) {
    if (u.loggedIn || u.LoggedIn) add(u.token);
  }
  add(config.wuzapiToken);
  return tokens;
}

function ehFalhaAuthWuzapi(status, msg) {
  return status === 401 || status === 403
    || /unauthor|invalid token|no session|not logged|não autentic/i.test(String(msg || ''));
}

function headersUsuarioWuzapi(token) {
  // WuzAPI: endpoints de usuário usam o header `token`. Authorization é só admin.
  return {
    'Content-Type': 'application/json',
    token,
  };
}

function mensagemErroWuzapi(status, msg) {
  const texto = typeof msg === 'string' ? msg : JSON.stringify(msg);
  if (ehFalhaAuthWuzapi(status, texto)) {
    return 'Sessão WhatsApp recusada (401). O token é gerado de novo automaticamente — clique em Conectar / QR.';
  }
  return `WuzAPI erro ${status}: ${texto}`;
}

/** Token WuzAPI da filial, com fallback no .env */
export async function tokenWuzapiFilial(filialId) {
  if (filialId) {
    const db = getDb();
    const row = await db.prepare(`
      SELECT wuzapi_token FROM filiais WHERE id = ? AND ativo = 1
    `).get(filialId);
    const local = tokenNaoEAdmin(row?.wuzapi_token);
    if (local) return local;
  }
  return tokenNaoEAdmin(config.wuzapiToken);
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

  const tokens = await listarTokensEnvio(opts.filialId, opts.token);
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
      headers: headersUsuarioWuzapi(token),
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
      if (i > 0) await gravarTokenFilial(opts.filialId, token);
      if (performance.now() - tSend > 1500) {
        console.warn('[whatsapp] envio lento', Math.round(performance.now() - tSend), 'ms');
      }
      return data;
    }

    const msg = data?.error || data?.erro || JSON.stringify(data);
    lastErr = new Error(mensagemErroWuzapi(res.status, msg));
    if (ehFalhaAuthWuzapi(res.status, msg) && i < tokens.length - 1) {
      console.warn('[whatsapp] Token recusado — tentando outra sessão WuzAPI');
      continue;
    }
    if (i < tokens.length - 1) continue;
    throw lastErr;
  }

  throw lastErr || new Error('Falha ao enviar WhatsApp');
}

export async function enviarMensagemWhatsAppComLink(phone, text, opts = {}) {
  return enviarMensagemWhatsApp(phone, text, { ...opts, linkPreview: true });
}

/**
 * Envia documento (PDF etc.) via WuzAPI POST /chat/send/document
 * @param {string} phoneOrGroup
 * @param {Buffer|Uint8Array} buffer
 * @param {string} fileName
 * @param {{ token?: string, filialId?: number, mime?: string, caption?: string }} [opts]
 */
export async function enviarDocumentoWhatsApp(phoneOrGroup, buffer, fileName, opts = {}) {
  const dest = normalizarDestino(phoneOrGroup);
  if (!dest?.phone) throw new Error('Destino WhatsApp inválido');
  if (!buffer?.length) throw new Error('Documento vazio');
  const nome = String(fileName || 'documento.pdf').replace(/[^\w.\-]+/g, '_');
  const mime = opts.mime || 'application/pdf';

  const tokens = await listarTokensEnvio(opts.filialId, opts.token);
  if (!tokens.length || !config.wuzapiBaseUrl) {
    console.warn('[whatsapp] WuzAPI não configurado — documento não enviado:', dest.logKey);
    return {
      skipped: true,
      reason: 'wuzapi_nao_configurado',
      Phone: dest.phone,
      FileName: nome,
    };
  }

  const b64 = Buffer.from(buffer).toString('base64');
  const payload = {
    Phone: dest.phone,
    FileName: nome,
    Document: `data:${mime};base64,${b64}`,
  };
  if (opts.caption) payload.Caption = String(opts.caption);

  let lastErr = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const res = await fetch(`${config.wuzapiBaseUrl}/chat/send/document`, {
      method: 'POST',
      headers: headersUsuarioWuzapi(token),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    if (res.ok) {
      if (i > 0) await gravarTokenFilial(opts.filialId, token);
      return data;
    }

    const msg = data?.error || data?.erro || JSON.stringify(data);
    lastErr = new Error(mensagemErroWuzapi(res.status, msg));
    if (ehFalhaAuthWuzapi(res.status, msg) && i < tokens.length - 1) {
      console.warn('[whatsapp] Token recusado (documento) — tentando outra sessão');
      continue;
    }
    if (i < tokens.length - 1) continue;
    throw lastErr;
  }

  throw lastErr || new Error('Falha ao enviar documento WhatsApp');
}

/**
 * Envia PDF e registra em notificacoes_whatsapp (com fallback privado se o grupo falhar)
 */
export async function enviarDocumentoERegistrar({
  tipo,
  destinatario,
  buffer,
  fileName,
  mensagem = '',
  veiculoId = null,
  filialId = null,
  token = null,
  fallbackDestinatario = null,
  caption = '',
}) {
  const dest = normalizarDestino(destinatario);
  const preview = mensagem || `📎 ${fileName || 'documento.pdf'}`;

  if (!dest?.phone) {
    await registrarNotificacao({
      tipo,
      destinatario: destinatario || '',
      mensagem: preview,
      veiculoId,
      status: 'erro',
      respostaApi: { erro: 'WhatsApp não cadastrado' },
      filialId,
    });
    return { ok: false, erro: 'sem_whatsapp' };
  }

  const tentar = async (alvo) => {
    const d = normalizarDestino(alvo);
    if (!d?.phone) return { ok: false, erro: 'destino_invalido', dest: d };
    try {
      const resp = await enviarDocumentoWhatsApp(d.phone, buffer, fileName, {
        filialId,
        token,
        caption: caption || preview,
      });
      const status = resp?.skipped ? 'erro' : 'enviado';
      try {
        await registrarNotificacao({
          tipo,
          destinatario: d.logKey,
          mensagem: preview,
          veiculoId,
          status,
          respostaApi: resp,
          filialId,
        });
      } catch (regErr) {
        console.warn('[whatsapp] não registrou documento:', regErr.message);
      }
      return { ok: status === 'enviado', resp, dest: d, erro: resp?.skipped ? (resp.reason || 'skipped') : null };
    } catch (err) {
      console.error(`[whatsapp] Falha documento para ${d.logKey}:`, err.message);
      try {
        await registrarNotificacao({
          tipo,
          destinatario: d.logKey,
          mensagem: preview,
          veiculoId,
          status: 'erro',
          respostaApi: { erro: err.message },
          filialId,
        });
      } catch (regErr) {
        console.warn('[whatsapp] não registrou falha de documento:', regErr.message);
      }
      return { ok: false, erro: err.message, dest: d };
    }
  };

  let result = await tentar(dest.phone);

  if (!result.ok && dest.isGroup && fallbackDestinatario && erroEnvioGrupo(result.erro)) {
    const fb = normalizarDestino(fallbackDestinatario);
    if (fb?.phone && !fb.isGroup && fb.logKey !== dest.logKey) {
      console.warn('[whatsapp] Documento no grupo falhou — tentando privado:', fb.logKey);
      result = await tentar(fb.phone);
      if (result.ok) {
        return { ...result, via: 'privado_fallback', grupo_erro: true };
      }
    }
  }

  return result;
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
  /** Se o envio ao grupo falhar, tenta este número (remetente) */
  fallbackDestinatario = null,
  registrar = true,
}) {
  const dest = normalizarDestino(destinatario);
  if (!dest?.phone) {
    if (registrar) {
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
    }
    return { ok: false, erro: 'sem_whatsapp' };
  }

  const tentarEnviar = async (alvo) => {
    const d = normalizarDestino(alvo);
    if (!d?.phone) return { ok: false, erro: 'destino_invalido', dest: d };
    try {
      const resp = await enviarMensagemWhatsApp(d.phone, mensagem, {
        linkPreview,
        filialId,
        token,
      });
      const status = resp?.skipped ? 'erro' : 'enviado';
      if (registrar) {
        await registrarNotificacao({
          tipo,
          destinatario: d.logKey,
          mensagem,
          veiculoId,
          medicaoId,
          status,
          respostaApi: resp,
          filialId,
        });
      }
      return { ok: status === 'enviado', resp, dest: d, erro: resp?.skipped ? (resp.reason || 'skipped') : null };
    } catch (err) {
      console.error(`[whatsapp] Falha ao enviar para ${d.logKey}:`, err.message);
      if (registrar) {
        await registrarNotificacao({
          tipo,
          destinatario: d.logKey,
          mensagem,
          veiculoId,
          medicaoId,
          status: 'erro',
          respostaApi: { erro: err.message },
          filialId,
        });
      }
      return { ok: false, erro: err.message, dest: d };
    }
  };

  let result = await tentarEnviar(dest.phone);

  // Grupo rejeitado pelo WhatsApp → envia o link no privado do remetente
  if (!result.ok && dest.isGroup && fallbackDestinatario && erroEnvioGrupo(result.erro)) {
    const fb = normalizarDestino(fallbackDestinatario);
    if (fb?.phone && !fb.isGroup && fb.logKey !== dest.logKey) {
      console.warn('[whatsapp] Grupo falhou — tentando privado:', fb.logKey, result.erro);
      const msgPrivado = `${mensagem}\n\n_Obs: não consegui responder no grupo; enviei no privado._`;
      result = await tentarEnviar(fb.phone);
      if (result.ok) {
        return { ...result, via: 'privado_fallback', grupo_erro: true };
      }
    }
  }

  if (!result.ok && erroEnvioGrupo(result.erro)) {
    result.erro = 'Não foi possível enviar no grupo (chip precisa estar no grupo e o grupo precisa estar atualizado na lista). Tente: Atualizar lista → selecionar o grupo de novo → Conectar / QR.';
  }

  return result;
}
