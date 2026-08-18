/**
 * Webhook WuzAPI — placa → link de medição
 * Aceita chat privado ou grupo cadastrado na filial.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getDb } from '../database.js';
import { config } from '../config.js';
import { enviarERegistrar, enviarDocumentoERegistrar, limparTelefone, normalizarDestino } from '../services/whatsapp.js';
import {
  gerarTokenAcessoRapido,
  resumoStatusPneusVeiculoRapido,
} from '../services/acesso-rapido.js';
import { gerarRelatorioSemanalPdfBuffer } from '../services/relatorio-semanal-pdf.js';

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

/** Placa brasileira antiga (ABC1234) ou Mercosul (ABC1D23). Ignora conversa comum. */
function extrairPlacaValida(texto) {
  const compact = normalizarPlacaTexto(texto);
  if (/^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(compact)) return compact;
  if (/^[A-Z]{3}[0-9]{4}$/.test(compact)) return compact;
  const raw = String(texto || '').toUpperCase();
  const mercosul = raw.match(/\b[A-Z]{3}\s*-?\s*[0-9][A-Z][0-9]{2}\b/);
  if (mercosul) return normalizarPlacaTexto(mercosul[0]);
  const antiga = raw.match(/\b[A-Z]{3}\s*-?\s*[0-9]{4}\b/);
  if (antiga) return normalizarPlacaTexto(antiga[0]);
  return null;
}

