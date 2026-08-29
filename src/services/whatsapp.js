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
    return 'Sessão WhatsApp recusada (401). Clique em Gerar token e depois Conectar / QR com o chip da unidade.';
  }
  return `WuzAPI erro ${status}: ${texto}`;
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
  const base = (filial?.codigo || filial?.nome || filial?.id || 'unidade')
    .toString()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24);
  return `Pneu-${base || filial.id}`;
}

async function tokenUsadoPorOutraFilial(filialId, token) {
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

async function adminUsersWuzapi() {
  const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
  if (!admin || !config.wuzapiBaseUrl) return [];
  try {
    const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
      headers: { Authorization: admin },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

/**
 * Garante token WuzAPI exclusivo da filial (cria ao cadastrar / corrige token compartilhado).
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
  const envTok = tokenNaoEAdmin(config.wuzapiToken);
  const compartilhado = tokenAtual
    ? (await tokenUsadoPorOutraFilial(atual.id, tokenAtual) || (envTok && tokenAtual === envTok))
    : false;

  const precisaNovo = opts.forcarNovo || !tokenAtual || compartilhado;

  if (!precisaNovo) {
    return {
      token: tokenAtual,
      criado: false,
      regenerado: false,
      compartilhado: false,
      nome_wuzapi: nomeUser,
      precisa_conectar: false,
    };
  }

  // Preferência: usuário WuzAPI já dedicado a esta filial (mesmo nome), se não estiver
  // logado com sessão de outra unidade e o token não estiver em outra filial.
  let token = null;
  let origem = 'criado';
  let criadoNoWuzapi = false;

  if (!opts.forcarNovo && !compartilhado) {
    const users = await adminUsersWuzapi();
    const dedicado = users.find((u) => {
      const n = String(u.name || u.Name || '').trim();
      return n === nomeUser || n === `PneuSistemma-${atual.id}`;
    });
    const cand = tokenNaoEAdmin(dedicado?.token);
    if (cand && !(await tokenUsadoPorOutraFilial(atual.id, cand)) && !(envTok && cand === envTok)) {
      token = cand;
      origem = 'existente';
    }
  }

  if (!token) {
    token = `pneu_${atual.id}_${crypto.randomBytes(8).toString('hex')}`;
    const admin = tokenWuzapiUtil(config.wuzapiAdminToken);
    if (admin && config.wuzapiBaseUrl) {
      try {
        const res = await fetch(`${config.wuzapiBaseUrl}/admin/users`, {
          method: 'POST',
          headers: {
            Authorization: admin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: nomeUser, token }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const raw = await res.text();
          // Usuário pode já existir — tenta achar pelo nome e rotacionar token no banco só
          const users = await adminUsersWuzapi();
          const mesmoNome = users.find((u) => String(u.name || u.Name || '').trim() === nomeUser);
          if (mesmoNome && tokenNaoEAdmin(mesmoNome.token)
            && !(await tokenUsadoPorOutraFilial(atual.id, mesmoNome.token))) {
            token = tokenNaoEAdmin(mesmoNome.token);
            origem = 'existente';
          } else {
            console.warn('[whatsapp] criar user WuzAPI:', res.status, raw?.slice?.(0, 200));
          }
        } else {
          criadoNoWuzapi = true;
          origem = 'criado';
        }
      } catch (err) {
        console.warn('[whatsapp] WuzAPI indisponível ao provisionar filial:', err.message);
        // Mantém token no banco — conectar/QR tenta depois
      }
    }
  }

  // Token novo / regenerado: limpa chip/grupo herdados de outra sessão
  const limparCampos = compartilhado || opts.forcarNovo || !tokenAtual;
  await db.prepare(`
    UPDATE filiais SET
      wuzapi_token = ?,
      whatsapp = CASE WHEN ? THEN NULL ELSE whatsapp END,
      whatsapp_grupo = CASE WHEN ? THEN NULL ELSE whatsapp_grupo END,
      updated_at = NOW()
    WHERE id = ?
  `).run(token, limparCampos ? 1 : 0, limparCampos ? 1 : 0, atual.id);

  return {
    token,
    criado: criadoNoWuzapi || origem === 'criado',
    regenerado: Boolean(compartilhado || opts.forcarNovo),
    compartilhado: Boolean(compartilhado),
    nome_wuzapi: nomeUser,
    precisa_conectar: true,
    mensagem: compartilhado
      ? `Token exclusivo gerado para ${atual.nome} (havia sessão de outra unidade). Conecte o QR com o chip desta filial.`
      : `Token do chatbot criado para ${atual.nome}. Conecte / QR para iniciar.`,
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
      // Nunca grava token “emprestado” (.env / outra sessão) na filial —
      // cada unidade mantém só o token que ela provisionou.
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
  // WuzAPI exige data URI como application/octet-stream (não application/pdf)
  const dataUri = `data:application/octet-stream;base64,${b64}`;
  const payload = {
    Phone: dest.phone,
    FileName: nome,
    Document: dataUri,
  };
  // Caption opcional — algumas versões WuzAPI rejeitam; enviamos só se pedida
  if (opts.caption) payload.Caption = String(opts.caption).slice(0, 900);

  let lastErr = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    let res = await fetch(`${config.wuzapiBaseUrl}/chat/send/document`, {
      method: 'POST',
      headers: headersUsuarioWuzapi(token),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });

    let raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    // Retry sem Caption se a API reclamar do campo
    if (!res.ok && payload.Caption && /caption|unknown|invalid/i.test(JSON.stringify(data))) {
      const semCaption = { Phone: dest.phone, FileName: nome, Document: dataUri };
      res = await fetch(`${config.wuzapiBaseUrl}/chat/send/document`, {
        method: 'POST',
        headers: headersUsuarioWuzapi(token),
        body: JSON.stringify(semCaption),
        signal: AbortSignal.timeout(90_000),
      });
      raw = await res.text();
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { raw };
      }
    }

    if (res.ok) {
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
