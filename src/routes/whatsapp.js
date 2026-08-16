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
} from '../services/whatsapp.js';
import crypto from 'crypto';

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
    const err = new Error(data?.error || data?.erro || data?.details || `WuzAPI admin ${res.status}`);
    err.status = (res.status === 401 || res.status === 403) ? 502 : res.status;
    err.data = data;
    if (res.status === 401 || res.status === 403) {
      err.message = 'WUZAPI_ADMIN_TOKEN inválido. Confira backend/.env e o token admin do container WuzAPI.';
    }
    throw err;
  }
  return data;
}

async function wuzapiFetch(path, { method = 'GET', body, token } = {}) {
  const t = tokenWuzapiUtil(token || config.wuzapiToken);
  if (!wuzapiConfigurado(t)) {
    const err = new Error('WuzAPI não configurado (URL + token da filial ou .env)');
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
        token: t,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
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

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    const err = new Error(data?.error || data?.erro || `WuzAPI ${res.status}`);
    // Nunca repassar 401/403 do WuzAPI — o frontend trata 401 como "sessão expirada" e faz logout
    const upstream = res.status;
    err.status = (upstream === 401 || upstream === 403) ? 502 : upstream;
    err.upstreamStatus = upstream;
    err.data = data;
    if (upstream === 401 || upstream === 403) {
      err.message = 'Token WuzAPI inválido ou sem permissão. Clique em “Gerar token” no painel WhatsApp (WuzAPI precisa estar no ar: npm run wuzapi:up).';
    }
    throw err;
  }

  return data;
}

