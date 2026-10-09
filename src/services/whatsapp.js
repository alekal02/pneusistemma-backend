/**
 * Cliente WuzAPI — envio de mensagens WhatsApp
 * Spec: POST /chat/send/text com header `token` e body { Phone, Body, LinkPreview? }
 * Phone = número (DDI…) ou JID de grupo (…@g.us)
 * Token = um único usuário WuzAPI (chip do chatbot). Cada filial só escolhe o grupo.
 * O WUZAPI_TOKEN do .env é fallback se ainda não houver token global gravado.
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

/**
 * Telefone real do participante. LID e JID de grupo não identificam a pessoa.
 * 15+ dígitos é o id numérico de grupo, não um celular.
 */
export function telefoneConfiavel(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (/@g\.us/i.test(raw) || /@lid/i.test(raw)) return '';
  const digits = limparTelefone(raw);
  if (digits.length < 10 || digits.length > 14) return '';
  return digits;
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
 * Tokens para envio: sessão global do chatbot, depois legado da filial / .env.
 */
async function listarTokensEnvio(filialId, explicitToken) {
  const tokens = [];
  const add = (t) => {
    const u = tokenNaoEAdmin(t);
    if (u && !tokens.includes(u)) tokens.push(u);
  };
  add(explicitToken);
  add(await tokenWhatsappGlobal());
  add(await tokenWuzapiFilial(filialId, { permitirEnv: false }));
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
      body: JSON.stringify({ Subscribe: ['Message'], Immediate: false }),
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

const CHAVE_TOKEN_GLOBAL = 'whatsapp_token_global';
const CHAVE_CHIP_GLOBAL = 'whatsapp_chip_global';
export const NOME_WUZAPI_GLOBAL = 'PneuSistemma';

async function upsertConfiguracao(chave, valor) {
  const db = getDb();
  await db.prepare(`
    INSERT INTO configuracoes (chave, valor, updated_at)
    VALUES (?, ?, NOW())
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
  `).run(chave, valor == null ? '' : String(valor));
}

async function lerConfiguracao(chave) {
  const db = getDb();
  const row = await db.prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave);
  return row?.valor != null ? String(row.valor) : '';
}

export async function tokenWhatsappGlobal() {
  const salvo = tokenNaoEAdmin(await lerConfiguracao(CHAVE_TOKEN_GLOBAL));
  if (salvo) return salvo;
  return tokenNaoEAdmin(config.wuzapiToken);
}

export async function gravarTokenWhatsappGlobal(token) {
  const t = tokenNaoEAdmin(token);
  if (!t) return;
  await upsertConfiguracao(CHAVE_TOKEN_GLOBAL, t);
}

export async function chipWhatsappGlobal() {
  return limparTelefone(await lerConfiguracao(CHAVE_CHIP_GLOBAL));
}

export async function gravarChipWhatsappGlobal(phone) {
  const digits = limparTelefone(phone);
  await upsertConfiguracao(CHAVE_CHIP_GLOBAL, digits || '');
}

/**
 * Token da sessão do chatbot (única). Filial só entra como legado.
 * @param {number|string|null} filialId
 * @param {{ permitirEnv?: boolean }} [opts]
 */
export async function tokenWuzapiFilial(filialId, opts = {}) {
  const permitirEnv = opts.permitirEnv !== false;
  const global = await tokenWhatsappGlobal();
  if (global) return global;
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

function usuarioWuzapiGlobalNaLista(users, tokenPreferido = '') {
  const t = tokenNaoEAdmin(tokenPreferido);
  const lista = users || [];
  if (t) {
    const porToken = lista.find((u) => tokenNaoEAdmin(u.token || u.Token) === t);
    if (porToken) return porToken;
  }
  return lista.find((u) => {
    const name = String(u.name || u.Name || '').trim();
    return name === NOME_WUZAPI_GLOBAL || /^PneuSistemma$/i.test(name);
  }) || null;
}

async function silenciarWebhooksSessoesAntigas(tokenKeeper) {
  const keeper = tokenNaoEAdmin(tokenKeeper);
  if (!keeper || !config.wuzapiBaseUrl) return 0;
  const users = await adminUsersWuzapi({ forcar: true });
  let n = 0;
  for (const u of users || []) {
    const tok = tokenNaoEAdmin(u.token || u.Token);
    if (!tok || tok === keeper) continue;
    const name = String(u.name || u.Name || '').trim();
    if (!ehUsuarioWuzapiPorFilial(name) && !/^PneuSistemma$/i.test(name)) continue;
    try {
      await fetch(`${config.wuzapiBaseUrl}/webhook`, {
        method: 'DELETE',
        headers: headersUsuarioWuzapi(tok),
        signal: AbortSignal.timeout(8_000),
      });
      n += 1;
    } catch {
      // sessão antiga pode já estar morta
    }
  }
  if (n) console.info('[whatsapp] webhooks antigos desligados', { n });
  return n;
}

/**
 * Garante o único usuário WuzAPI do chatbot. Não cria um por filial.
 */
export async function garantirUsuarioWuzapiGlobal() {
  const tokenAtual = await tokenWhatsappGlobal();
  const users = await adminUsersWuzapi({ forcar: true });
  const existente = usuarioWuzapiGlobalNaLista(users, tokenAtual);
  const tokExistente = tokenNaoEAdmin(existente?.token || existente?.Token);
  if (tokExistente) {
    await gravarTokenWhatsappGlobal(tokExistente);
    silenciarWebhooksSessoesAntigas(tokExistente).catch(() => {});
    return {
      token: tokExistente,
      criado: false,
      nome_wuzapi: existente.name || existente.Name || NOME_WUZAPI_GLOBAL,
      precisa_conectar: !sessaoWuzapiAtiva(existente),
    };
  }

  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin || !config.wuzapiBaseUrl) {
    const err = new Error(
      'Servidor do WhatsApp sem configuração no backend. Avise o suporte.'
    );
    err.status = 503;
    throw err;
  }

  const token = `pneu_global_${crypto.randomBytes(8).toString('hex')}`;
  const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: admin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: NOME_WUZAPI_GLOBAL, token }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    const again = await adminUsersWuzapi({ forcar: true });
    const retry = usuarioWuzapiGlobalNaLista(again, token);
    const tokRetry = tokenNaoEAdmin(retry?.token || retry?.Token);
    if (tokRetry) {
      await gravarTokenWhatsappGlobal(tokRetry);
      return {
        token: tokRetry,
        criado: false,
        nome_wuzapi: retry.name || retry.Name || NOME_WUZAPI_GLOBAL,
        precisa_conectar: !sessaoWuzapiAtiva(retry),
      };
    }
    const err = new Error(
      ehErroDbInternoWuzapi(raw)
        ? 'O servidor do WhatsApp está com o banco interno fora. Tente de novo em instantes.'
        : (`Não foi possível criar a sessão do chatbot. ${raw ? String(raw).slice(0, 160) : 'Tente Conectar de novo.'}`)
    );
    err.status = 503;
    err.infraWuzapi = ehErroDbInternoWuzapi(raw);
    throw err;
  }

  let dataCreate = {};
  try { dataCreate = raw ? JSON.parse(raw) : {}; } catch { dataCreate = {}; }
  const tokCreate = tokenNaoEAdmin(
    dataCreate?.token || dataCreate?.Token || dataCreate?.data?.token || dataCreate?.data?.Token
  ) || token;
  await gravarTokenWhatsappGlobal(tokCreate);
  cacheAdminUsersSvc = { at: 0, users: null };
  silenciarWebhooksSessoesAntigas(tokCreate).catch(() => {});
  return {
    token: tokCreate,
    criado: true,
    nome_wuzapi: NOME_WUZAPI_GLOBAL,
    precisa_conectar: true,
  };
}