async function listarFrotaMensagem(db, filialId = null) {
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
  const rows = await db.prepare(sql).all(...params);
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

async function buscarVeiculosPorPlaca(db, placaLimpa, filialPreferida = null) {
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

  if (filialPreferida) {
    const locais = await db.prepare(`${baseSql} AND v.filial_id = ? ORDER BY v.placa LIMIT 20`)
      .all(like, like, filialPreferida);
    return { veiculos: locais, escopo: 'filial' };
  }

  const todos = await db.prepare(`${baseSql} ORDER BY v.placa LIMIT 20`).all(like, like);
  return { veiculos: todos, escopo: 'todas' };
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
export function raizPayloadMensagem(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const d = payload.data;
  if (d && typeof d === 'object' && (d.Info || d.info || d.Message || d.message)) return d;
  const e = payload.event;
  if (e && typeof e === 'object' && !Array.isArray(e)
    && (e.Info || e.info || e.Message || e.message || e.Conversation || e.conversation)) {
    return e;
  }
  return payload;
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
  if (/Abrir medi|Link v[aá]lido|ALERTA DE PNEU|Frota cadastrada|Frota completa|n[aã]o encontrada|relat[oó]rio gerencial|Gerando o \*relat/i.test(text)) {
    return true;
  }
  // Comandos e placa pura → processa mesmo se fromMe
  const cmd = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (/^(frota|placas|lista|ajuda|help|menu|\?)$/i.test(cmd)) return false;
  if (/^(relatorio|report|pdf)\b/i.test(cmd)) return false;
  const placa = extrairPlacaValida(text);
  if (placa) return false;
  return true;
}

function jidsGrupoIguais(a, b) {
  const na = normalizarDestino(a);
  const nb = normalizarDestino(b);
  if (na?.isGroup && nb?.isGroup && na.logKey === nb.logKey) return true;
  const da = String(a || '').replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  const db = String(b || '').replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  return Boolean(da && db && da === db);
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
  const jid = extrairChatJid(event) || '';
  return String(jid).includes('@g.us');
}

/** Resolve canal da unidade a partir do chat (grupo ou número do chatbot) */
async function resolverCanalFilial(db, chatJid, phone, filialIdHint = null) {
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

  for (const f of filiais) {
    if (f.whatsapp_grupo) {
      if (jidsGrupoIguais(f.whatsapp_grupo, chatJid)) {
        // Sempre responde no chat da mensagem (JID atual), não no valor antigo salvo
        const replyTo = chatNorm?.phone
          || normalizarDestino(chatJid)?.phone
          || normalizarDestino(f.whatsapp_grupo)?.phone;
        return { filial: f, replyTo, escopoFilialId: f.id };
      }
    }
    if (f.whatsapp && phoneNorm && !String(chatJid || '').includes('@g.us')) {
      const n = limparTelefone(f.whatsapp);
      // Remetente usa o chip do chatbot da filial, ou chat privado com o bot
      if (n && n === phoneNorm) {
        return { filial: f, replyTo: n, escopoFilialId: f.id };
      }
    }
  }

  // Hint ?filial_id= só vale no privado do chip — grupo precisa estar selecionado
  if (filialIdHint && filiais[0] && !String(chatJid || '').includes('@g.us')) {
    const f = filiais[0];
    const replyTo = phoneNorm || limparTelefone(f.whatsapp) || chatNorm?.phone;
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

    const chatJid = extrairChatJid(event);
    const isGroup = ehMensagemDeGrupo(event) || Boolean(normalizarDestino(chatJid)?.isGroup);
    const phone = extrairTelefone(event);
    const body = extrairTextoMensagem(event);

    if (!body) {
      return res.status(200).json({ ok: true, ignored: 'sem_texto' });
    }

    const db = getDb();
    const filialIdHint = Number(req.query.filial_id) || null;
    const canal = await resolverCanalFilial(db, chatJid, phone, filialIdHint);

    // Grupo não é o selecionado na unidade → ignora (sem resposta e sem log)
    if (isGroup && !canal) {
      return res.status(200).json({
        ok: true,
        ignored: 'grupo_nao_selecionado',
        chat: chatJid,
      });
    }

    const replyTo = canal?.replyTo || phone;
    if (!replyTo) {
      return res.status(200).json({ ok: true });
    }
    // Em grupo, prioriza o JID do chat da mensagem (mais atual que o valor salvo)
    const destinoEnvio = (isGroup && chatJid) ? chatJid : replyTo;

    // Rate limit por remetente (não pelo grupo — evita bloquear a frota inteira)
    const rateKey = phone || destinoEnvio;
    if (!rateLimitOk(rateKey)) {
      return res.status(200).json({ ok: true, rate_limited: true });
    }

    const texto = String(body || '').trim();
    const cmd = texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

    // Comandos de frota / ajuda
    if (/^(frota|placas|lista|ajuda|help|menu|\?)$/i.test(cmd) || /^(frota|placas)\b/i.test(cmd)) {
      const mensagem = `${await listarFrotaMensagem(db, canal?.escopoFilialId || null)}\n\n_Comandos: frota | relatorio | placa do caminhão_`;
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem,
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: phone,
        registrar: false,
      });
      return res.status(200).json({ ok: true, comando: 'frota' });
    }

    // Relatório gerencial PDF (mesmo da unidade)
    if (/^(relatorio|report|pdf)\b/i.test(cmd)) {
      const filialId = canal?.escopoFilialId || null;
      if (!filialId) {
        await enviarERegistrar({
          tipo: 'relatorio_semanal',
          destinatario: destinoEnvio,
          mensagem: '❌ Não identifiquei a unidade deste chat. Configure o grupo no painel WhatsApp e tente de novo.',
          filialId: null,
          fallbackDestinatario: phone,
          registrar: false,
        });
        return res.status(200).json({ ok: true, comando: 'relatorio', erro: 'sem_filial' });
      }

      res.status(200).json({ ok: true, comando: 'relatorio', aceito: true, filial_id: filialId });

      (async () => {
        try {
          await enviarERegistrar({
            tipo: 'relatorio_semanal',
            destinatario: destinoEnvio,
            mensagem: '📊 Gerando o *relatório gerencial* da unidade… aguarde alguns segundos.',
            filialId,
            fallbackDestinatario: phone,
            registrar: false,
          });

          const { buffer, filename, dados } = await gerarRelatorioSemanalPdfBuffer(filialId, {
            geradoPor: `WhatsApp · ${phone || destinoEnvio}`,
          });

          const caption = [
            `📊 *Relatório gerencial* — ${dados.filial?.nome || 'Unidade'}`,
            dados.filial?.codigo ? `Código: ${dados.filial.codigo}` : null,
            `_Arquivo: ${filename}_`,
          ].filter(Boolean).join('\n');

          await enviarERegistrar({
            tipo: 'relatorio_semanal',
            destinatario: destinoEnvio,
            mensagem: caption,
            filialId,
            fallbackDestinatario: phone,
            registrar: false,
          });

          const envio = await enviarDocumentoERegistrar({
            tipo: 'relatorio_semanal',
            destinatario: destinoEnvio,
            buffer,
            fileName: filename,
            mensagem: caption,
            filialId,
            fallbackDestinatario: phone,
          });

          if (!envio?.ok) {
            await enviarERegistrar({
              tipo: 'relatorio_semanal',
              destinatario: destinoEnvio,
              mensagem: `❌ Não consegui enviar o PDF. ${envio?.erro || 'Tente de novo em instantes.'}`,
              filialId,
              fallbackDestinatario: phone,
            });
          } else {
            console.log('[webhook] relatorio enviado', {
              filial_id: filialId,
              arquivo: filename,
              via: envio.via || 'grupo',
              bytes: buffer.length,
            });
          }
        } catch (err) {
          console.error('[webhook] relatorio falhou:', err.message);
          try {
            await enviarERegistrar({
              tipo: 'relatorio_semanal',
              destinatario: destinoEnvio,
              mensagem: `❌ Falha ao gerar o relatório: ${err.message}`,
              filialId,
              fallbackDestinatario: phone,
            });
          } catch { /* ignore */ }
        }
      })();

      return;
    }

    const placaLimpa = extrairPlacaValida(texto);
    if (!placaLimpa) {
      return res.status(200).json({ ok: true, ignored: 'nao_e_placa' });
    }

    const { veiculos: encontrados } = await buscarVeiculosPorPlaca(
      db,
      placaLimpa,
      canal?.escopoFilialId || null
    );
    const veiculos = escolherVeiculoExato(encontrados, placaLimpa);

    if (veiculos.length === 0) {
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem: `❌ Placa *${placaLimpa}* não encontrada nesta unidade. Envie *frota* para ver as placas.`,
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: phone,
        registrar: false,
      });
      return res.status(200).json({ ok: true, encontrados: 0 });
    }

    if (veiculos.length > 1) {
      const lista = veiculos.map((v) => `• ${v.placa}${v.apelido ? ` — ${v.apelido}` : ''} (${v.tipo})`).join('\n');
      await enviarERegistrar({
        tipo: 'link_veiculo',
        destinatario: destinoEnvio,
        mensagem: `🔍 Encontrei ${veiculos.length} veículos:\n${lista}\n\nEnvie a placa exata para abrir a medição.`,
        filialId: canal?.escopoFilialId || null,
        fallbackDestinatario: phone,
        registrar: false,
      });
      return res.status(200).json({ ok: true, encontrados: veiculos.length });
    }

    const veiculo = veiculos[0];

    const { link } = await gerarTokenAcessoRapido({
      veiculoId: veiculo.id,
      filialId: veiculo.filial_id,
      whatsappOrigem: phone || destinoEnvio,
    });

    const { criticos, alertas, ultimaMedicao } = await resumoStatusPneusVeiculoRapido(veiculo.id);

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

    enviarERegistrar({
      tipo: 'link_veiculo',
      destinatario: destinoEnvio,
      mensagem,
      veiculoId: veiculo.id,
      linkPreview: false,
      filialId: veiculo.filial_id,
      fallbackDestinatario: phone,
    }).then((envio) => {
      if (!envio?.ok) {
        console.error('[webhook] falha ao enviar link', veiculo.placa, envio?.erro || '');
      }
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
