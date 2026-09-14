/**
 * Cliente WuzAPI — envio de mensagens WhatsApp
 * Spec: POST /chat/send/text com header `token` e body { Phone, Body, LinkPreview? }
 * Phone = número (DDI…) ou JID de grupo (…@g.us)
 * Token = exclusivamente o wuzapi_token da filial (cada unidade tem sua sessão).
 * O WUZAPI_TOKEN do .env só serve para admin / legado de envio sem filial.
 */
import crypto from 'crypto';
import { config } from '../config.js';
import { getDb } from '../database.js';

export function limparTelefone(phone) {
  if (!phone) return '';
  return String(phone)
    .replace(/@.*$/, '')
    .split(':')[0]
    .replace(/\D/g, '');
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
  // Grupo clássico: 120363... (18+ dígitos) ou formato antigo com hífen
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

export function wuzapiConfigurado(token = undefined) {
  // Sem argumento: checa .env. Com argumento (mesmo ''): só esse token.
  const t = token === undefined
    ? tokenWuzapiUtil(config.wuzapiToken)
    : tokenWuzapiUtil(token);
  return Boolean(config.wuzapiBaseUrl && t);
}

function tokenNaoEAdmin(token) {
  const t = tokenWuzapiUtil(token);
  if (!t) return '';
  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (admin && t === admin) return '';
  return t;
}

/**
 * Tokens para envio desta filial — nunca usa sessão de outra unidade.
 * Ordem: token explícito → token gravado na filial → .env só se a filial não tiver token.
 */
async function listarTokensEnvio(filialId, explicitToken) {
  const tokens = [];
  const add = (t) => {
    const u = tokenNaoEAdmin(t);
    if (u && !tokens.includes(u)) tokens.push(u);
  };
  add(explicitToken);
  const proprio = await tokenWuzapiFilial(filialId, { permitirEnv: false });
  add(proprio);
  // Legado: só cai no .env se esta filial ainda não tem token próprio
  if (!proprio) add(config.wuzapiToken);
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
    return 'Não foi possível enviar agora. O chip continua nesta unidade — tente de novo em instantes.';
  }
  return `WuzAPI erro ${status}: ${texto}`;
}