/** Extrai número do JID WhatsApp (ignora device :xx) */
export function telefoneFromJid(jid) {
  const user = String(jid || '').split('@')[0] || '';
  const base = user.split(':')[0] || '';
  const digits = base.replace(/\D/g, '');
  return digits.length >= 10 ? digits : '';
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
    qrcode: d.qrcode || d.QRCode || null,
    token_configurado: Boolean(extra.token || config.wuzapiToken),
    ...extra,
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
  const { whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token } = req.body || {};

  try {
    const f = await filialOuErro(id);
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
        ? (limparCampoTexto(whatsapp)?.replace(/\D/g, '') || null)
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
      .then(() => tokenWuzapiFilial(id))
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
    const token = await tokenWuzapiFilial(f.id);
    if (!token) {
      return res.status(400).json({ erro: 'Cadastre/conecte o token WuzAPI antes' });
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
    const f = await filialOuErro(req.params.id);
    res.json({
      id: f.id,
      nome: f.nome,
      codigo: f.codigo,
      whatsapp: limparCampoTexto(f.whatsapp),
      whatsapp_grupo: limparCampoTexto(f.whatsapp_grupo),
      whatsapp_alerta: limparCampoTexto(f.whatsapp_alerta),
      tem_wuzapi_token: Boolean(tokenWuzapiUtil(f.wuzapi_token) || tokenWuzapiUtil(config.wuzapiToken)),
      admin_token_ok: Boolean(tokenWuzapiUtil(config.wuzapiAdminToken)),
      wuzapi_url: config.wuzapiBaseUrl,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Cria (ou reutiliza) usuário no WuzAPI via admin token e grava na filial.
 * Prefere usuário já logado (com sessão) para não quebrar o envio no grupo.
 */
router.post('/filial/:id/provisionar-token', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const nomeUser = `Pneu-${(f.codigo || f.nome || f.id).toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || f.id}`;

    const lista = await wuzapiAdminFetch('/admin/users');
    const users = Array.isArray(lista?.data) ? lista.data : (Array.isArray(lista) ? lista : []);

    const existente = users.find((u) => {
      const n = String(u.name || u.Name || '').trim();
      return n === nomeUser || n === 'PneuSistemma' || n === `PneuSistemma-${f.id}` || n === f.codigo;
    });
    // Só reutiliza sessão ativa se for o usuário desta filial (ou o token do .env)
    const logadoDaFilial = users.find((u) => {
      const n = String(u.name || u.Name || '').trim();
      const logged = u.loggedIn || u.LoggedIn;
      if (!logged) return false;
      if (n === nomeUser || n === 'PneuSistemma' || n === `PneuSistemma-${f.id}` || n === f.codigo) return true;
      if (tokenWuzapiUtil(config.wuzapiToken) && tokenWuzapiUtil(u.token) === tokenWuzapiUtil(config.wuzapiToken)) {
        return true;
      }
      return false;
    });

    let token = null;
    let criado = false;
    let nomeSalvo = nomeUser;
    let origem = 'criado';

    if (logadoDaFilial && tokenWuzapiUtil(logadoDaFilial.token)) {
      token = tokenWuzapiUtil(logadoDaFilial.token);
      nomeSalvo = logadoDaFilial.name || nomeUser;
      origem = 'sessao_ativa';
    } else if (tokenWuzapiUtil(config.wuzapiToken)) {
      try {
        const st = await wuzapiFetch('/session/status', { token: config.wuzapiToken });
        const d = st?.data || st || {};
        if (d.loggedIn || d.LoggedIn || d.connected || d.Connected) {
          token = tokenWuzapiUtil(config.wuzapiToken);
          nomeSalvo = '(.env)';
          origem = 'env';
        }
      } catch { /* ignore */ }
    }

    if (!token && existente) {
      token = tokenWuzapiUtil(existente.token);
      nomeSalvo = existente.name || nomeUser;
      origem = 'existente';
    }

    if (!token) {
      token = `pneu_${f.id}_${crypto.randomBytes(8).toString('hex')}`;
      await wuzapiAdminFetch('/admin/users', {
        method: 'POST',
        body: { name: nomeUser, token },
      });
      criado = true;
      origem = 'criado';
    }

    const db = getDb();
    await db.prepare(`
      UPDATE filiais SET
        wuzapi_token = ?,
        updated_at = NOW()
      WHERE id = ?
    `).run(token, f.id);

    const precisaQr = origem === 'criado' || origem === 'existente';
    res.json({
      mensagem: precisaQr
        ? `Token salvo em ${f.nome}. Clique em Conectar / QR para ativar a sessão.`
        : `Token com sessão ativa vinculado a ${f.nome} (${nomeSalvo}).`,
      nome_wuzapi: nomeSalvo,
      tem_wuzapi_token: true,
      criado,
      origem,
      precisa_conectar: precisaQr,
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
    const token = await tokenWuzapiFilial(f.id);
    if (!token) {
      return res.status(400).json({
        erro: 'Cadastre o token e conecte o chatbot antes de listar grupos',
        grupos: [],
      });
    }
    const data = await wuzapiFetch('/group/list', { token });
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
    res.status(err.status || 500).json({
      erro: err.message,
      grupos: [],
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
      const token = await tokenWuzapiFilial(f.id);
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
    const token = await tokenWuzapiFilial(f.id);
    if (!wuzapiConfigurado(token)) {
      return res.json({
        filial_id: f.id,
        nome: f.nome,
        configurado: false,
        connected: false,
        loggedIn: false,
        tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
        mensagem: 'Cadastre o token WuzAPI desta filial (ou o token global no .env)',
      });
    }
    const data = await wuzapiFetch('/session/status', { token });
    res.json(normalizarStatus(data, {
      filial_id: f.id,
      nome: f.nome,
      whatsapp: f.whatsapp,
      tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
    }));
  } catch (err) {
    const code = err.status === 401 || err.status === 403 ? 502 : (err.status || 500);
    res.status(code).json({ erro: err.message });
  }
});

router.post('/filial/:id/connect', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const token = await tokenWuzapiFilial(f.id);
    if (!token) {
      return res.status(400).json({
        erro: 'Cadastre o token WuzAPI desta filial antes de conectar',
      });
    }

    const webhook = await garantirWebhook(token, f.id);
    const data = await wuzapiFetch('/session/connect', {
      method: 'POST',
      token,
      body: { Subscribe: ['Message'], Immediate: true },
    });

    await new Promise((r) => setTimeout(r, 1500));
    let status;
    try {
      status = normalizarStatus(await wuzapiFetch('/session/status', { token }), {
        filial_id: f.id,
        nome: f.nome,
      });
    } catch {
      status = null;
    }

    let qrcode = status?.qrcode || '';
    if (!qrcode && !status?.loggedIn) {
      try {
        const qrData = await wuzapiFetch('/session/qr', { token });
        qrcode = qrData?.data?.QRCode || qrData?.data?.qrcode || '';
      } catch {
        // ignore
      }
    }

    res.json({
      mensagem: `Conexão do chatbot “${f.nome}” iniciada — escaneie o QR`,
      webhook,
      ...(status || {}),
      qrcode,
      wuzapi: data?.data || data,
    });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/filial/:id/disconnect', requireChatbotAcesso, async (req, res) => {
  try {
    if (!assertFilialNoEscopo(req, req.params.id)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const f = await filialOuErro(req.params.id);
    const token = tokenWuzapiUtil(f.wuzapi_token);
    if (!token) {
      return res.status(400).json({
        erro: 'Esta filial não tem token próprio. Cadastre/gere o token antes de desconectar.',
      });
    }
    await wuzapiFetch('/session/disconnect', { method: 'POST', token });
    res.json({ mensagem: `Chatbot de ${f.nome} desconectado` });
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
    await filialOuErro(filialId);
    const db = getDb();
    const limit = Math.min(Number(req.query.limit) || 40, 100);

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
       OR (
         n.filial_id IS NULL AND n.veiculo_id IS NULL AND n.destinatario_whatsapp IN (
           SELECT TRIM(whatsapp_grupo) FROM filiais WHERE id = ? AND whatsapp_grupo IS NOT NULL
           UNION
           SELECT TRIM(whatsapp) FROM filiais WHERE id = ? AND whatsapp IS NOT NULL
           UNION
           SELECT TRIM(whatsapp_alerta) FROM filiais WHERE id = ? AND whatsapp_alerta IS NOT NULL
         )
       )
    ORDER BY n.id DESC
    LIMIT ?
  `).all(filialId, filialId, filialId, filialId, filialId, limit);

    const mapRow = (n) => {
      let erro = null;
      try {
        const r = n.resposta_api ? JSON.parse(n.resposta_api) : null;
        erro = r?.erro || r?.error || null;
      } catch { /* ignore */ }
      const tipoLabel = {
        link_veiculo: 'Link medição',
        alerta_critico: 'Alerta crítico',
        alerta_desgaste: 'Alerta monitorar',
      }[n.tipo] || n.tipo;
      return {
        id: n.id,
        tipo: n.tipo,
        tipo_label: tipoLabel,
        destinatario: n.destinatario_whatsapp,
        placa: n.placa || null,
        apelido: n.apelido || null,
        status: n.status,
        status_label: n.status === 'enviado' || n.status === 'entregue'
          ? 'Enviado'
          : (n.status === 'erro' ? 'Pendente / falha' : n.status),
        erro,
        mensagem: n.mensagem,
        criado_em: n.criado_em,
        preview: String(n.mensagem || '').replace(/\s+/g, ' ').slice(0, 120),
      };
    };

    const mapped = rows.map(mapRow);
    const pendentes = mapped.filter((r) => r.status === 'erro');
    const enviados = mapped.filter((r) => r.status === 'enviado' || r.status === 'entregue');

    res.json({
      resumo: {
        pendentes: pendentes.length,
        enviados: enviados.length,
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
    const data = await wuzapiFetch('/session/status');
    res.json(normalizarStatus(data));
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message, configurado: wuzapiConfigurado() });
  }
});

router.get('/qr', requireAdmin, async (_req, res) => {
  try {
    const data = await wuzapiFetch('/session/qr');
    const qr = data?.data?.QRCode || data?.data?.qrcode || data?.QRCode || '';
    res.json({ qrcode: qr, tem_qr: Boolean(qr) });
  } catch (err) {
    res.status(err.status || 500).json({ erro: err.message });
  }
});

router.post('/connect', requireAdmin, async (_req, res) => {
  try {
    const webhook = await garantirWebhook(config.wuzapiToken, null);
    const data = await wuzapiFetch('/session/connect', {
      method: 'POST',
      body: { Subscribe: ['Message'], Immediate: true },
    });
    await new Promise((r) => setTimeout(r, 1500));
    let status;
    try {
      status = normalizarStatus(await wuzapiFetch('/session/status'));
    } catch {
      status = null;
    }
    let qrcode = status?.qrcode || '';
    if (!qrcode && !status?.loggedIn) {
      try {
        const qrData = await wuzapiFetch('/session/qr');
        qrcode = qrData?.data?.QRCode || qrData?.data?.qrcode || '';
      } catch { /* ignore */ }
    }
    res.json({
      mensagem: 'Conexão padrão (.env) iniciada',
      webhook,
      ...(status || {}),
      qrcode,
      wuzapi: data?.data || data,
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
