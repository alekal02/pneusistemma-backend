/**
 * Proxy admin → WuzAPI (status, QR, connect/disconnect)
 * Conexão padrão (.env) + conexão por filial (wuzapi_token)
 * + CRUD de destinatários extras de alerta
 */
import { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../database.js';
import { ehViolacaoUnique } from '../db-utils.js';
import {
  requireAuth,
  requireAdmin,
  requireGerenteOuAdmin,
  requireChatbotAcesso,
  filiaisEscopoIds,
  isAdmin,
} from '../auth.js';
import {
  limparTelefone,
  wuzapiConfigurado,
  tokenWuzapiFilial,
  tokenWuzapiUtil,
  enviarERegistrar,
  normalizarDestino,
  chipsWhatsappIguais,
  tokenUsadoPorOutraFilial,
  chipUsadoPorOutraFilial,
  garantirTokenExclusivoFilial,
  sessaoVivaDaFilial,
  reconectarSessaoVivaFilial,
} from '../services/whatsapp.js';

const router = Router();

router.use(requireAuth);

function assertFilialNoEscopo(req, filialId) {
  const escopo = filiaisEscopoIds(req);
  if (escopo === null) return true;
  return escopo.includes(Number(filialId));
}

async function wuzapiAdminFetch(path, { method = 'GET', body } = {}) {
  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin) {
    const err = new Error(
      'WUZAPI_ADMIN_TOKEN não configurado no backend/.env. Use o mesmo valor do Docker (ex.: 1234ABCD).'
    );
    err.status = 503;
    throw err;
  }
  const url = `${config.wuzapiBaseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: admin,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    const err = new Error(
      `Não foi possível conectar ao WuzAPI em ${config.wuzapiBaseUrl}. `
      + 'Suba com: npm run wuzapi:up  (ou docker compose -f docker-compose.wuzapi.yml up -d). '
      + `(${e.message})`
    );
    err.status = 503;
    throw err;
  }
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  if (!res.ok) {
    const bruto = data?.error || data?.erro || data?.details || data?.message || `WuzAPI admin ${res.status}`;
    const err = new Error(bruto);
    err.status = (res.status === 401 || res.status === 403) ? 502 : res.status;
    err.data = data;
    if (ehErroInfraWuzapi(bruto)) {
      err.status = 503;
      err.infraWuzapi = true;
      err.bancoInterno = ehErroBancoInternoWuzapi(bruto);
      err.message = mensagemInfraWuzapi(bruto);
    } else if (res.status === 401 || res.status === 403) {
      err.message = 'WUZAPI_ADMIN_TOKEN inválido. Confira backend/.env e o token admin do container WuzAPI.';
    }
    throw err;
  }
  return data;
}

async function wuzapiFetch(path, { method = 'GET', body, token, timeoutMs = 12_000 } = {}) {
  // Sem fallback silencioso: quem chama sem token usa o .env só nas rotas admin.
  const t = tokenWuzapiUtil(token !== undefined ? token : config.wuzapiToken);
  if (!wuzapiConfigurado(t)) {
    const err = new Error('WuzAPI não configurado (URL + token da filial ou .env)');
    err.status = 503;
    throw err;
  }

  const url = `${config.wuzapiBaseUrl}${path}`;
  const payload = body ? JSON.stringify(body) : undefined;
  // Só o header `token`. Enviar Token+token juntos vira valor duplicado e a WuzAPI responde 401.
  let res;
  let raw = '';
  let data = {};
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        token: t,
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await res.text();
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }
  } catch (e) {
    const cause = e?.cause?.code || e?.code || e?.name || '';
    const err = new Error(
      `Não foi possível conectar ao WuzAPI em ${config.wuzapiBaseUrl}. `
      + 'Verifique se o serviço está rodando (porta 8080) e se o token da filial está correto. '
      + `(${e.message}${cause ? ` / ${cause}` : ''})`
    );
    err.status = 503;
    throw err;
  }

  if (res.ok) return data;

  const bruto = [data?.error, data?.erro, data?.details, data?.message, data?.Error, data?.raw]
    .map((p) => (typeof p === 'string' ? p : p ? JSON.stringify(p) : ''))
    .filter(Boolean)
    .join(' ') || `WuzAPI ${res.status}`;
  const err = new Error(bruto);
  const upstream = res.status;
  err.status = (upstream === 401 || upstream === 403) ? 502 : upstream;
  err.upstreamStatus = upstream;
  err.data = data;
  if (ehErroInfraWuzapi(bruto)) {
    err.status = 503;
    err.infraWuzapi = true;
    err.bancoInterno = ehErroBancoInternoWuzapi(bruto);
    err.message = mensagemInfraWuzapi(bruto);
  } else if (upstream === 401 || upstream === 403) {
    err.message = `WuzAPI ${upstream}: ${bruto || 'unauthorized'}`;
  }
  throw err;
}

/** Extrai número pessoal do JID WhatsApp (ignora device :xx e JID de grupo). */
export function telefoneFromJid(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  if (/@(g\.us|newsletter|broadcast)$/i.test(raw)) return '';
  const user = raw.split('@')[0] || '';
  const base = user.split(':')[0] || '';
  const digits = base.replace(/\D/g, '');
  return pareceNumeroCelular(digits) ? digits : '';
}

function pareceNumeroCelular(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return false;
  // Grupo WhatsApp costuma ser 17–19 dígitos começando em 120363…
  if (d.length >= 15 && d.startsWith('120')) return false;
  return true;
}

function normalizarStatus(payload, extra = {}) {
  const d = payload?.data || payload || {};
  const jid = d.jid || d.JID || null;
  const phone = telefoneFromJid(jid) || telefoneFromJid(d.phone || d.Phone) || null;
  return {
    configurado: true,
    wuzapi_url: config.wuzapiBaseUrl,
    connected: Boolean(d.connected ?? d.Connected),
    loggedIn: Boolean(d.loggedIn ?? d.LoggedIn),
    name: d.name || d.Name || null,
    jid,
    phone,
    webhook: d.webhook || d.Webhook || null,
    events: d.events || d.Events || null,
    qrcode: extrairQr(payload),
    token_configurado: Boolean(extra.token || config.wuzapiToken),
    ...extra,
  };
}

/** Um único estado para a tela: evita o painel oscilar entre Conectado / Desconectado. */
function classificarEstadoConexao(st = {}) {
  if (st.loggedIn && !st.sessao_alheia && !st.token_compartilhado) return 'conectado';
  if (st.sessao_alheia || st.token_compartilhado) return 'precisa_qr';
  if (st.infra_wuzapi) return 'servidor_indisponivel';
  if (st.configurado === false) return 'precisa_token';
  if (st.qrcode || (st.connected && !st.loggedIn)) return 'aguardando_qr';
  return 'offline';
}

function comEstado(st = {}) {
  const payload = { ...st };
  delete payload.forcar_qr;
  payload.estado = classificarEstadoConexao(payload);
  return payload;
}

function mensagemChipCadastrado(chip) {
  const n = String(chip || '').replace(/\D/g, '');
  return n
    ? `Chip ${n} desta unidade continua cadastrado. Não precisa escanear de novo.`
    : 'O chip desta unidade continua cadastrado. Não precisa escanear de novo.';
}

/** Chip já salvo no cadastro: trata como conectado quando o WuzAPI oscila. */
function respostaChipCadastrado(extra, extras = {}) {
  const chip = String(extra?.chip_salvo || extra?.whatsapp || extras.phone || '').replace(/\D/g, '');
  if (chip.length < 10) return null;
  return comEstado({
    configurado: true,
    ...extra,
    instavel: true,
    ...extras,
    phone: extras.phone || chip,
    loggedIn: true,
    connected: true,
    qrcode: '',
    chip_presumido: true,
    infra_wuzapi: false,
    mensagem: extras.mensagem || mensagemChipCadastrado(chip),
  });
}

let cacheAdminUsers = { at: 0, lista: null };
const ADMIN_USERS_TTL_MS = 10_000;

function invalidarCacheAdminUsers() {
  cacheAdminUsers = { at: 0, lista: null };
}

async function listaAdminUsersWuzapi({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && cacheAdminUsers.lista && (agora - cacheAdminUsers.at) < ADMIN_USERS_TTL_MS) {
    return cacheAdminUsers.lista;
  }
  const lista = await wuzapiAdminFetch('/admin/users');
  cacheAdminUsers = { at: agora, lista };
  return lista;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ehErroBancoInternoWuzapi(msg) {
  return /lookup db|127\.0\.0\.11|server misbehaving|pq:|could not translate|banco interno/i
    .test(String(msg || ''));
}

function ehErroInfraWuzapi(msg) {
  return ehErroBancoInternoWuzapi(msg)
    || /dial tcp|connection refused|i\/o timeout|no such host|context deadline|econnrefused|enotfound|fetch failed|aborted|undici/i
      .test(String(msg || ''));
}

function mensagemInfraWuzapi(origem, { parear = false } = {}) {
  if (parear) {
    return 'Ainda não consegui o QR. Clique em “Gerar QR de novo” — o chip anterior já foi desconectado.';
  }
  const msg = typeof origem === 'string' ? origem : (origem?.message || origem?.qr_erro || '');
  const banco = origem?.bancoInterno || ehErroBancoInternoWuzapi(msg);
  if (banco) {
    return 'O servidor do WhatsApp está lento agora. O chip desta unidade não foi desconectado.';
  }
  return 'Não foi possível confirmar o WhatsApp agora. O chip não foi desconectado.';
}

/** Aceita data URL, base64 puro ou campos QRCode/qrcode em vários formatos da WuzAPI. */
function extrairQr(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const nested = d.data && typeof d.data === 'object' ? d.data : {};
  const raw = d.QRCode || d.qrcode || d.QrCode || d.qr
    || nested.QRCode || nested.qrcode
    || payload?.QRCode || payload?.qrcode || payload?.QrCode || payload?.qr || '';
  let qr = String(raw || '').trim();
  if (!qr || qr === 'null' || qr === 'undefined') return '';
  if (qr.startsWith('data:image')) return qr;
  const compact = qr.replace(/\s/g, '');
  if (compact.length > 80 && /^[A-Za-z0-9+/]+=*$/.test(compact)) {
    return `data:image/png;base64,${compact}`;
  }
  return qr;
}

async function buscarQr(token, timeoutMs = 8_000) {
  try {
    const qrData = await wuzapiFetch('/session/qr', { token, timeoutMs });
    const qr = extrairQr(qrData);
    if (qr) return qr;
  } catch (err) {
    const msg = String(err.message || '');
    if (!(/not connected|não conect|nao conect/i.test(msg) || err.upstreamStatus === 500)) {
      throw err;
    }
  }
  try {
    const lista = await listaAdminUsersWuzapi({ forcar: true });
    const users = Array.isArray(lista?.data) ? lista.data : (Array.isArray(lista) ? lista : []);
    const t = chaveTokenWuz(token);
    const u = (users || []).find((x) => tokenWuzapiUtil(x.token || x.Token) === t);
    const qr = extrairQr(u) || extrairQr({ data: u });
    if (qr) return qr;
  } catch {
    // admin opcional
  }
  return '';
}

const qrCachePorToken = new Map();
const buscaQrFundo = new Map();

function chaveTokenWuz(token) {
  return tokenWuzapiUtil(token) || String(token || '');
}

function qrDoCache(token) {
  const c = qrCachePorToken.get(chaveTokenWuz(token));
  if (!c?.qrcode) return '';
  if (Date.now() - c.at > 28_000) return '';
  return c.qrcode;
}

function guardarQr(token, qr) {
  if (!qr) return '';
  qrCachePorToken.set(chaveTokenWuz(token), { qrcode: qr, at: Date.now() });
  return qr;
}

function limparQrFilial(filialId, token) {
  if (filialId != null) pareamentoAtivo.delete(Number(filialId));
  if (token) {
    qrCachePorToken.delete(chaveTokenWuz(token));
    buscaQrFundo.delete(chaveTokenWuz(token));
  }
}

const connectLockPorToken = new Map();

/** Um connect por vez. Se o websocket já está no ar, só lê o QR. */
async function garantirWebsocketQr(token) {
  const cached = qrDoCache(token);
  if (cached) return cached;
  const key = chaveTokenWuz(token);
  const lock = connectLockPorToken.get(key);
  if (lock) return lock;
  const p = (async () => {
    try {
      let n = null;
      try {
        n = normalizarStatus(await wuzapiFetch('/session/status', { token, timeoutMs: 5_000 }));
      } catch {
        n = null;
      }
      if (n?.qrcode) return guardarQr(token, n.qrcode);
      if (n?.loggedIn) return '';
      if (n?.connected) {
        const qr = await buscarQr(token, 5_000);
        return qr ? guardarQr(token, qr) : '';
      }
      await conectarSessao(token, 12_000, { immediate: true });
      await sleep(1500);
      const qr = await buscarQr(token, 5_000);
      if (qr) return guardarQr(token, qr);
      try {
        const n2 = normalizarStatus(await wuzapiFetch('/session/status', { token, timeoutMs: 4_000 }));
        if (n2.qrcode) return guardarQr(token, n2.qrcode);
      } catch {
        // poll lê de novo
      }
      return '';
    } finally {
      if (connectLockPorToken.get(key) === p) connectLockPorToken.delete(key);
    }
  })();
  connectLockPorToken.set(key, p);
  return p;
}

async function obterQrComSessaoPronta(token) {
  return garantirWebsocketQr(token);
}

async function esperarQrCache(token, ms = 18_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const qr = qrDoCache(token);
    if (qr) return qr;
    await sleep(700);
  }
  return qrDoCache(token) || '';
}

/** Continua tentando o QR depois que o POST do Render já respondeu. */
function iniciarBuscaQrFundo(token, filialId) {
  const key = chaveTokenWuz(token);
  if (!key) return;
  pareamentoAtivo.set(Number(filialId), Date.now());
  if (buscaQrFundo.has(key)) return buscaQrFundo.get(key);
  const p = (async () => {
    const limite = Date.now() + 90_000;
    let lastConnectAt = 0;
    try {
      await garantirWebsocketQr(token);
      lastConnectAt = Date.now();
      while (Date.now() < limite && pareamentoAtivo.has(Number(filialId))) {
        if (qrDoCache(token)) {
          await sleep(4000);
          continue;
        }
        let connected = false;
        try {
          const n = normalizarStatus(await wuzapiFetch('/session/status', { token, timeoutMs: 4_000 }));
          if (n.qrcode) {
            guardarQr(token, n.qrcode);
            await sleep(4000);
            continue;
          }
          if (n.loggedIn) break;
          connected = Boolean(n.connected);
        } catch {
          connected = false;
        }
        if (connected) {
          const qr = await buscarQr(token, 4_000);
          if (qr) guardarQr(token, qr);
        } else if (Date.now() - lastConnectAt > 12_000) {
          await garantirWebsocketQr(token);
          lastConnectAt = Date.now();
        }
        await sleep(2500);
      }
    } catch (err) {
      console.warn('[whatsapp] QR fundo:', err.message);
    } finally {
      if (buscaQrFundo.get(key) === p) buscaQrFundo.delete(key);
    }
  })();
  buscaQrFundo.set(key, p);
  return p;
}

async function statusSessao(token, extra = {}) {
  let status = null;
  try {
    const data = await wuzapiFetch('/session/status', { token });
    status = normalizarStatus(data, extra);
  } catch (err) {
    // /session/status 401 é comum com sessão já pareada — o admin/users é a fonte fiel.
    const extraSessao = await telefoneDaSessaoWuzapi(token);
    if (extraSessao.loggedIn || extraSessao.phone) {
      return statusAPartirDoAdmin(extraSessao, extra);
    }
    throw err;
  }

  if (!status.loggedIn || !status.phone) {
    const extraSessao = await telefoneDaSessaoWuzapi(token);
    if (extraSessao.phone) status.phone = extraSessao.phone;
    if (extraSessao.jid && !status.jid) status.jid = extraSessao.jid;
    if (extraSessao.name && !status.name) status.name = extraSessao.name;
    if (extraSessao.loggedIn || extraSessao.phone) {
      status.loggedIn = true;
      status.connected = true;
    }
  }
  if (!status.loggedIn && status.connected && status.phone) {
    status.loggedIn = true;
  }
  if (status.loggedIn) status.qrcode = '';
  return status;
}

function statusAPartirDoAdmin(extraSessao, extra = {}) {
  return normalizarStatus({
    data: {
      loggedIn: true,
      connected: true,
      LoggedIn: true,
      Connected: true,
      jid: extraSessao.jid,
      phone: extraSessao.phone,
      name: extraSessao.name,
    },
  }, extra);
}

async function statusComQr(token, extra = {}) {
  let status;
  try {
    status = await statusSessao(token, extra);
  } catch (err) {
    status = normalizarStatus({}, extra);
    status.qr_erro = err.message;
    if (err.infraWuzapi) status.infra_wuzapi = true;
  }
  if (status.loggedIn && !extra.parear && !extra.forcar_qr) {
    status.qrcode = '';
    return status;
  }
  try {
    const qr = await buscarQr(token);
    if (qr) {
      status.qrcode = qr;
      status.qr_erro = null;
      status.infra_wuzapi = false;
    }
  } catch (err) {
    if (!status.qrcode) status.qr_erro = err.message;
  }
  return status;
}

/** /session/status muitas vezes não traz JID; o admin/users traz o chip que leu o QR. */
async function telefoneDaSessaoWuzapi(token) {
  try {
    const lista = await listaAdminUsersWuzapi();
    const users = Array.isArray(lista?.data) ? lista.data : (Array.isArray(lista) ? lista : []);
    const t = tokenWuzapiUtil(token);
    if (!t) return { phone: '', jid: null, name: null };
    // Só o usuário deste token — nunca outro chip logado
    const u = users.find((x) => tokenWuzapiUtil(x.token || x.Token) === t);
    if (!u) return { phone: '', jid: null, name: null };
    const jid = u.jid || u.JID || '';
    const phone = telefoneFromJid(jid) || telefoneFromJid(u.phone || u.Phone);
    const connected = Boolean(u.connected ?? u.Connected);
    const loggedInFlag = Boolean(u.loggedIn ?? u.LoggedIn);
    // JID pessoal = chip já leu o QR, mesmo se loggedIn vier atrasado
    const loggedIn = loggedInFlag || Boolean(phone && (connected || jid));
    return {
      phone,
      jid: jid || null,
      name: u.name || u.Name || null,
      loggedIn,
    };
  } catch {
    return { phone: '', jid: null, name: null };
  }
}

async function conectarSessao(token, timeoutMs = 20_000, { immediate = true } = {}) {
  try {
    return await wuzapiFetch('/session/connect', {
      method: 'POST',
      token,
      timeoutMs,
      body: { Subscribe: ['All'], Immediate: immediate },
    });
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    if (/already connected|already logged|in progress|session already/i.test(msg)) {
      return { already: true, error: err.message };
    }
    throw err;
  }
}

async function conectarSessaoComRetry(token, tentativas = 4) {
  let ultimo = null;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await conectarSessao(token);
    } catch (err) {
      ultimo = err;
      if (!ehErroInfraWuzapi(err.message) && !err.infraWuzapi) throw err;
      if (i < tentativas - 1) await sleep(2000 * (i + 1));
    }
  }
  throw ultimo;
}

const prepQrPorToken = new Map();
const pareamentoAtivo = new Map();

/** WuzAPI só gera QR com websocket conectado e loggedIn=false. */
async function garantirSessaoParaQr(token, { forcarQr = false } = {}) {
  const key = `${tokenWuzapiUtil(token) || String(token || '')}:${forcarQr ? 'qr' : 'st'}`;
  const existente = prepQrPorToken.get(key);
  if (existente) return existente;
  const p = (async () => {
    let n = null;
    try {
      n = normalizarStatus(await wuzapiFetch('/session/status', { token, timeoutMs: 4_000 }));
    } catch {
      // sessão morta — connect abaixo
    }
    if (n?.qrcode) return { loggedIn: false, connected: true, qrcode: n.qrcode };
    try {
      const qr = await obterQrComSessaoPronta(token, { ciclos: 1 });
      if (qr) return { loggedIn: false, connected: true, qrcode: qr };
    } catch (err) {
      if (err.upstreamStatus === 401 || err.upstreamStatus === 403) throw err;
      console.warn('[whatsapp] QR:', err.message);
    }
    if (n?.loggedIn && !forcarQr) {
      return {
        loggedIn: true,
        connected: true,
        qrcode: '',
        phone: n.phone || '',
        name: n.name || '',
        jid: n.jid || '',
      };
    }
    return { loggedIn: false, connected: true, qrcode: '' };
  })().finally(() => {
    if (prepQrPorToken.get(key) === p) prepQrPorToken.delete(key);
  });
  prepQrPorToken.set(key, p);
  return p;
}

async function buscarQrComRetry(token, tentativas = 6) {
  for (let i = 0; i < tentativas; i++) {
    if (i > 0) await sleep(800);
    try {
      const qr = await buscarQr(token, 5_000);
      if (qr) return qr;
    } catch (err) {
      if (err.upstreamStatus === 401 || err.upstreamStatus === 403) throw err;
      console.warn('[whatsapp] /session/qr:', err.message);
    }
  }
  return '';
}

/**
 * Conecta e espera o QR.
 * - Chip já no cadastro: não faz logout sozinho.
 * - Sem chip (Trocar chip / parear): encerra sessão residual e gera QR novo.
 */
async function conectarEObterQr(token, extra = {}) {
  const forcarQr = Boolean(extra.forcar_qr);
  const parear = Boolean(extra.parear) || forcarQr;
  const extraLimpo = { ...extra, parear };
  delete extraLimpo.forcar_qr;
  let status = null;
  let ultimoErro = null;

  const esperarQr = async (tentativas) => {
    for (let i = 0; i < tentativas; i++) {
      await sleep(i === 0 ? 600 : 1100);
      try {
        status = await statusComQr(token, extraLimpo);
        ultimoErro = status.qr_erro || null;
        if (status.loggedIn && !parear) return status;
        if (status.qrcode) return status;
        if (ehErroInfraWuzapi(status.qr_erro)) {
          await sleep(1200);
        }
      } catch (err) {
        ultimoErro = err.message;
        if (ehErroInfraWuzapi(err.message) || err.infraWuzapi) {
          await sleep(1200);
        }
      }
    }
    return status;
  };

  if (!parear) {
    try {
      status = await statusSessao(token, extraLimpo);
      if (status.loggedIn) return { ...status, qrcode: '' };
    } catch (err) {
      if (ehErroInfraWuzapi(err.message) || err.infraWuzapi) {
        return {
          ...normalizarStatus({}, extraLimpo),
          qrcode: '',
          infra_wuzapi: true,
          qr_erro: mensagemInfraWuzapi(err),
        };
      }
      const extraSessao = await telefoneDaSessaoWuzapi(token);
      if (extraSessao.loggedIn || extraSessao.phone) {
        return statusAPartirDoAdmin(extraSessao, extraLimpo);
      }
    }
    try {
      await conectarSessaoComRetry(token, 4);
    } catch (err) {
      if (ehErroInfraWuzapi(err.message) || err.infraWuzapi) {
        return {
          ...normalizarStatus({}, extraLimpo),
          qrcode: '',
          infra_wuzapi: true,
          qr_erro: mensagemInfraWuzapi(err),
        };
      }
      throw err;
    }
    status = await esperarQr(12);
    if (status?.qrcode) return status;
    if (status?.loggedIn) return status;
  }

  if (parear) {
    iniciarBuscaQrFundo(token, extra.filial_id);
    try {
      const qr = qrDoCache(token) || await esperarQrCache(token, 18_000);
      if (qr) {
        return {
          ...normalizarStatus({}, extraLimpo),
          connected: true,
          loggedIn: false,
          qrcode: qr,
          infra_wuzapi: false,
          qr_erro: null,
        };
      }
    } catch (err) {
      if (err.upstreamStatus === 401 || err.upstreamStatus === 403) throw err;
      ultimoErro = err.message;
    }
    return {
      ...normalizarStatus({}, extraLimpo),
      qrcode: '',
      connected: true,
      loggedIn: false,
      infra_wuzapi: false,
      qr_erro: null,
      mensagem: 'Gerando QR… a tela continua tentando sozinha.',
    };
  }

  const extraSessao = await telefoneDaSessaoWuzapi(token);
  if (!parear && (extraSessao.loggedIn || extraSessao.phone)) {
    return statusAPartirDoAdmin(extraSessao, extraLimpo);
  }

  return {
    ...(status || normalizarStatus({}, extraLimpo)),
    qrcode: '',
    connected: Boolean(status?.connected),
    loggedIn: false,
    infra_wuzapi: false,
    qr_erro: mensagemInfraWuzapi(ultimoErro || status?.qr_erro, { parear: true }),
  };
}

function webhookUrlParaFilial(filialId) {
  const base = config.wuzapiWebhookPublicUrl || `http://host.docker.internal:${config.port}/api/webhook/whatsapp`;
  return filialId ? `${base}?filial_id=${filialId}` : base;
}