async function conectarSessaoEnvio(token) {
  const t = tokenNaoEAdmin(token);
  if (!t || !config.wuzapiBaseUrl) return;
  try {
    await fetch(`${config.wuzapiBaseUrl}/session/connect`, {
      method: 'POST',
      headers: headersUsuarioWuzapi(t),
      body: JSON.stringify({ Subscribe: ['Message'], Immediate: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // sessão pode já estar no ar
  }
}

async function tokenVivoEnvio(filialId) {
  if (!filialId) return '';
  const db = getDb();
  const f = await db.prepare(`
    SELECT id, nome, codigo, whatsapp, wuzapi_token FROM filiais WHERE id = ? AND ativo = 1
  `).get(filialId);
  if (!f) return '';
  const viva = await reconectarSessaoVivaFilial(f, { forcarUsers: true });
  return tokenNaoEAdmin(viva?.token);
}

async function postWuzapiJson(path, token, payload, timeoutMs) {
  const res = await fetch(`${config.wuzapiBaseUrl}${path}`, {
    method: 'POST',
    headers: headersUsuarioWuzapi(token),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  return { res, data };
}

/**
 * Envia na sessão desta filial. Se o token do cadastro der 401, reconecta
 * a sessão viva (mesmo chip) e tenta de novo — não gera QR nem usuário novo.
 */
async function enviarNaSessaoFilial({ path, payload, timeoutMs, filialId, token, extraTokens = [] }) {
  const tokens = await listarTokensEnvio(filialId, token);
  for (const extra of extraTokens) {
    const u = tokenNaoEAdmin(extra);
    if (u && !tokens.includes(u)) tokens.push(u);
  }
  if (!tokens.length || !config.wuzapiBaseUrl) return { skipped: true };

  let lastErr = null;
  const tried = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok || tried.has(tok)) continue;
    tried.add(tok);

    let { res, data } = await postWuzapiJson(path, tok, payload, timeoutMs);
    if (res.ok) return data;

    const msg = data?.error || data?.erro || JSON.stringify(data);
    lastErr = new Error(mensagemErroWuzapi(res.status, msg));
    lastErr.status = res.status;

    if (!ehFalhaAuthWuzapi(res.status, msg)) {
      if (i < tokens.length - 1) continue;
      throw lastErr;
    }

    await conectarSessaoEnvio(tok);
    ({ res, data } = await postWuzapiJson(path, tok, payload, timeoutMs));
    if (res.ok) return data;

    let vivo = '';
    try {
      vivo = await tokenVivoEnvio(filialId);
    } catch (err) {
      console.warn('[whatsapp] sessão viva indisponível no reenvio:', err.message);
    }
    if (vivo && !tried.has(vivo)) {
      console.warn('[whatsapp] 401 no envio — usando a sessão já pareada da filial', filialId);
      tokens.push(vivo);
    }
  }

  throw lastErr || new Error('Falha ao enviar WhatsApp');
}

/**
 * Token WuzAPI da filial.
 * @param {number|string|null} filialId
 * @param {{ permitirEnv?: boolean }} [opts] — permitirEnv=false: só o token da filial
 *   (status/QR/conectar). Default true só para compatibilidade de envio legado.
 */
export async function tokenWuzapiFilial(filialId, opts = {}) {
  const permitirEnv = opts.permitirEnv !== false;
  if (filialId) {
    const db = getDb();
    const row = await db.prepare(`
      SELECT wuzapi_token FROM filiais WHERE id = ? AND ativo = 1
    `).get(filialId);
    const local = tokenNaoEAdmin(row?.wuzapi_token);
    if (local) return local;
  }
  if (!permitirEnv) return '';
  return tokenNaoEAdmin(config.wuzapiToken);
}

function nomeUsuarioWuzapiFilial(filial) {
  const base = (filial?.codigo || filial?.nome || 'un')
    .toString()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 16);
  // Sempre inclui o id — nomes iguais faziam duas unidades herdarem o mesmo chip.
  return `Pneu${filial.id}-${base || 'un'}`;
}

function nomesAntigosUsuarioWuzapi(filial) {
  const codigo = (filial?.codigo || filial?.nome || '')
    .toString()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24);
  return [
    `Pneu-${codigo}`,
    `PneuSistemma-${filial.id}`,
    `Pneu-${filial.id}`,
  ].filter(Boolean);
}

function nomesUsuarioWuzapiFilial(filial) {
  return new Set(
    [nomeUsuarioWuzapiFilial(filial), ...nomesAntigosUsuarioWuzapi(filial)]
      .map((n) => String(n || '').trim())
      .filter(Boolean)
  );
}

function sessaoWuzapiAtiva(u) {
  const logged = Boolean(u?.loggedIn ?? u?.LoggedIn);
  const connected = Boolean(u?.connected ?? u?.Connected);
  const phone = limparTelefone(u?.jid || u?.JID || u?.phone || u?.Phone);
  return logged || (connected && phone.length >= 10);
}

/**
 * Encontra o usuário WuzAPI desta unidade sem criar outro.
 * Prioridade: nome da filial → token salvo → chip já cadastrado.
 * Usado para NÃO derrubar sessões que já estão no ar.
 */
export function encontrarUsuarioWuzapiDaFilial(filial, users) {
  if (!filial?.id) return null;
  const nomesOk = nomesUsuarioWuzapiFilial(filial);
  const prefixoId = `Pneu${filial.id}-`;
  const chipFilial = limparTelefone(filial.whatsapp);
  const tokenFilial = tokenNaoEAdmin(filial.wuzapi_token);
  const candidatos = (users || []).filter((u) => {
    const name = String(u.name || u.Name || '').trim();
    const phone = limparTelefone(u.jid || u.JID || u.phone || u.Phone);
    const tokenUser = tokenNaoEAdmin(u.token || u.Token);
    const ativa = sessaoWuzapiAtiva(u);
    const porNome = nomesOk.has(name) || name.startsWith(prefixoId);
    const porToken = Boolean(tokenFilial && tokenUser && tokenFilial === tokenUser);
    const porChip = Boolean(chipFilial && phone && chipsWhatsappIguais(phone, chipFilial));
    if (porNome) return true;
    if (porToken) return true;
    if (porChip && (ativa || Boolean(u.loggedIn ?? u.LoggedIn) || Boolean(u.connected ?? u.Connected))) return true;
    return false;
  });
  if (!candidatos.length) return null;
  const porNome = candidatos.filter((u) => {
    const name = String(u.name || u.Name || '').trim();
    return nomesOk.has(name) || name.startsWith(prefixoId);
  });
  const logged = (lista) => lista.find((x) => x.loggedIn === true || x.LoggedIn === true);
  return logged(porNome) || logged(candidatos) || porNome[0] || candidatos[0];
}

/** Sessão WhatsApp já logada desta unidade no WuzAPI (não cria usuário novo). */
export async function sessaoVivaDaFilial(filial, { forcarUsers = false } = {}) {
  if (!filial?.id) return null;
  const users = await adminUsersWuzapi({ forcar: forcarUsers });
  const u = encontrarUsuarioWuzapiDaFilial(filial, users);
  const token = tokenNaoEAdmin(u?.token || u?.Token);
  if (!token) return null;
  const phone = limparTelefone(u.jid || u.JID || u.phone);
  const logged = sessaoWuzapiAtiva(u) || phone.length >= 10;
  if (!logged) return null;
  return {
    token,
    name: u.name || u.Name || null,
    jid: u.jid || u.JID || null,
    phone,
    loggedIn: true,
  };
}

export async function reconectarSessaoVivaFilial(filial, { forcarUsers = false } = {}) {
  const viva = await sessaoVivaDaFilial(filial, { forcarUsers });
  if (!viva?.token) return null;
  await gravarTokenFilialSeDiferente(filial.id, viva.token);
  return viva;
}

async function gravarTokenFilialSeDiferente(filialId, token) {
  const t = tokenNaoEAdmin(token);
  if (!filialId || !t) return;
  const db = getDb();
  const row = await db.prepare('SELECT wuzapi_token FROM filiais WHERE id = ?').get(filialId);
  if (tokenNaoEAdmin(row?.wuzapi_token) === t) return;
  await db.prepare(`
    UPDATE filiais SET wuzapi_token = ?, updated_at = NOW() WHERE id = ?
  `).run(t, filialId);
}

export function chipsWhatsappIguais(a, b) {
  const da = limparTelefone(a);
  const db = limparTelefone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.length >= 8 && db.length >= 8 && da.slice(-8) === db.slice(-8);
}

export async function tokenUsadoPorOutraFilial(filialId, token) {
  const t = tokenWuzapiUtil(token);
  if (!t || !filialId) return false;
  const db = getDb();
  const row = await db.prepare(`
    SELECT id FROM filiais
    WHERE id != ? AND ativo = 1
      AND wuzapi_token IS NOT NULL AND TRIM(wuzapi_token) != ''
      AND wuzapi_token = ?
    LIMIT 1
  `).get(filialId, t);
  return Boolean(row);
}

/** Outra unidade já cadastrou este número como chip dela. */
export async function chipUsadoPorOutraFilial(filialId, phone) {
  const digits = limparTelefone(phone);
  if (!digits || digits.length < 10 || !filialId) return null;
  const db = getDb();
  const rows = await db.prepare(`
    SELECT id, nome, whatsapp FROM filiais
    WHERE id != ? AND ativo = 1
      AND whatsapp IS NOT NULL AND TRIM(whatsapp) != ''
  `).all(filialId);
  return (rows || []).find((r) => chipsWhatsappIguais(r.whatsapp, digits)) || null;
}

let cacheAdminUsersSvc = { at: 0, users: null };
const ADMIN_USERS_SVC_TTL_MS = 10_000;
const reparoWuzapiRecente = new Map();

async function adminUsersWuzapi({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && cacheAdminUsersSvc.users && (agora - cacheAdminUsersSvc.at) < ADMIN_USERS_SVC_TTL_MS) {
    return cacheAdminUsersSvc.users;
  }
  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin || !config.wuzapiBaseUrl) return [];
  try {
    const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
      headers: { Authorization: admin },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const users = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    cacheAdminUsersSvc = { at: agora, users };
    return users;
  } catch {
    return cacheAdminUsersSvc.users || [];
  }
}

function ehErroDbInternoWuzapi(raw) {
  return /database error|problem accessing DB|lookup db|127\.0\.0\.11|server misbehaving|pq:/i
    .test(String(raw || ''));
}

/**
 * Garante token WuzAPI exclusivo da filial (cria ao cadastrar / corrige token compartilhado ou órfão).
 * Sessão nasce desconectada — gerente gera QR com o chip da unidade.
 *
 * @param {{ id: number, codigo?: string, nome?: string, wuzapi_token?: string }} filial
 * @param {{ forcarNovo?: boolean }} [opts]
 */
export async function garantirTokenExclusivoFilial(filial, opts = {}) {
  if (!filial?.id) throw new Error('Filial inválida para token WhatsApp');
  const db = getDb();
  const atual = await db.prepare(`
    SELECT id, nome, codigo, wuzapi_token, whatsapp, whatsapp_grupo
    FROM filiais WHERE id = ?
  `).get(filial.id);
  if (!atual) throw new Error('Filial não encontrada');

  const nomeUser = nomeUsuarioWuzapiFilial(atual);
  const tokenAtual = tokenNaoEAdmin(atual.wuzapi_token);
  // Só é "compartilhado" se OUTRA filial usa o mesmo token.
  // Igualdade com WUZAPI_TOKEN do .env é comum (primeira unidade) e NÃO
  // deve regenerar o token — isso derrubava a sessão WhatsApp a cada status.
  const compartilhado = tokenAtual
    ? await tokenUsadoPorOutraFilial(atual.id, tokenAtual)
    : false;

  const usersWuz = await adminUsersWuzapi({ forcar: true });

  const nomesOk = nomesUsuarioWuzapiFilial(atual);
  const prefixoId = `Pneu${atual.id}-`;
  const dedicado = (usersWuz || []).find((u) => {
    const name = String(u.name || u.Name || '').trim();
    const tok = tokenNaoEAdmin(u.token || u.Token);
    return nomesOk.has(name) || name.startsWith(prefixoId) || Boolean(tokenAtual && tok === tokenAtual);
  });

  if (opts.forcarNovo) {
    const agora = Date.now();
    const ultimo = reparoWuzapiRecente.get(atual.id) || 0;
    if (agora - ultimo > 45_000) {
      reparoWuzapiRecente.set(atual.id, agora);
      const adminTok = tokenWuzapiUtil(config.wuzapiAdminToken);
      const mortos = (usersWuz || []).filter((u) => {
        const name = String(u.name || u.Name || '').trim();
        const tok = tokenNaoEAdmin(u.token || u.Token);
        const match = nomesOk.has(name) || name.startsWith(prefixoId)
          || Boolean(tokenAtual && tok === tokenAtual);
        if (!match) return false;
        return !sessaoWuzapiAtiva(u);
      });
      for (const u of mortos) {
        const id = u.id ?? u.Id ?? u.ID;
        if (id == null || !adminTok) continue;
        try {
          await fetch(`${config.wuzapiBaseUrl}/admin/users/${id}`, {
            method: 'DELETE',
            headers: { Authorization: adminTok },
            signal: AbortSignal.timeout(12_000),
          });
        } catch (err) {
          console.warn('[whatsapp] apagar user WuzAPI:', err.message);
        }
      }
      cacheAdminUsersSvc = { at: 0, users: null };
      if (mortos.length) await new Promise((r) => setTimeout(r, 800));
    }
  } else if (dedicado) {
    const tok = tokenNaoEAdmin(dedicado.token || dedicado.Token);
    if (tok) {
      await gravarTokenFilialSeDiferente(atual.id, tok);
      return {
        token: tok,
        criado: false,
        regenerado: false,
        compartilhado: false,
        nome_wuzapi: dedicado.name || dedicado.Name || nomeUser,
        precisa_conectar: !sessaoWuzapiAtiva(dedicado),
      };
    }
  }

  if (tokenAtual && !opts.forcarNovo) {
    return {
      token: tokenAtual,
      criado: false,
      regenerado: false,
      compartilhado: false,
      nome_wuzapi: nomeUser,
      precisa_conectar: true,
    };
  }

  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin || !config.wuzapiBaseUrl) {
    const err = new Error(
      'Servidor do WhatsApp sem configuração no backend. Avise o suporte — não é preciso gerar token na tela.'
    );
    err.status = 503;
    throw err;
  }

  const token = `pneu_${atual.id}_${crypto.randomBytes(8).toString('hex')}`;
  const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: admin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: nomeUser, token }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    const again = await adminUsersWuzapi({ forcar: true });
    const existente = (again || []).find((u) => {
      const name = String(u.name || u.Name || '').trim();
      return nomesOk.has(name) || name.startsWith(prefixoId);
    });
    const tokExistente = tokenNaoEAdmin(existente?.token || existente?.Token);
    if (tokExistente) {
      await gravarTokenFilialSeDiferente(atual.id, tokExistente);
      return {
        token: tokExistente,
        criado: false,
        regenerado: false,
        compartilhado: false,
        nome_wuzapi: existente.name || existente.Name || nomeUser,
        precisa_conectar: true,
      };
    }
    const err = new Error(
      ehErroDbInternoWuzapi(raw)
        ? 'O servidor do WhatsApp está com o banco interno fora. Nada foi apagado nas filiais.'
        : (`Não foi possível criar a sessão no servidor do WhatsApp. `
          + (raw ? String(raw).slice(0, 160) : 'Tente Conectar chip de novo em instantes.'))
    );
    err.status = 503;
    err.infraWuzapi = ehErroDbInternoWuzapi(raw);
    throw err;
  }

  await db.prepare(`
    UPDATE filiais SET
      wuzapi_token = ?,
      updated_at = NOW()
    WHERE id = ?
  `).run(token, atual.id);

  return {
    token,
    criado: true,
    regenerado: false,
    compartilhado: false,
    nome_wuzapi: nomeUser,
    precisa_conectar: true,
  };
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

  const payload = {
    Phone: dest.phone,
    Body: text,
  };
  if (opts.linkPreview) payload.LinkPreview = true;

  const data = await enviarNaSessaoFilial({
    path: '/chat/send/text',
    payload,
    timeoutMs: 20_000,
    filialId: opts.filialId,
    token: opts.token,
  });
  if (data?.skipped) {
    console.warn('[whatsapp] WuzAPI não configurado — mensagem não enviada:', dest.logKey);
    return {
      skipped: true,
      reason: 'wuzapi_nao_configurado',
      Phone: dest.phone,
      Body: text,
    };
  }
  return data;
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

  const b64 = Buffer.from(buffer).toString('base64');
  const dataUri = `data:application/octet-stream;base64,${b64}`;
  const payload = {
    Phone: dest.phone,
    FileName: nome,
    Document: dataUri,
  };
  if (opts.caption) payload.Caption = String(opts.caption).slice(0, 900);

  const enviarDoc = (body) => enviarNaSessaoFilial({
    path: '/chat/send/document',
    payload: body,
    timeoutMs: 90_000,
    filialId: opts.filialId,
    token: opts.token,
  });

  try {
    const data = await enviarDoc(payload);
    if (data?.skipped) {
      console.warn('[whatsapp] WuzAPI não configurado — documento não enviado:', dest.logKey);
      return {
        skipped: true,
        reason: 'wuzapi_nao_configurado',
        Phone: dest.phone,
        FileName: nome,
      };
    }
    return data;
  } catch (err) {
    if (payload.Caption && /caption|unknown|invalid/i.test(err.message || '')) {
      return enviarDoc({ Phone: dest.phone, FileName: nome, Document: dataUri });
    }
    throw err;
  }
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