export async function sessaoVivaGlobal({ forcarUsers = false } = {}) {
  const token = await tokenWhatsappGlobal();
  const users = await adminUsersWuzapi({ forcar: forcarUsers });
  const u = usuarioWuzapiGlobalNaLista(users, token);
  const tok = tokenNaoEAdmin(u?.token || u?.Token) || token;
  if (!tok || !sessaoWuzapiAtiva(u)) return null;
  const phone = limparTelefone(u.jid || u.JID || u.phone || u.Phone);
  return {
    token: tok,
    name: u.name || u.Name || NOME_WUZAPI_GLOBAL,
    jid: u.jid || u.JID || null,
    phone,
    loggedIn: true,
  };
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
    `Pneu${filial.id}`,
    codigo,
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
  return Boolean(u?.loggedIn ?? u?.LoggedIn);
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
    const porNome = nomesOk.has(name)
      || name.startsWith(prefixoId)
      || [...nomesOk].some((n) => n.toLowerCase() === name.toLowerCase());
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
  // JID antigo no admin não conta: depois do logout no celular o número fica residual.
  if (!sessaoWuzapiAtiva(u)) return null;
  return {
    token,
    name: u.name || u.Name || null,
    jid: u.jid || u.JID || null,
    phone,
    loggedIn: true,
  };
}