async function garantirWebhook(token, filialId = null) {
  const webhookUrl = webhookUrlParaFilial(filialId);
  try {
    await wuzapiFetch('/webhook', {
      method: 'PUT',
      token,
      body: {
        webhook: webhookUrl,
        events: ['Message'],
        Active: true,
      },
    });
    return webhookUrl;
  } catch (err) {
    console.warn('[whatsapp] Falha ao configurar webhook:', err.message);
    return null;
  }
}

function limparCampoTexto(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
}

async function sessaoPertenceAFilial(filial, status) {
  const chipFilial = String(filial?.whatsapp || '').replace(/\D/g, '');
  if (chipFilial.length < 10) return false;
  if (!status?.loggedIn && !status?.phone) return false;
  if (!status.phone) return Boolean(status.loggedIn);
  const ehChipDesta = chipsWhatsappIguais(filial.whatsapp, status.phone);
  if (ehChipDesta) return true;
  const outro = await chipUsadoPorOutraFilial(filial.id, status.phone);
  if (outro) return false;
  return Boolean(status.loggedIn);
}

function jidsGrupoIguais(a, b) {
  const da = String(a || '').trim();
  const db = String(b || '').trim();
  if (!da && !db) return true;
  if (!da || !db) return false;
  if (da === db) return true;
  const na = normalizarDestino(da);
  const nb = normalizarDestino(db);
  if (na?.isGroup && nb?.isGroup && na.logKey === nb.logKey) return true;
  const xa = da.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  const xb = db.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  return Boolean(xa && xb && xa === xb);
}

/** Trocar ou limpar o grupo já salvo exige `trocar_grupo: true` no painel. */
function grupoMedicaoRequerDestrava(atual, novo) {
  const a = limparCampoTexto(atual);
  const n = limparCampoTexto(novo);
  if (!a) return false;
  return !jidsGrupoIguais(a, n);
}

async function filialOuErro(id) {
  const db = getDb();
  const f = await db.prepare(`
    SELECT id, nome, codigo, whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token, ativo
    FROM filiais WHERE id = ?
  `).get(id);
  if (!f) {
    const err = new Error('Filial não encontrada');
    err.status = 404;
    throw err;
  }
  return f;
}

/** Lista chatbots cadastrados por filial (escopo do usuário) */
router.get('/filiais-chatbot', requireGerenteOuAdmin, async (_req, res, next) => {
  try {
    const db = getDb();
    const escopo = filiaisEscopoIds(_req);
    let sql = `
      SELECT id, nome, codigo, whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token, ativo
      FROM filiais
      WHERE ativo = 1
    `;
    const params = [];
    if (escopo?.length) {
      sql += ` AND id IN (${escopo.map(() => '?').join(',')})`;
      params.push(...escopo);
    }
    sql += ' ORDER BY LOWER(nome)';
    const rows = await db.prepare(sql).all(...params);

    res.json({
      wuzapi_url: config.wuzapiBaseUrl,
      filiais: rows.map((f) => ({
        id: f.id,
        nome: f.nome,
        codigo: f.codigo,
        whatsapp: limparCampoTexto(f.whatsapp),
        whatsapp_grupo: limparCampoTexto(f.whatsapp_grupo),
        whatsapp_alerta: limparCampoTexto(f.whatsapp_alerta),
        tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
        chatbot_ok: Boolean(limparCampoTexto(f.whatsapp) || limparCampoTexto(f.whatsapp_grupo)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Salva número/grupo/alerta/token do chatbot da filial */
router.put('/filiais-chatbot/:id', requireChatbotAcesso, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!assertFilialNoEscopo(req, id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  const { whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token, trocar_grupo } = req.body || {};

  try {
    const f = await filialOuErro(id);
    if (whatsapp_grupo !== undefined && grupoMedicaoRequerDestrava(f.whatsapp_grupo, whatsapp_grupo)) {
      if (trocar_grupo !== true) {
        return res.status(409).json({
          erro: 'Grupo da medição está travado. Clique em “Escolher outro grupo” no painel do chatbot.',
        });
      }
    }
    const db = getDb();
    const podeToken = isAdmin(req.user) || req.user.papel === 'gerente';

    let alertaSalvo = f.whatsapp_alerta;
    if (whatsapp_alerta !== undefined) {
      const lista = Array.isArray(whatsapp_alerta)
        ? whatsapp_alerta
        : String(whatsapp_alerta || '').split(/[,;\n]+/);
      const limpos = [...new Set(
        lista
          .map((v) => limparCampoTexto(v))
          .filter(Boolean)
          .map((v) => (/@g\.us/i.test(v) ? v : v.replace(/\D/g, '')))
          .filter((v) => v && (v.includes('@') || v.length >= 10))
      )];
      alertaSalvo = limpos.length ? limpos.join(',') : null;
    }

    await db.prepare(`
      UPDATE filiais SET
        whatsapp = ?,
        whatsapp_grupo = ?,
        whatsapp_alerta = ?,
        wuzapi_token = ?,
        updated_at = NOW()
      WHERE id = ?
    `).run(
      whatsapp !== undefined
        ? (pareceNumeroCelular(limparCampoTexto(whatsapp)?.replace(/\D/g, '') || '')
          ? String(whatsapp).replace(/\D/g, '')
          : null)
        : f.whatsapp,
      whatsapp_grupo !== undefined ? limparCampoTexto(whatsapp_grupo) : f.whatsapp_grupo,
      alertaSalvo,
      (podeToken && wuzapi_token !== undefined)
        ? limparCampoTexto(wuzapi_token)
        : f.wuzapi_token,
      id
    );

    res.json({ mensagem: `Chatbot de ${f.nome} atualizado` });

    // Reaplica webhook em background (não atrasa a resposta)
    Promise.resolve()
      .then(() => tokenWuzapiFilial(id, { permitirEnv: false }))
      .then((token) => (token ? garantirWebhook(token, id) : null))
      .catch((err) => {
        console.warn('[whatsapp] webhook após salvar chatbot:', err.message);
      });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Reaplica a URL do webhook no WuzAPI (placa → link) */
router.post('/filial/:id/reconnect-webhook', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const token = await tokenWuzapiFilial(f.id, { permitirEnv: false });
    if (!token) {
      return res.status(400).json({ erro: 'Cadastre/conecte o token WuzAPI desta filial antes' });
    }
    const webhook = await garantirWebhook(token, f.id);
    if (!webhook) {
      return res.status(502).json({ erro: 'Não foi possível configurar o webhook no WuzAPI' });
    }
    res.json({
      mensagem: 'Webhook reaplicado',
      webhook,
      grupo: limparCampoTexto(f.whatsapp_grupo),
    });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

/** Dados do chatbot da filial (gerente/admin no escopo) */
router.get('/filial/:id/config', requireChatbotAcesso, async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    let f = await filialOuErro(req.params.id);
    res.json({
      id: f.id,
      nome: f.nome,
      codigo: f.codigo,
      whatsapp: limparCampoTexto(f.whatsapp),
      whatsapp_grupo: limparCampoTexto(f.whatsapp_grupo),
      whatsapp_alerta: limparCampoTexto(f.whatsapp_alerta),
      tem_wuzapi_token: Boolean(tokenWuzapiUtil(f.wuzapi_token)),
      admin_token_ok: Boolean(tokenWuzapiUtil(config.wuzapiAdminToken)),
      wuzapi_url: config.wuzapiBaseUrl,
      alertas_enabled: Boolean(config.whatsappAlertasEnabled),
      token_recem_criado: false,
      precisa_conectar: !limparCampoTexto(f.whatsapp),
      aviso_token: null,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Cria (ou regenera) usuário WuzAPI exclusivo desta filial.
 */
router.post('/filial/:id/provisionar-token', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const forcarNovo = Boolean(req.body?.forcar_novo);
    const result = await garantirTokenExclusivoFilial(f, { forcarNovo });
    res.json({
      mensagem: result.mensagem
        || (result.precisa_conectar
          ? `Sessão de ${f.nome} pronta. Clique em Conectar chip.`
          : `Sessão da unidade ${f.nome} ok.`),
      nome_wuzapi: result.nome_wuzapi,
      tem_wuzapi_token: true,
      criado: result.criado,
      regenerado: result.regenerado,
      origem: result.regenerado ? 'regenerado' : (result.criado ? 'criado' : 'ok'),
      precisa_conectar: result.precisa_conectar,
    });
  } catch (err) {
    const code = err.status === 401 || err.status === 403 ? 502 : (err.status || 500);
    res.status(code).json({ erro: err.message });
  }
});

/** Lista grupos WhatsApp do chip conectado (para selecionar no chatbot) */
router.get('/filial/:id/grupos', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    let token = await tokenWuzapiFilial(f.id, { permitirEnv: false });
    if (!token) {
      const viva = await reconectarSessaoVivaFilial(f);
      token = viva?.token || '';
    }
    if (!token) {
      return res.status(400).json({
        erro: 'Cadastre o token e conecte o chatbot desta unidade antes de listar grupos',
        grupos: [],
      });
    }
    let data;
    try {
      data = await wuzapiFetch('/group/list', { token, timeoutMs: 10_000 });
    } catch (err) {
      if (err.upstreamStatus === 401 || err.upstreamStatus === 403) {
        const viva = await reconectarSessaoVivaFilial(f);
        if (viva?.token) {
          data = await wuzapiFetch('/group/list', { token: viva.token, timeoutMs: 10_000 });
        } else {
          return res.json({
            grupos: [],
            selecionado: limparCampoTexto(f.whatsapp_grupo),
            precisa_qr: true,
            erro: 'Sessão do WhatsApp não está ativa. Clique em Desconectar sessão e gere o QR de novo.',
          });
        }
      } else {
        return res.json({
          grupos: [],
          selecionado: limparCampoTexto(f.whatsapp_grupo),
          precisa_qr: true,
          erro: err.message || 'Não foi possível listar os grupos. A sessão do WhatsApp não está no ar.',
        });
      }
    }
    const raw = data?.data?.Groups || data?.data?.groups || data?.Groups || data?.groups || [];
    const grupos = (Array.isArray(raw) ? raw : []).map((g) => ({
      jid: g.JID || g.jid || g.Id || g.id || '',
      nome: g.Name || g.name || g.Subject || g.subject || '(sem nome)',
    })).filter((g) => g.jid);

    res.json({
      grupos,
      selecionado: limparCampoTexto(f.whatsapp_grupo),
    });
  } catch (err) {
    res.json({
      grupos: [],
      precisa_qr: true,
      erro: err.message || 'Não foi possível listar os grupos. Desconecte a sessão e gere o QR de novo.',
    });
  }
});

/**
 * Opções para checklist de alertas: grupos WhatsApp + usuários com WhatsApp.
 */
router.get('/filial/:id/alerta-opcoes', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const db = getDb();
    const selecionados = String(f.whatsapp_alerta || '')
      .split(/[,;\n]+/)
      .map((s) => limparCampoTexto(s))
      .filter(Boolean);

    const opcoes = [];

    // Usuários do sistema com WhatsApp (unidade + gerentes/compras)
    const usuarios = await db.prepare(`
      SELECT id, login, papel, cargo, whatsapp
      FROM usuarios
      WHERE ativo = 1
        AND whatsapp IS NOT NULL AND TRIM(whatsapp) != ''
        AND (
          filial_id = ?
          OR papel = 'admin'
          OR cargo IN ('gerente_compras', 'gerente_filial')
          OR (papel = 'gerente' AND (filial_id IS NULL OR filial_id = ?))
        )
      ORDER BY LOWER(login)
      LIMIT 80
    `).all(f.id, f.id);

    for (const u of usuarios) {
      const phone = String(u.whatsapp || '').replace(/\D/g, '');
      if (phone.length < 10) continue;
      const cargo = u.cargo || u.papel || 'usuario';
      opcoes.push({
        id: `user:${u.id}`,
        valor: phone,
        nome: u.login,
        tipo: 'usuario',
        detalhe: cargo,
      });
    }

    // Grupos do chip (mesma fonte do passo 2)
    try {
      const token = await tokenWuzapiFilial(f.id, { permitirEnv: false });
      if (token) {
        const data = await wuzapiFetch('/group/list', { token });
        const raw = data?.data?.Groups || data?.data?.groups || data?.Groups || data?.groups || [];
        for (const g of (Array.isArray(raw) ? raw : [])) {
          const jid = limparCampoTexto(g.JID || g.jid || g.Id || g.id);
          if (!jid) continue;
          opcoes.push({
            id: `grupo:${jid}`,
            valor: jid,
            nome: limparCampoTexto(g.Name || g.name || g.Subject || g.subject) || jid,
            tipo: 'grupo',
            detalhe: 'grupo WhatsApp',
          });
        }
      }
    } catch (err) {
      console.warn('[whatsapp] alerta-opcoes grupos:', err.message);
    }

    // Mantém selecionados que não estão mais na lista
    for (const sel of selecionados) {
      if (!opcoes.some((o) => o.valor === sel)) {
        opcoes.push({
          id: `salvo:${sel}`,
          valor: sel,
          nome: sel.includes('@g.us') ? 'Grupo salvo' : 'Número salvo',
          tipo: sel.includes('@g.us') ? 'grupo' : 'numero',
          detalhe: 'cadastrado',
        });
      }
    }

    res.json({ opcoes, selecionados });
  } catch (err) {
    res.status(err.status || 500).json({
      erro: err.message,
      opcoes: [],
      selecionados: [],
    });
  }
});

router.get('/filial/:id/status', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const chipFilial = String(f.whatsapp || '').replace(/\D/g, '');
    const pareando = chipFilial.length < 10;
    const querQr = String(req.query.qr || '') === '1';
    const viva = pareando ? null : await reconectarSessaoVivaFilial(f);
    let token = viva?.token || await tokenWuzapiFilial(f.id, { permitirEnv: false });
    const extra = {
      filial_id: f.id,
      nome: f.nome,
      whatsapp: f.whatsapp,
      chip_salvo: limparCampoTexto(f.whatsapp) || '',
      grupo_salvo: limparCampoTexto(f.whatsapp_grupo),
      tem_wuzapi_token: Boolean(tokenWuzapiUtil(f.wuzapi_token) || viva?.token),
      token: Boolean(token),
    };
    if (viva?.loggedIn) {
      const outro = viva.phone ? await chipUsadoPorOutraFilial(f.id, viva.phone) : null;
      if (!pareando && (!outro || chipsWhatsappIguais(f.whatsapp, viva.phone))) {
        return res.json(comEstado({
          configurado: true,
          loggedIn: true,
          connected: true,
          phone: viva.phone,
          name: viva.name,
          jid: viva.jid,
          qrcode: '',
          ...extra,
        }));
      }
    }
    if (pareando && token) {
      if (querQr) {
        const cached = qrDoCache(token);
        if (cached) {
          return res.json(comEstado({
            configurado: true,
            loggedIn: false,
            connected: true,
            qrcode: cached,
            ...extra,
            chip_salvo: '',
          }));
        }
        let wuzErro = null;
        let wuzConnected = false;
        try {
          const n = normalizarStatus(await wuzapiFetch('/session/status', { token, timeoutMs: 5_000 }));
          wuzConnected = Boolean(n.connected);
          if (n.qrcode) {
            guardarQr(token, n.qrcode);
            return res.json(comEstado({
              configurado: true,
              loggedIn: false,
              connected: true,
              qrcode: n.qrcode,
              ...extra,
              chip_salvo: '',
            }));
          }
          if (n.loggedIn) {
            pareamentoAtivo.delete(Number(f.id));
            return res.json(comEstado({
              configurado: true,
              loggedIn: true,
              connected: true,
              phone: n.phone || '',
              name: n.name || '',
              jid: n.jid || '',
              qrcode: '',
              ...extra,
            }));
          }
        } catch (err) {
          wuzErro = err.message;
          console.warn('[whatsapp] QR parear status:', err.message);
        }
        try {
          const qr = await buscarQr(token, 5_000);
          if (qr) {
            guardarQr(token, qr);
            return res.json(comEstado({
              configurado: true,
              loggedIn: false,
              connected: true,
              qrcode: qr,
              ...extra,
              chip_salvo: '',
            }));
          }
        } catch (err) {
          wuzErro = wuzErro || err.message;
          console.warn('[whatsapp] QR parear:', err.message);
        }
        return res.json(comEstado({
          configurado: true,
          loggedIn: false,
          connected: wuzConnected,
          qrcode: qrDoCache(token) || '',
          ...extra,
          chip_salvo: '',
          qr_erro: null,
          mensagem: wuzConnected
            ? 'Sessão ligada. Escaneie o QR quando aparecer — não clique de novo.'
            : 'Gerando QR… espere, sem clicar de novo.',
        }));
      }
      return res.json(comEstado({
        configurado: true,
        loggedIn: false,
        connected: Boolean(qrDoCache(token)),
        qrcode: qrDoCache(token) || '',
        ...extra,
        chip_salvo: '',
        mensagem: 'Clique em Gerar QR uma vez e aguarde o código.',
      }));
    }
    if (token && await tokenUsadoPorOutraFilial(f.id, token)) {
      try {
        const status = await statusSessao(token, extra);
        if (await sessaoPertenceAFilial(f, status)) {
          return res.json(comEstado({
            configurado: true,
            ...status,
            ...extra,
            qrcode: '',
            loggedIn: true,
            connected: true,
          }));
        }
      } catch {
        // segue: token compartilhado sem sessão desta unidade
      }
      return res.json(comEstado({
        ...extra,
        configurado: true,
        connected: false,
        loggedIn: false,
        phone: '',
        token_compartilhado: true,
        sessao_alheia: true,
        mensagem: 'Esta unidade estava na sessão de outra filial. Clique em Conectar chip e escaneie o QR do chip DESTA unidade.',
      }));
    }
    if (!wuzapiConfigurado(token)) {
      return res.json(comEstado({
        ...extra,
        configurado: false,
        connected: false,
        loggedIn: false,
        mensagem: 'Clique em Conectar chip — o sistema prepara a sessão desta unidade sozinho.',
      }));
    }
    try {
      const status = querQr
        ? await statusComQr(token, extra)
        : await statusSessao(token, extra);
      if (status.loggedIn && status.phone) {
        const outro = await chipUsadoPorOutraFilial(f.id, status.phone);
        if (outro && !chipsWhatsappIguais(f.whatsapp, status.phone)) {
          return res.json(comEstado({
            ...extra,
            configurado: true,
            connected: false,
            loggedIn: false,
            phone: '',
            qrcode: '',
            sessao_alheia: true,
            mensagem: `Esse chip pertence a ${outro.nome}. Clique em Conectar chip e escaneie o QR DESTA unidade.`,
          }));
        }
      }
      const infra = Boolean(status.infra_wuzapi) || ehErroInfraWuzapi(status.qr_erro);
      const chipSalvo = String(extra.chip_salvo || '').replace(/\D/g, '');
      if (infra && !status.loggedIn && chipSalvo.length >= 10) {
        return res.json(respostaChipCadastrado(extra, { phone: status.phone || chipSalvo }));
      }
      res.json(comEstado({
        configurado: true,
        ...status,
        ...extra,
        qrcode: querQr && !infra ? status.qrcode : '',
        instavel: Boolean(status.instavel || infra),
        infra_wuzapi: infra && !status.loggedIn,
        mensagem: infra && !status.loggedIn ? mensagemInfraWuzapi(status.qr_erro) : status.mensagem,
        connected: status.loggedIn ? true : status.connected,
        loggedIn: Boolean(status.loggedIn),
      }));
    } catch (err) {
      try {
        if (!(err.infraWuzapi || ehErroInfraWuzapi(err.message))) {
          const extraSessao = await telefoneDaSessaoWuzapi(token);
          if (extraSessao.loggedIn || extraSessao.phone) {
            const status = statusAPartirDoAdmin(extraSessao, extra);
            if (status.phone) {
              const outro = await chipUsadoPorOutraFilial(f.id, status.phone);
              if (outro && !chipsWhatsappIguais(f.whatsapp, status.phone)) {
                return res.json(comEstado({
                  ...extra,
                  configurado: true,
                  connected: false,
                  loggedIn: false,
                  phone: '',
                  qrcode: '',
                  sessao_alheia: true,
                  mensagem: `Esse chip pertence a ${outro.nome}. Clique em Conectar chip e escaneie o QR DESTA unidade.`,
                }));
              }
            }
            return res.json(comEstado({
              configurado: true,
              ...status,
              ...extra,
              qrcode: '',
              loggedIn: true,
              connected: true,
            }));
          }
        }
      } catch {
        // mantém instavel abaixo
      }
      const infra = err.infraWuzapi || ehErroInfraWuzapi(err.message);
      const chipSalvo = String(extra.chip_salvo || '').replace(/\D/g, '');
      if (chipSalvo.length >= 10) {
        return res.json(respostaChipCadastrado(extra));
      }
      res.json(comEstado({
        configurado: true,
        connected: false,
        loggedIn: false,
        instavel: true,
        infra_wuzapi: Boolean(infra),
        mensagem: infra
          ? mensagemInfraWuzapi(err)
          : err.message,
        ...extra,
      }));
    }
  } catch (err) {
    const code = err.status === 401 || err.status === 403 ? 502 : (err.status || 500);
    res.status(code).json({ erro: err.message });
  }
});

router.post('/filial/:id/connect', requireChatbotAcesso, async (req, res) => {
  let parear = Boolean(req.body?.forcar_qr);
  let status = null;
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    let f = await filialOuErro(req.params.id);
    const forcarQrBody = Boolean(req.body?.forcar_qr);
    const chipFilial = String(f.whatsapp || '').replace(/\D/g, '');
    parear = chipFilial.length < 10 || forcarQrBody;
    const extraFilial = { filial_id: f.id, nome: f.nome };
    if (parear) pareamentoAtivo.set(Number(f.id), Date.now());

    const viva = parear ? null : await reconectarSessaoVivaFilial(f);
    if (viva?.loggedIn && !parear) {
      const outro = viva.phone ? await chipUsadoPorOutraFilial(f.id, viva.phone) : null;
      if (!outro || chipsWhatsappIguais(f.whatsapp, viva.phone)) {
        const webhook = await garantirWebhook(viva.token, f.id);
        return res.json(comEstado({
          mensagem: `Chatbot “${f.nome}” já está conectado`,
          webhook,
          configurado: true,
          loggedIn: true,
          connected: true,
          phone: viva.phone,
          name: viva.name,
          jid: viva.jid,
          qrcode: '',
          tem_qr: false,
          sessao_desta_filial: true,
        }));
      }
    }

    let token = viva?.token || await tokenWuzapiFilial(f.id, { permitirEnv: false });

    // Chip já pareado nesta sessão → NÃO gera token novo nem outro QR
    if (token && !parear) {
      try {
        const ja = await statusSessao(token, extraFilial);
        if (await sessaoPertenceAFilial(f, ja)) {
          const webhook = await garantirWebhook(token, f.id);
          return res.json(comEstado({
            mensagem: `Chatbot “${f.nome}” já está conectado`,
            webhook,
            ...ja,
            qrcode: '',
            tem_qr: false,
            sessao_desta_filial: true,
          }));
        }
      } catch (errJa) {
        if (errJa.infraWuzapi || ehErroInfraWuzapi(errJa.message)) {
          return res.json(comEstado({
            mensagem: mensagemInfraWuzapi(errJa),
            qrcode: '',
            tem_qr: false,
            infra_wuzapi: true,
            qr_erro: mensagemInfraWuzapi(errJa),
            loggedIn: false,
            connected: false,
          }));
        }
        const extraSessao = await telefoneDaSessaoWuzapi(token);
        if (extraSessao.loggedIn || extraSessao.phone) {
          const ja = statusAPartirDoAdmin(extraSessao, extraFilial);
          if (await sessaoPertenceAFilial(f, ja)) {
            const webhook = await garantirWebhook(token, f.id);
            return res.json(comEstado({
              mensagem: `Chatbot “${f.nome}” já está conectado`,
              webhook,
              ...ja,
              qrcode: '',
              tem_qr: false,
              sessao_desta_filial: true,
            }));
          }
        }
      }
    }

    // Token compartilhado: só gera sessão nova se o chip no ar NÃO for desta unidade.
    // Filial já pareada (mesmo token repetido no cadastro) NÃO é rotacionada.
    try {
      if (token && await tokenUsadoPorOutraFilial(f.id, token)) {
        const extraSessao = await telefoneDaSessaoWuzapi(token);
        const sessaoDestaUnidade = Boolean(
          extraSessao.phone
          && (
            chipsWhatsappIguais(f.whatsapp, extraSessao.phone)
            || !(await chipUsadoPorOutraFilial(f.id, extraSessao.phone))
          )
        );
        if (parear || !sessaoDestaUnidade) {
          await garantirTokenExclusivoFilial(f);
          f = await filialOuErro(req.params.id);
          token = await tokenWuzapiFilial(f.id, { permitirEnv: false });
        }
      }

      if (!token) {
        const garantia = await garantirTokenExclusivoFilial(f);
        f = await filialOuErro(req.params.id);
        token = garantia.token || await tokenWuzapiFilial(f.id, { permitirEnv: false });
      }
    } catch (errProv) {
      const infra = errProv.infraWuzapi
        || /banco interno|database error|problem accessing DB|lookup db|server misbehaving/i.test(errProv.message || '');
      if (infra) {
        if (token) {
          console.warn('[whatsapp] WuzAPI oscilou ao provisionar; seguindo com o token da unidade');
        } else {
          return res.json(comEstado({
            mensagem: mensagemInfraWuzapi(errProv, { parear }),
            qrcode: '',
            tem_qr: false,
            infra_wuzapi: !parear,
            qr_erro: mensagemInfraWuzapi(errProv, { parear }),
            loggedIn: false,
            connected: false,
          }));
        }
      } else {
        throw errProv;
      }
    }

    if (!token) {
      return res.status(400).json({
        erro: 'Clique em Conectar chip de novo — o sistema prepara a sessão desta unidade sozinho.',
      });
    }

    if (parear) {
      const reparo = await garantirTokenExclusivoFilial(f);
      f = await filialOuErro(req.params.id);
      token = reparo.token || await tokenWuzapiFilial(f.id, { permitirEnv: false });
      iniciarBuscaQrFundo(token, f.id);
    }

    try {
      status = await conectarEObterQr(token, {
        filial_id: f.id,
        nome: f.nome,
        forcar_qr: parear,
        parear,
      });
    } catch (err) {
      if (err.infraWuzapi || ehErroInfraWuzapi(err.message)) {
        return res.json(comEstado({
          mensagem: mensagemInfraWuzapi(err, { parear }),
          qrcode: '',
          tem_qr: false,
          infra_wuzapi: !parear,
          qr_erro: mensagemInfraWuzapi(err, { parear }),
          loggedIn: false,
          connected: false,
        }));
      }
      // Só gera token novo se o usuário WuzAPI desta unidade realmente não existir.
      // 401 com chip já pareado NÃO pode rotacionar token nem pedir outro QR.
      if (err.upstreamStatus === 401 || err.upstreamStatus === 403 || err.status === 502) {
        const extraSessao = await telefoneDaSessaoWuzapi(token);
        if (!parear && (extraSessao.loggedIn || extraSessao.phone)) {
          status = statusAPartirDoAdmin(extraSessao, extraFilial);
        } else {
          try {
            await wuzapiAdminFetch('/admin/users');
          } catch (adminErr) {
            if (adminErr.infraWuzapi || ehErroInfraWuzapi(adminErr.message) || adminErr.status === 503) {
              return res.json(comEstado({
                mensagem: mensagemInfraWuzapi(adminErr),
                qrcode: '',
                tem_qr: false,
                infra_wuzapi: true,
                qr_erro: mensagemInfraWuzapi(adminErr),
                loggedIn: false,
                connected: false,
              }));
            }
          }
          const chipSalvo = String(f.whatsapp || '').replace(/\D/g, '');
          if (chipSalvo.length >= 10) {
            return res.json(comEstado({
              mensagem: 'Este chip já está cadastrado nesta unidade. O servidor do WhatsApp oscilou — nada foi desconectado. Clique em Atualizar status em instantes.',
              qrcode: '',
              tem_qr: false,
              instavel: true,
              loggedIn: false,
              connected: false,
              chip_salvo: chipSalvo,
            }));
          }
          const reparo = await garantirTokenExclusivoFilial(f);
          f = await filialOuErro(req.params.id);
          token = reparo.token || await tokenWuzapiFilial(f.id, { permitirEnv: false });
          if (!token) throw err;
          status = await conectarEObterQr(token, {
            ...extraFilial,
            parear,
            forcar_qr: parear,
          });
        }
      } else {
        throw err;
      }
    }

    if (status?.infra_wuzapi && !parear) {
      return res.json(comEstado({
        mensagem: status.qr_erro || mensagemInfraWuzapi(status),
        qrcode: '',
        tem_qr: false,
        infra_wuzapi: true,
        qr_erro: status.qr_erro || mensagemInfraWuzapi(status),
        loggedIn: false,
        connected: Boolean(status.connected),
      }));
    }

    const webhook = parear
      ? webhookUrlParaFilial(f.id)
      : await garantirWebhook(token, f.id);
    if (parear) garantirWebhook(token, f.id).catch(() => {});

    if (status?.loggedIn && status.phone) {
      const outro = await chipUsadoPorOutraFilial(f.id, status.phone);
      if (outro && !chipsWhatsappIguais(f.whatsapp, status.phone)) {
        return res.json(comEstado({
          mensagem: `A sessão ainda é do chip de ${outro.nome}. Escaneie o QR com o chip DESTA unidade.`,
          webhook,
          configurado: true,
          connected: Boolean(status.qrcode),
          loggedIn: false,
          phone: '',
          qrcode: status.qrcode || '',
          tem_qr: Boolean(status.qrcode),
          sessao_alheia: true,
          qr_erro: status.qrcode
            ? undefined
            : 'Gere o QR desta unidade — o chip exibido era de outra filial.',
        }));
      }
    }

    let mensagem = `Conexão do chatbot “${f.nome}” iniciada — escaneie o QR`;
    if (status.loggedIn) {
      mensagem = status.mensagem || `Chatbot “${f.nome}” já está conectado`;
    } else if (!status.qrcode) {
      mensagem = status.mensagem
        || 'Gerando QR… pode levar até 30 segundos.';
    }

    invalidarCacheAdminUsers();
    res.json(comEstado({
      mensagem,
      webhook,
      ...status,
      tem_qr: Boolean(status.qrcode),
    }));
  } catch (err) {
    if (err.infraWuzapi || ehErroInfraWuzapi(err.message)) {
      return res.json(comEstado({
        mensagem: mensagemInfraWuzapi(err, { parear }),
        qrcode: '',
        tem_qr: false,
        infra_wuzapi: !parear,
        qr_erro: mensagemInfraWuzapi(err, { parear }),
        loggedIn: false,
        connected: false,
      }));
    }
    res.status(err.status || 500).json({ erro: err.message });
  } finally {
    if (status?.loggedIn && req.params?.id) {
      pareamentoAtivo.delete(Number(req.params.id));
    }
  }
});

router.post('/filial/:id/disconnect', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const token = tokenWuzapiUtil(f.wuzapi_token);
    limparQrFilial(f.id, token);
    let sessionEncerrada = false;
    let aviso = null;

    if (token) {
      try {
        await wuzapiFetch('/session/logout', { method: 'POST', token, timeoutMs: 12_000 });
        sessionEncerrada = true;
      } catch (errLogout) {
        aviso = errLogout.message;
      }
      try {
        await wuzapiFetch('/session/disconnect', { method: 'POST', token, timeoutMs: 8_000 });
        sessionEncerrada = true;
      } catch {
        // logout já encerrou ou a sessão já estava morta
      }
    } else {
      aviso = 'Sem token próprio — limpou só número, grupo e alertas.';
    }

    const db = getDb();
    await db.prepare(`
      UPDATE filiais SET
        whatsapp = NULL,
        whatsapp_grupo = NULL,
        whatsapp_alerta = NULL,
        updated_at = NOW()
      WHERE id = ?
    `).run(f.id);

    invalidarCacheAdminUsers();
    res.json({
      mensagem: `Sessão de ${f.nome} encerrada no WhatsApp. Número e grupo apagados. Escaneie o QR com o chip desta unidade.`,
      session_desconectada: sessionEncerrada,
      aviso,
      limpos: ['whatsapp', 'whatsapp_grupo', 'whatsapp_alerta'],
      precisa_qr: true,
    });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/filial/:id/logout', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const token = tokenWuzapiUtil(f.wuzapi_token);
    if (!token) {
      return res.status(400).json({
        erro: 'Esta filial não tem token próprio. Cadastre/gere o token antes do logout.',
      });
    }
    await wuzapiFetch('/session/logout', { method: 'POST', token });
    invalidarCacheAdminUsers();
    res.json({ mensagem: `Logout do chatbot de ${f.nome} — escaneie o QR de novo` });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

/**
 * Resumo de envios WhatsApp da filial: pendentes (erro), enviados e logs.
 */
router.get('/filial/:id/envios', requireChatbotAcesso, async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  const filialId = Number(req.params.id);
  try {
    const f = await filialOuErro(filialId);
    const grupoSelecionado = limparCampoTexto(f.whatsapp_grupo);
    const db = getDb();
    const limit = Math.min(Number(req.query.limit) || 80, 150);

    if (!grupoSelecionado) {
      return res.json({
        alertas_enabled: Boolean(config.whatsappAlertasEnabled),
        grupo: null,
        resumo: { pendentes: 0, enviados: 0, alertas: 0, chatbot: 0, total: 0 },
        pendentes: [],
        enviados: [],
        logs: [],
        mensagem: 'Selecione o grupo da medição para ver os envios desse grupo.',
      });
    }

    const grupoKey = normalizarDestino(grupoSelecionado)?.logKey || grupoSelecionado;
    const rows = await db.prepare(`
    SELECT
      n.id,
      n.tipo,
      n.destinatario_whatsapp,
      n.veiculo_id,
      n.medicao_id,
      n.mensagem,
      n.status,
      n.resposta_api,
      n.criado_em,
      n.filial_id,
      v.placa,
      v.apelido
    FROM notificacoes_whatsapp n
    LEFT JOIN veiculos v ON v.id = n.veiculo_id
    WHERE n.filial_id = ?
       OR (n.filial_id IS NULL AND v.filial_id = ?)
    ORDER BY n.id DESC
    LIMIT ?
  `).all(filialId, filialId, limit);

    const destDoGrupo = (dest) => {
      const n = normalizarDestino(dest);
      if (n?.isGroup && n.logKey === grupoKey) return true;
      const a = String(dest || '').replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
      const b = String(grupoSelecionado).replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
      return Boolean(a && b && a === b);
    };

    const ehRuido = (n) => {
      const msg = String(n.mensagem || '');
      if (/muitas consultas/i.test(msg)) return true;
      if (/n[aã]o encontrada/i.test(msg)) return true;
      if (/frota cadastrada|frota completa/i.test(msg) && !/abrir medi/i.test(msg)) return true;
      if (/gerando o \*relat/i.test(msg)) return true;
      if (/comandos:\s*frota/i.test(msg)) return true;
      return false;
    };

    const filtradas = rows.filter((n) => destDoGrupo(n.destinatario_whatsapp) && !ehRuido(n));

    const classificarEnvio = (n) => {
      const msg = String(n.mensagem || '');
      if (n.tipo === 'alerta_critico' || n.tipo === 'alerta_desgaste') {
        return {
          categoria: 'alerta',
          tipo_label: n.tipo === 'alerta_critico' ? 'Alerta crítico' : 'Alerta monitorar',
        };
      }
      if (n.tipo === 'menu' || /PneuSistemma — Menu/i.test(msg)) {
        return { categoria: 'chatbot', tipo_label: 'Chatbot (menu)' };
      }
      if (n.tipo === 'relatorio_semanal' || /relat[oó]rio gerencial/i.test(msg)) {
        return { categoria: 'chatbot', tipo_label: 'Chatbot (relatório)' };
      }
      if (/muitas consultas/i.test(msg)) {
        return { categoria: 'chatbot', tipo_label: 'Chatbot (aguarde)' };
      }
      if (/\bcomandos:\b/i.test(msg) || /^(frota|placas)\b/i.test(msg)) {
        return { categoria: 'chatbot', tipo_label: 'Chatbot (frota)' };
      }
      return { categoria: 'chatbot', tipo_label: 'Chatbot (link)' };
    };

    const mapRow = (n) => {
      let erro = null;
      try {
        const r = n.resposta_api ? JSON.parse(n.resposta_api) : null;
        erro = r?.erro || r?.error || null;
      } catch { /* ignore */ }
      const { categoria, tipo_label } = classificarEnvio(n);
      const ehAlerta = categoria === 'alerta';
      return {
        id: n.id,
        tipo: n.tipo,
        categoria,
        eh_alerta: ehAlerta,
        tipo_label,
        pode_reenviar: !ehAlerta || config.whatsappAlertasEnabled,
        destinatario: n.destinatario_whatsapp,
        placa: n.placa || null,
        apelido: n.apelido || null,
        status: n.status,
        status_label: n.status === 'enviado' || n.status === 'entregue'
          ? 'Enviado'
          : (n.status === 'erro' ? 'Pendente / falha' : n.status),
        erro,
        mensagem: n.mensagem,
        criado_em: n.criado_em instanceof Date ? n.criado_em.toISOString() : n.criado_em,
        preview: String(n.mensagem || '').replace(/\s+/g, ' ').slice(0, 120),
      };
    };

    const mapped = filtradas.map(mapRow);
    const pendentes = mapped.filter((r) => r.status === 'erro');
    const enviados = mapped.filter((r) => r.status === 'enviado' || r.status === 'entregue');

    res.json({
      alertas_enabled: Boolean(config.whatsappAlertasEnabled),
      grupo: grupoSelecionado,
      resumo: {
        pendentes: pendentes.length,
        enviados: enviados.length,
        alertas: mapped.filter((r) => r.eh_alerta).length,
        chatbot: mapped.filter((r) => !r.eh_alerta).length,
        total: mapped.length,
      },
      pendentes,
      enviados: enviados.slice(0, 15),
      logs: mapped,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Limpa logs de pendentes/falha da filial */
router.delete('/filial/:id/envios/pendentes', requireChatbotAcesso, async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  const filialId = Number(req.params.id);
  try {
    await filialOuErro(filialId);
    const db = getDb();
    const r = await db.prepare(`
      DELETE FROM notificacoes_whatsapp
      WHERE status = 'erro'
        AND (
          filial_id = ?
          OR (
            filial_id IS NULL AND veiculo_id IN (
              SELECT id FROM veiculos WHERE filial_id = ?
            )
          )
          OR (
            filial_id IS NULL AND veiculo_id IS NULL AND destinatario_whatsapp IN (
              SELECT TRIM(whatsapp_grupo) FROM filiais WHERE id = ? AND whatsapp_grupo IS NOT NULL
              UNION
              SELECT TRIM(whatsapp) FROM filiais WHERE id = ? AND whatsapp IS NOT NULL
              UNION
              SELECT TRIM(whatsapp_alerta) FROM filiais WHERE id = ? AND whatsapp_alerta IS NOT NULL
            )
          )
        )
    `).run(filialId, filialId, filialId, filialId, filialId);

    res.json({
      mensagem: 'Pendentes / falhas limpos',
      removidos: r.changes || 0,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Reenvia uma notificação que falhou */
router.post('/filial/:id/envios/:notifId/reenviar', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const filialId = Number(req.params.id);
    const notifId = Number(req.params.notifId);
    const db = getDb();
    const n = await db.prepare('SELECT * FROM notificacoes_whatsapp WHERE id = ?').get(notifId);
    if (!n) return res.status(404).json({ erro: 'Envio não encontrado' });

    if (['alerta_critico', 'alerta_desgaste'].includes(n.tipo) && !config.whatsappAlertasEnabled) {
      return res.status(409).json({
        erro: 'Alertas pós-medição estão pausados. Este envio não pode ser reenviado.',
      });
    }

    const result = await enviarERegistrar({
      tipo: n.tipo,
      destinatario: n.destinatario_whatsapp,
      mensagem: n.mensagem,
      veiculoId: n.veiculo_id,
      medicaoId: n.medicao_id,
      filialId: n.filial_id || filialId,
      linkPreview: false,
    });

    if (!result.ok) {
      return res.status(502).json({ erro: result.erro || 'Falha ao reenviar' });
    }
    // Fecha a pendência original para não ficar listada como falha
    await db.prepare(`
      UPDATE notificacoes_whatsapp
      SET status = 'entregue',
          resposta_api = ?
      WHERE id = ?
    `).run(JSON.stringify({ reenviado: true, via: 'painel' }), notifId);

    res.json({ mensagem: 'Reenviado com sucesso', ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

/** Status da sessão padrão (.env) — só admin */
router.get('/status', requireAdmin, async (_req, res) => {
  try {
    if (!wuzapiConfigurado()) {
      return res.json({
        configurado: false,
        connected: false,
        loggedIn: false,
        mensagem: 'Use o token por filial ou configure WUZAPI_TOKEN no .env',
      });
    }
    const status = await statusComQr(config.wuzapiToken);
    res.json(status);
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message, configurado: wuzapiConfigurado() });
  }
});

router.get('/qr', requireAdmin, async (_req, res) => {
  try {
    const qr = await buscarQr(config.wuzapiToken);
    res.json({ qrcode: qr, tem_qr: Boolean(qr) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/connect', requireAdmin, async (_req, res) => {
  try {
    const status = await conectarEObterQr(config.wuzapiToken);
    const webhook = await garantirWebhook(config.wuzapiToken, null);
    res.json({
      mensagem: status.loggedIn
        ? 'Sessão padrão já está conectada'
        : (status.qrcode ? 'Conexão padrão iniciada — escaneie o QR' : (status.qr_erro || 'QR não gerado')),
      webhook,
      ...status,
      tem_qr: Boolean(status.qrcode),
    });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/disconnect', requireAdmin, async (_req, res) => {
  try {
    await wuzapiFetch('/session/disconnect', { method: 'POST' });
    res.json({ mensagem: 'Desconectado (sessão padrão)' });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/logout', requireAdmin, async (_req, res) => {
  try {
    await wuzapiFetch('/session/logout', { method: 'POST' });
    res.json({ mensagem: 'Logout da sessão padrão' });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

/** Destinatários extras (além do chatbot da filial) */
router.get('/destinatarios', requireAdmin, async (_req, res, next) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT d.*, f.nome AS filial_nome
      FROM alerta_destinatarios d
      LEFT JOIN filiais f ON f.id = d.filial_id
      ORDER BY d.ativo DESC, LOWER(d.nome)
    `).all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/destinatarios', requireAdmin, async (req, res, next) => {
  const { nome, whatsapp, escopo = 'todas', filial_id = null, ativo = 1 } = req.body || {};
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
  const phone = limparTelefone(whatsapp);
  if (!phone || phone.length < 10) {
    return res.status(400).json({ erro: 'WhatsApp inválido (use DDD + número)' });
  }
  if (!['todas', 'filial'].includes(escopo)) {
    return res.status(400).json({ erro: 'Escopo deve ser "todas" ou "filial"' });
  }
  if (escopo === 'filial' && !filial_id) {
    return res.status(400).json({ erro: 'Informe a filial para escopo filial' });
  }

  const db = getDb();
  try {
    const r = await db.prepare(`
      INSERT INTO alerta_destinatarios (nome, whatsapp, ativo, escopo, filial_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      nome.trim(),
      phone,
      ativo ? 1 : 0,
      escopo,
      escopo === 'filial' ? Number(filial_id) : null
    );
    const row = await db.prepare(`
      SELECT d.*, f.nome AS filial_nome
      FROM alerta_destinatarios d
      LEFT JOIN filiais f ON f.id = d.filial_id
      WHERE d.id = ?
    `).get(r.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Este WhatsApp já está cadastrado' });
    }
    next(err);
  }
});

router.put('/destinatarios/:id', requireAdmin, async (req, res, next) => {
  const id = Number(req.params.id);
  const db = getDb();
  try {
    const atual = await db.prepare('SELECT * FROM alerta_destinatarios WHERE id = ?').get(id);
    if (!atual) return res.status(404).json({ erro: 'Destinatário não encontrado' });

    const nome = req.body.nome != null ? String(req.body.nome).trim() : atual.nome;
    const phone = req.body.whatsapp != null
      ? limparTelefone(req.body.whatsapp)
      : atual.whatsapp;
    const escopo = req.body.escopo != null ? req.body.escopo : atual.escopo;
    const ativo = req.body.ativo != null ? (req.body.ativo ? 1 : 0) : atual.ativo;
    let filialId = req.body.filial_id !== undefined ? req.body.filial_id : atual.filial_id;

    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    if (!phone || phone.length < 10) {
      return res.status(400).json({ erro: 'WhatsApp inválido' });
    }
    if (!['todas', 'filial'].includes(escopo)) {
      return res.status(400).json({ erro: 'Escopo inválido' });
    }
    if (escopo === 'filial' && !filialId) {
      return res.status(400).json({ erro: 'Informe a filial' });
    }
    if (escopo === 'todas') filialId = null;

    await db.prepare(`
      UPDATE alerta_destinatarios
      SET nome = ?, whatsapp = ?, ativo = ?, escopo = ?, filial_id = ?,
          updated_at = NOW()
      WHERE id = ?
    `).run(nome, phone, ativo, escopo, filialId, id);

    const row = await db.prepare(`
      SELECT d.*, f.nome AS filial_nome
      FROM alerta_destinatarios d
      LEFT JOIN filiais f ON f.id = d.filial_id
      WHERE d.id = ?
    `).get(id);
    res.json(row);
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Este WhatsApp já está cadastrado' });
    }
    next(err);
  }
});

router.delete('/destinatarios/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const r = await db.prepare('DELETE FROM alerta_destinatarios WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ erro: 'Destinatário não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