const recriarLockPorFilial = new Map();

export async function reconectarSessaoVivaFilial(filial, { forcarUsers = false, naoGravar = false } = {}) {
  const global = await sessaoVivaGlobal({ forcarUsers }).catch(() => null);
  if (global?.token) {
    const phone = limparTelefone(global.phone);
    if (phone) await gravarChipWhatsappGlobal(phone);
    return global;
  }
  if (!filial?.id) return null;
  if (recriarLockPorFilial.has(Number(filial.id))) return null;
  const viva = await sessaoVivaDaFilial(filial, { forcarUsers });
  if (!viva?.token) return null;
  if (!naoGravar) await gravarTokenFilialSeDiferente(filial.id, viva.token);
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
  const forcarNovo = Boolean(opts.forcarNovo);
  // Token já gravado: não consulta /admin/users nem cria outro usuário.
  // POST /admin/users a cada Conectar derruba o WuzAPI (sqlite/disco).
  if (tokenAtual && !forcarNovo) {
    const compartilhado = await tokenUsadoPorOutraFilial(atual.id, tokenAtual);
    if (!compartilhado) {
      return {
        token: tokenAtual,
        criado: false,
        regenerado: false,
        compartilhado: false,
        nome_wuzapi: nomeUser,
        precisa_conectar: true,
      };
    }
  }
  const compartilhado = tokenAtual
    ? await tokenUsadoPorOutraFilial(atual.id, tokenAtual)
    : false;

  const nomesOk = nomesUsuarioWuzapiFilial(atual);
  const nomesLow = new Set([...nomesOk].map((n) => n.toLowerCase()));
  const prefixoId = `Pneu${atual.id}-`;
  const nomeSan = String(atual.nome || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const daMesmaFilial = (lista) => (lista || []).filter((u) => {
    const name = String(u.name || u.Name || '').trim();
    const tok = tokenNaoEAdmin(u.token || u.Token);
    if (nomesOk.has(name) || name.startsWith(prefixoId)) return true;
    if (nomesLow.has(name.toLowerCase())) return true;
    if (nomeSan.length >= 5 && name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === nomeSan) return true;
    return Boolean(tokenAtual && tok === tokenAtual);
  });

  let usersWuz = await adminUsersWuzapi({ forcar: true });
  let daFilial = daMesmaFilial(usersWuz);

  // Uma unidade = uma key. Duplicatas desconectadas desta filial são apagadas.
  // Nunca apaga sessão de outra unidade (Pneu-CN1, Pneu-UB1, etc.).
  if (daFilial.length > 1) {
    const keeper = daFilial.find((u) => sessaoWuzapiAtiva(u)) || daFilial[0];
    const keeperId = String(keeper.id ?? keeper.Id ?? keeper.ID ?? '');
    const adminTok = tokenWuzapiUtil(config.wuzapiAdminToken);
    for (const u of daFilial) {
      const id = u.id ?? u.Id ?? u.ID;
      if (id == null || String(id) === keeperId) continue;
      if (sessaoWuzapiAtiva(u)) continue;
      if (!adminTok) continue;
      try {
        await fetch(`${config.wuzapiBaseUrl}/admin/users/${id}`, {
          method: 'DELETE',
          headers: { Authorization: adminTok },
          signal: AbortSignal.timeout(12_000),
        });
      } catch (err) {
        console.warn('[whatsapp] apagar duplicata WuzAPI:', err.message);
      }
    }
    cacheAdminUsersSvc = { at: 0, users: null };
    await new Promise((r) => setTimeout(r, 500));
    usersWuz = await adminUsersWuzapi({ forcar: true });
    daFilial = daMesmaFilial(usersWuz);
  }

  const dedicado = daFilial.find((u) => sessaoWuzapiAtiva(u)) || daFilial[0] || null;
  if (dedicado) {
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

  const tokenExisteNoWuzapi = Boolean(
    tokenAtual && usersWuz.some((u) => tokenNaoEAdmin(u.token || u.Token) === tokenAtual)
  );
  // Token no cadastro sem usuário no WuzAPI = órfão (401). Não reutilizar.
  if (tokenAtual && (tokenExisteNoWuzapi || usersWuz.length === 0) && !compartilhado) {
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

  let dataCreate = {};
  try { dataCreate = raw ? JSON.parse(raw) : {}; } catch { dataCreate = {}; }
  const tokCreate = tokenNaoEAdmin(
    dataCreate?.token || dataCreate?.Token || dataCreate?.data?.token || dataCreate?.data?.Token
  );

  await new Promise((r) => setTimeout(r, 600));
  const confirmados = await adminUsersWuzapi({ forcar: true });
  const criadoUser = (confirmados || []).find((u) => {
    const name = String(u.name || u.Name || '').trim();
    return name === nomeUser || nomesOk.has(name) || name.startsWith(prefixoId);
  });
  const tokReal = tokenNaoEAdmin(criadoUser?.token || criadoUser?.Token) || tokCreate || token;

  await db.prepare(`
    UPDATE filiais SET
      wuzapi_token = ?,
      updated_at = NOW()
    WHERE id = ?
  `).run(tokReal, atual.id);

  return {
    token: tokReal,
    criado: true,
    regenerado: false,
    compartilhado: false,
    nome_wuzapi: criadoUser?.name || criadoUser?.Name || nomeUser,
    precisa_conectar: true,
  };
}

function usuariosWuzapiDestaFilial(filial, users) {
  const prefixoId = `Pneu${filial.id}-`;
  const nomeAtual = nomeUsuarioWuzapiFilial(filial);
  const tokenAtual = tokenNaoEAdmin(filial.wuzapi_token);
  return (users || []).filter((u) => {
    const name = String(u.name || u.Name || '').trim();
    const tok = tokenNaoEAdmin(u.token || u.Token);
    if (name === nomeAtual || name.startsWith(prefixoId)) return true;
    if (tokenAtual && tok && tok === tokenAtual) return true;
    return false;
  });
}

async function apagarUsuarioWuzapi(idUser, admin) {
  if (idUser == null || !admin) return false;
  try {
    const res = await fetch(`${config.wuzapiBaseUrl}/admin/users/${idUser}`, {
      method: 'DELETE',
      headers: { Authorization: admin },
      signal: AbortSignal.timeout(12_000),
    });
    return res.ok || res.status === 404;
  } catch (err) {
    console.warn('[whatsapp] apagar usuário WuzAPI:', err.message);
    return false;
  }
}

function ehUsuarioWuzapiPorFilial(name) {
  const n = String(name || '').trim();
  if (!n || n === NOME_WUZAPI_GLOBAL) return false;
  return /^Pneu\d+-/i.test(n)
    || /^PneuSistemma-\d/i.test(n)
    || /^Pneu-\d/i.test(n);
}

/**
 * Uma vez: apaga tokens por filial no banco e usuários Pneu{id}-* no WuzAPI.
 * Mantém os grupos. O admin reconecta um único chip.
 */
export async function limparTokensChatbotAntigos() {
  const db = getDb();
  const flag = await db.prepare(
    'SELECT valor FROM configuracoes WHERE chave = ?'
  ).get('whatsapp_admin_global_v1');
  if (String(flag?.valor || '') === '1') {
    return { skipped: true };
  }

  const limpos = await db.prepare(`
    UPDATE filiais SET
      wuzapi_token = NULL,
      whatsapp = NULL,
      updated_at = NOW()
    WHERE wuzapi_token IS NOT NULL
      OR (whatsapp IS NOT NULL AND TRIM(whatsapp) != '')
  `).run();

  await upsertConfiguracao(CHAVE_TOKEN_GLOBAL, '');
  await upsertConfiguracao(CHAVE_CHIP_GLOBAL, '');

  let apagadosWuz = 0;
  try {
    const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
    const users = await adminUsersWuzapi({ forcar: true });
    for (const u of users || []) {
      const name = String(u.name || u.Name || '').trim();
      if (!ehUsuarioWuzapiPorFilial(name)) continue;
      const ok = await apagarUsuarioWuzapi(u.id ?? u.Id ?? u.ID, admin);
      if (ok) apagadosWuz += 1;
    }
    cacheAdminUsersSvc = { at: 0, users: null };
  } catch (err) {
    console.warn('[whatsapp] limpeza WuzAPI:', err.message);
  }

  await upsertConfiguracao('whatsapp_admin_global_v1', '1');
  console.info('[whatsapp] tokens por filial limpos', {
    filiais: limpos?.changes ?? limpos?.rowCount ?? null,
    wuzapi_users: apagadosWuz,
  });
  return { skipped: false, apagadosWuz };
}

/**
 * Apaga a sessão WuzAPI desta unidade e cria token novo.
 * Só mexe em Pneu{id}-* desta filial — não toca Unaí/Caldas/outras.
 */
export async function recriarUsuarioWuzapiFilial(filial) {
  if (!filial?.id) throw new Error('Filial inválida para token WhatsApp');
  const existente = recriarLockPorFilial.get(Number(filial.id));
  if (existente) return existente;
  const p = recriarUsuarioWuzapiFilialInterno(filial).finally(() => {
    if (recriarLockPorFilial.get(Number(filial.id)) === p) {
      recriarLockPorFilial.delete(Number(filial.id));
    }
  });
  recriarLockPorFilial.set(Number(filial.id), p);
  return p;
}

async function recriarUsuarioWuzapiFilialInterno(filial) {
  const db = getDb();
  const atual = await db.prepare(`
    SELECT id, nome, codigo, wuzapi_token FROM filiais WHERE id = ?
  `).get(filial.id);
  if (!atual) throw new Error('Filial não encontrada');

  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin || !config.wuzapiBaseUrl) {
    const err = new Error('Servidor do WhatsApp sem configuração no backend.');
    err.status = 503;
    throw err;
  }

  const nomeUser = nomeUsuarioWuzapiFilial(atual);
  for (let round = 0; round < 3; round++) {
    const users = await adminUsersWuzapi({ forcar: true });
    const daFilial = usuariosWuzapiDestaFilial(atual, users);
    if (!daFilial.length) break;
    for (const u of daFilial) {
      await apagarUsuarioWuzapi(u.id ?? u.Id ?? u.ID, admin);
    }
    cacheAdminUsersSvc = { at: 0, users: null };
    await new Promise((r) => setTimeout(r, 900));
  }
  const ainda = usuariosWuzapiDestaFilial(atual, await adminUsersWuzapi({ forcar: true }));
  if (ainda.length) {
    const err = new Error('Não consegui apagar a sessão antiga desta unidade. Tente Conectar de novo em instantes.');
    err.status = 503;
    throw err;
  }
  await new Promise((r) => setTimeout(r, 400));

  const token = `pneu_${atual.id}_${crypto.randomBytes(8).toString('hex')}`;
  let res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: admin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: nomeUser, token }),
    signal: AbortSignal.timeout(15_000),
  });
  let raw = await res.text();
  if (!res.ok) {
    const usersRetry = await adminUsersWuzapi({ forcar: true });
    const daFilialRetry = usuariosWuzapiDestaFilial(atual, usersRetry);
    for (const u of daFilialRetry) {
      await apagarUsuarioWuzapi(u.id ?? u.Id ?? u.ID, admin);
    }
    cacheAdminUsersSvc = { at: 0, users: null };
    await new Promise((r) => setTimeout(r, 1200));
    const nomeAlt = `${nomeUser}${Date.now().toString(36).slice(-3)}`;
    res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        Authorization: admin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: nomeAlt, token }),
      signal: AbortSignal.timeout(15_000),
    });
    raw = await res.text();
  }
  if (!res.ok) {
    const err = new Error(
      ehErroDbInternoWuzapi(raw)
        ? 'O servidor do WhatsApp está com o banco interno fora. Tente de novo em instantes.'
        : (`Não foi possível criar a sessão nova. ${raw ? String(raw).slice(0, 160) : 'Tente Conectar de novo.'}`)
    );
    err.status = 503;
    err.infraWuzapi = ehErroDbInternoWuzapi(raw);
    throw err;
  }

  let dataCreate = {};
  try { dataCreate = raw ? JSON.parse(raw) : {}; } catch { dataCreate = {}; }
  const tokCreate = tokenNaoEAdmin(
    dataCreate?.token || dataCreate?.Token || dataCreate?.data?.token || dataCreate?.data?.Token
  ) || token;

  await db.prepare(`
    UPDATE filiais SET
      wuzapi_token = ?,
      updated_at = NOW()
    WHERE id = ?
  `).run(tokCreate, atual.id);

  cacheAdminUsersSvc = { at: 0, users: null };
  await new Promise((r) => setTimeout(r, 400));
  return {
    token: tokCreate,
    criado: true,
    regenerado: true,
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

  if (dest?.phone && pularEnvioDuplicado(dest.logKey, `${fileName || ''}\n${caption || preview}`, 'doc')) {
    console.info('[whatsapp] documento duplicado ignorado', { dest: dest.logKey, tipo });
    return { ok: true, duplicado: true };
  }

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

const enviosRecentes = new Map();
const ENVIO_DEDUP_MS = 20_000;

function chaveConteudoEnvio(mensagem) {
  return String(mensagem || '')
    .replace(/https?:\/\/[^\s)]+/gi, '[link]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function pularEnvioDuplicado(destKey, mensagem, extra = '') {
  const now = Date.now();
  const chave = `${destKey}|${extra}|${chaveConteudoEnvio(mensagem)}`;
  const prev = enviosRecentes.get(chave);
  if (prev && now - prev < ENVIO_DEDUP_MS) return true;
  enviosRecentes.set(chave, now);
  if (enviosRecentes.size > 250) {
    for (const [k, ts] of enviosRecentes) {
      if (now - ts > ENVIO_DEDUP_MS) enviosRecentes.delete(k);
    }
  }
  return false;
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
  if (dest?.phone && pularEnvioDuplicado(dest.logKey, mensagem)) {
    console.info('[whatsapp] envio duplicado ignorado', { dest: dest.logKey, tipo });
    return { ok: true, duplicado: true };
  }
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
