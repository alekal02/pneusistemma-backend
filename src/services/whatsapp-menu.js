/**
 * Menu numerado do chatbot WhatsApp.
 * 1 medir (placa→link) · 2/3 cadastro (link) · 4 troca (placa→link)
 * 5/6/7 fogo + montagem obrigatória do estoque · 6 também devolve recap→estoque
 */
import {
  obterSessao,
  salvarSessao,
  limparSessao,
  reivindicarGravacaoMedicao,
} from './whatsapp-sessao.js';
import { getDb } from '../database.js';
import {
  telefoneConfiavel,
  chipsWhatsappIguais,
  normalizarDestino,
  chipWhatsappGlobal,
} from './whatsapp.js';
import * as ops from './whatsapp-ops.js';
import {
  gerarTokenAcessoRapido,
  resumoStatusPneusVeiculoRapido,
} from './acesso-rapido.js';
import { gerarRelatorioSemanalPdfBuffer, resolverFiltroRelatorio } from './relatorio-semanal-pdf.js';
import {
  enviarERegistrar,
  enviarDocumentoERegistrar,
} from './whatsapp.js';
import {
  parseComandoNatural,
  parseConsultaWhatsApp,
  parseMedicaoWhatsApp,
  parseKmWhatsApp,
} from './whatsapp-comandos.js';
import { TIPOS_VEICULO } from '../config.js';
import { listarTiposEquipamento, resolverTipoEquipamento } from '../equipamento-tipos.js';

export function textoMenu() {
  return [
    '🛠️ *PneuSistemma — Menu*',
    '',
    '1️⃣ Medir pneu (placa → link)',
    '2️⃣ Cadastrar equipamento (link)',
    '3️⃣ Cadastrar pneu estoque (link)',
    '4️⃣ Trocar / montar (placa → link)',
    '5️⃣ Enviar pneu → estoque (nº fogo)',
    '6️⃣ Enviar pneu → recap (nº fogo)',
    '7️⃣ Enviar pneu → descarte (nº fogo)',
    '8️⃣ Relatório da frota (PDF por tipo)',
    '9️⃣ Frota (placas + sulco)',
    '',
    '0️⃣ Cancelar / voltar ao menu',
    '',
    '_Responda com o número. Sessão expira em 15 min._',
  ].join('\n');
}

function norm(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
}

function normalizarPlaca(texto) {
  return String(texto || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function parecePlacaBrasil(texto) {
  const p = normalizarPlaca(texto);
  if (p.length !== 7) return false;
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p);
}

function parecePlacaOperacional(texto) {
  const p = normalizarPlaca(texto);
  if (p.length < 3 || p.length > 10) return false;
  if (!/[A-Z]/.test(p) || !/[0-9]/.test(p)) return false;
  if (/^[0-9]+$/.test(p)) return false;
  return true;
}

function ehCancelar(cmd) {
  return /^(0|cancelar|cancela|sair|voltar|menu)$/i.test(cmd);
}

function ehMenu(cmd) {
  return /^(menu|ajuda|help|\?)$/i.test(cmd);
}

/** “fechou”, “rlx”, “flws” e similares — conversa, não operação. */
const RE_CONVERSA_LIVRE = /^(ok+|okay|oki|blz|beleza|show|top|tmj|tamo|vlw+|valeu+|obg|obrigad[oa]|obgd|flw+s?|falou|falow|xau+|tchau|bye|rlx|relaxa|deboa|db|ss+|kkk+|haha+|rsrs*|uhul?|fechou+|slk|fdc|suave|tranquilo|tranq|massa|boaa*|hmm+|aham|obgg+|tmjj+|vlww*|obgdo?|fechouu*|flws|rlxx*)$/;

export function ehConversaLivre(texto) {
  const c = norm(texto);
  if (!c) return true;
  return RE_CONVERSA_LIVRE.test(c);
}

/**
 * Atalho de nº de fogo só quando parece marca real (0501-0042, AP1-0134, 08251227).
 * Palavra sem dígito (fechou, rlx, flws) não é fogo.
 */
export function pareceFogoAvulso(texto) {
  const t = String(texto || '').trim();
  if (!t || /^[0-9]$/.test(t)) return false;
  const cmd = norm(t);
  if (ehMenu(cmd) || ehCancelar(cmd) || ehConversaLivre(t)) return false;
  if (/^(frota|placas|lista|relatorio|report|pdf)$/i.test(cmd)) return false;
  const fogo = t.replace(/^fogo\s+/i, '').trim();
  if (!fogo || /\s/.test(fogo)) return false;
  if (fogo.length < 2 || fogo.length > 24) return false;
  if (parecePlacaBrasil(fogo)) return false;
  if (!/-/.test(fogo) && !/^fogo\s+/i.test(t) && parecePlacaOperacional(fogo)) return false;
  if (!/[0-9]/.test(fogo)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_./]*$/.test(fogo)) return false;
  if (/^[0-9]+$/.test(fogo) && fogo.length < 3) return false;
  return true;
}

async function recusarFogoInvalido(ctx, texto) {
  if (ehConversaLivre(texto)) {
    await clear(ctx);
    await reply(ctx, 'Ok. Quando quiser, digite *menu*.');
    return true;
  }
  if (!pareceFogoAvulso(texto)) {
    await reply(ctx, 'Não entendi. Envie o *nº de fogo* (ex.: 0501-0042) ou *0* para cancelar.');
    return true;
  }
  return false;
}

function soNumero(texto) {
  const m = String(texto || '').trim().match(/^([1-9]|0)$/);
  return m ? m[1] : null;
}

function operacaoExigeRemetente(texto) {
  const cmd = norm(texto);
  if (/^(frota|placas|lista)$/i.test(cmd)) return false;
  if (soNumero(texto) === '9') return false;
  if (parseConsultaWhatsApp(texto)) return false;
  return true;
}

function motivoDescarteValido(texto) {
  const t = String(texto || '').trim();
  if (!t) return false;
  if (/^(?:-|\.|pular|skip)$/i.test(t)) return false;
  return true;
}

function simNao(texto) {
  const c = norm(texto);
  if (/^(1|s|sim|ok|confirmar|confirma)$/.test(c)) return true;
  if (/^(0|n|nao|não|cancelar)$/.test(c)) return false;
  return null;
}

const comandosRecentes = new Map();
const COMANDO_DEDUP_ID_MS = 120_000;

export function limparDedupMemoriaTeste() {
  comandosRecentes.clear();
}

function comandoDuplicado(ctx) {
  const id = ctx?.mensagemId;
  if (!id) return false;
  const now = Date.now();
  if (comandosRecentes.size > 200) {
    for (const [k, ts] of comandosRecentes) {
      if (now - ts > COMANDO_DEDUP_ID_MS) comandosRecentes.delete(k);
    }
  }
  const chave = `id:${id}`;
  const prev = comandosRecentes.get(chave);
  if (prev && now - prev < COMANDO_DEDUP_ID_MS) return true;
  comandosRecentes.set(chave, now);
  return false;
}

async function reply(ctx, mensagem, tipo = 'link_veiculo') {
  const tipoEnvio = (/PneuSistemma — Menu/i.test(mensagem) && tipo === 'link_veiculo')
    ? 'menu'
    : tipo;
  await enviarERegistrar({
    tipo: tipoEnvio,
    destinatario: ctx.destino,
    mensagem,
    filialId: ctx.filialId,
    fallbackDestinatario: ctx.phone,
  });
}

async function setFluxo(ctx, fluxo, passo, dados = {}) {
  await salvarSessao({
    filialId: ctx.filialId,
    telefone: ctx.phone,
    chatJid: ctx.chatJid,
    fluxo,
    passo,
    dados,
  });
}

async function clear(ctx) {
  await limparSessao(ctx.filialId, ctx.phone, ctx.chatJid);
}

async function resolverVeiculoPorTexto(filialId, texto) {
  const placaLimpa = normalizarPlaca(texto);
  if (!placaLimpa || placaLimpa.length < 3) return { ok: false, motivo: 'curta' };
  const veiculos = (await ops.buscarVeiculoPorPlaca(filialId, placaLimpa))
    .filter((v) => Number(v.filial_id) === Number(filialId));
  if (!veiculos.length) return { ok: false, motivo: 'nao_encontrada', placa: placaLimpa };
  if (veiculos.length > 1) {
    const exatos = veiculos.filter((v) => normalizarPlaca(v.placa) === placaLimpa);
    if (exatos.length === 1) return { ok: true, veiculo: exatos[0], placa: placaLimpa };
    return { ok: false, motivo: 'varias', placa: placaLimpa, veiculos };
  }
  return { ok: true, veiculo: veiculos[0], placa: placaLimpa };
}

export async function montarMensagemMedicao(veiculo, phone, destinoEnvio, filialIdEscopo = null) {
  const filialId = filialIdEscopo || veiculo.filial_id;
  if (filialIdEscopo && Number(veiculo.filial_id) !== Number(filialIdEscopo)) {
    throw new Error('Veículo de outra unidade');
  }
  const { link } = await gerarTokenAcessoRapido({
    tipo: 'medir',
    veiculoId: veiculo.id,
    filialId,
    whatsappOrigem: phone || destinoEnvio,
  });
  const { criticos, alertas, semClassificacao, ultimaMedicao } = await resumoStatusPneusVeiculoRapido(veiculo.id);

  let mensagem = `🚛 *${veiculo.placa}* — ${veiculo.tipo}\n`;
  if (veiculo.apelido) mensagem += `🏷️ ${veiculo.apelido}\n`;
  mensagem += `📍 Filial: ${veiculo.filial_nome || ''}\n\n`;
  if (ultimaMedicao) {
    mensagem += `📊 Última medição: ${ultimaMedicao.data_medicao}\n`;
    mensagem += `Posição ${ultimaMedicao.posicao}${ultimaMedicao.numero_fogo ? ` — Fogo ${ultimaMedicao.numero_fogo}` : ''}\n`;
    mensagem += `Sulco: ${ultimaMedicao.menor_sulco ?? '-'}mm\n\n`;
  }
  if (criticos > 0) mensagem += `🚨 *${criticos} pneu(s) em estado CRÍTICO*\n`;
  if (alertas > 0) mensagem += `⚠️ *${alertas} pneu(s) em ALERTA*\n`;
  if (semClassificacao > 0) mensagem += `ℹ️ *${semClassificacao} pneu(s) sem classificação de sulco*\n`;
  if (criticos === 0 && alertas === 0 && !semClassificacao) mensagem += `✅ Todos os pneus estão OK\n`;
  mensagem += `\n👉 Link (24h):\n${link}\n`;
  mensagem += `Ou envie no Zap: *1E 14,14,14* (KM opcional: *KM 150000*).`;
  return mensagem;
}

async function fluxoMedirPlaca(ctx, texto) {
  const med = parseMedicaoWhatsApp(texto);
  if (med?.linhas?.length) {
    await iniciarMedicaoWhatsApp(ctx, med);
    return;
  }
  if (!parecePlacaOperacional(texto) && !parecePlacaBrasil(texto)) {
    await reply(ctx, 'Isso não parece uma *placa* (ex.: BH123, ABC1D23).\nEnvie a placa ou *0* para cancelar.');
    return;
  }
  const r = await resolverVeiculoPorTexto(ctx.filialId, texto);
  if (!r.ok && r.motivo === 'varias') {
    await reply(ctx, `🔍 Encontrei várias:\n${r.veiculos.map((v) => `• ${v.placa}`).join('\n')}\n\nEnvie a *placa exata*.`);
    return;
  }
  if (!r.ok) {
    await reply(ctx, `❌ Placa *${r.placa || normalizarPlaca(texto)}* não encontrada nesta unidade.\n\nDigite *9* para frota ou *menu*.`);
    await clear(ctx);
    return;
  }
  try {
    await reply(ctx, await montarMensagemMedicao(r.veiculo, ctx.phone, ctx.destino, ctx.filialId));
  } catch (err) {
    await reply(ctx, `❌ Não consegui gerar o link: ${err.message}\n\nDigite *menu*.`);
  }
  await clear(ctx);
}

function mesclarLinhasMedicao(atual, novas) {
  const map = new Map();
  for (const l of atual || []) map.set(String(l.posicao).toUpperCase(), l);
  for (const l of novas || []) map.set(String(l.posicao).toUpperCase(), l);
  return [...map.values()];
}

function textoErrosMedicao(ok, erros) {
  const linhas = [];
  if (ok.length) linhas.push(`OK: ${ok.map((i) => i.posicao).join(', ')}`);
  linhas.push('Corrija:');
  for (const e of erros) linhas.push(`• ${e.posicao} — ${e.motivo}`);
  linhas.push('*0* cancela');
  return linhas.join('\n');
}

async function resolverPlacaMedicao(ctx, placaTexto) {
  const r = await resolverVeiculoPorTexto(ctx.filialId, placaTexto);
  if (!r.ok && r.motivo === 'varias') {
    await reply(ctx, `🔍 Encontrei várias:\n${r.veiculos.map((v) => `• ${v.placa}`).join('\n')}\n\nEnvie a *placa exata*.`);
    return null;
  }
  if (!r.ok) {
    await reply(ctx, `Placa *${r.placa || placaTexto}* não está nesta unidade.`);
    return null;
  }
  return r.veiculo;
}

function aplicarKmSessao(dados, km, kmAtual) {
  if (km == null) return { ...dados, km_erro: null };
  const err = ops.validarKmInformado(km, kmAtual);
  if (err) return { ...dados, km_erro: err };
  return { ...dados, km_informado: km, km_erro: null };
}

async function aplicarLinhasMedicao(ctx, sessaoDados, linhas, kmNovo = undefined) {
  const veiculoId = sessaoDados.veiculo_id;
  const mescladas = mesclarLinhasMedicao(sessaoDados.linhas, linhas);
  const { veiculo, ok, erros } = await ops.validarMedicoesWhatsApp({
    filialId: ctx.filialId,
    veiculoId,
    linhas: mescladas,
  });
  let dados = {
    veiculo_id: veiculo.id,
    placa: veiculo.placa,
    km_atual: veiculo.km_atual,
    km_informado: sessaoDados.km_informado,
    linhas: ok.map((i) => ({ posicao: i.posicao, valores: i.valores })),
    ok,
    erros,
  };
  if (kmNovo !== undefined) dados = aplicarKmSessao(dados, kmNovo, veiculo.km_atual);
  if (dados.km_erro) {
    await setFluxo(ctx, 'medir_wa', erros.length ? 'coletar' : (ok.length ? 'confirma' : 'coletar'), dados);
    await reply(ctx, `❌ ${dados.km_erro}. KM atual: ${veiculo.km_atual ?? 0}.`);
    return;
  }
  if (erros.length) {
    await setFluxo(ctx, 'medir_wa', 'coletar', dados);
    await reply(ctx, textoErrosMedicao(ok, erros));
    return;
  }
  if (!ok.length) {
    await setFluxo(ctx, 'medir_wa', 'coletar', dados);
    await reply(ctx, 'Envie: *1E 14,14,14* (ou *14,5;14,5;14,5*).\n*0* cancela');
    return;
  }
  await setFluxo(ctx, 'medir_wa', 'confirma', dados);
  await reply(ctx, ops.textoResumoMedicaoWa(veiculo.placa, ok, {
    kmAtual: veiculo.km_atual,
    kmInformado: dados.km_informado,
  }));
}

function jidsGrupoIguais(a, b) {
  const na = normalizarDestino(a);
  const nb = normalizarDestino(b);
  if (na?.isGroup && nb?.isGroup && na.logKey === nb.logKey) return true;
  const da = String(a || '').replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  const db = String(b || '').replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  return Boolean(da && db && da === db);
}

/**
 * Unidade ativa cujo whatsapp_grupo é o JID da mensagem.
 * Nome do grupo e texto da mensagem não entram nessa decisão.
 */
export async function resolverUnidadeOficial(chatJid) {
  if (!normalizarDestino(chatJid)?.isGroup) return null;
  const db = getDb();
  const filiais = await db.prepare(`
    SELECT id, nome, codigo, whatsapp, whatsapp_grupo
    FROM filiais
    WHERE ativo = 1
      AND whatsapp_grupo IS NOT NULL
      AND TRIM(whatsapp_grupo) <> ''
  `).all();
  const matches = (filiais || []).filter((f) => jidsGrupoIguais(f.whatsapp_grupo, chatJid));
  if (matches.length > 1) {
    console.warn('[whatsapp-menu] mais de uma unidade no mesmo JID — usando a primeira', {
      chat: chatJid,
      filiais: matches.map((f) => f.id),
    });
  }
  return matches[0] || null;
}

async function telefoneEhDoChatbot(phone, chipUnidade) {
  const chips = [chipUnidade, await chipWhatsappGlobal()];
  return chips.some((c) => c && chipsWhatsappIguais(c, phone));
}

function auditoriaDe(participante) {
  return {
    telefone: participante.telefone,
    grupo: participante.grupo,
    unidade: participante.unidade,
    filialId: participante.filialId,
  };
}

function textoResponsavel(participante) {
  return [
    participante.telefone,
    'WhatsApp',
    `grupo ${participante.grupo}`,
    `unidade ${participante.unidade}`,
  ].join(' · ');
}

/**
 * Qualquer participante identificável do grupo oficial da unidade.
 * Não consulta usuarios.whatsapp nem papel.
 */
async function exigirParticipanteGrupo(ctx, assunto = 'a operação') {
  const unidade = await resolverUnidadeOficial(ctx.chatJid);
  if (!unidade || Number(unidade.id) !== Number(ctx.filialId)) {
    await reply(ctx, `Este grupo não está vinculado a uma unidade ativa. Não gravei ${assunto}.`);
    return null;
  }
  const phone = telefoneConfiavel(ctx.phone);
  if (!phone || await telefoneEhDoChatbot(phone, unidade.whatsapp)) {
    await reply(ctx, `Não identifiquei seu número neste grupo. Não gravei ${assunto}.`);
    return null;
  }
  return {
    telefone: phone,
    grupo: String(unidade.whatsapp_grupo).trim(),
    unidade: unidade.nome,
    filialId: unidade.id,
  };
}

async function gravarMovimentacaoConfirmada(ctx, { fluxos, passos, executar }) {
  const participante = await exigirParticipanteGrupo(ctx, 'a movimentação');
  if (!participante) return null;
  const db = getDb();
  try {
    const resultado = await db.transaction(async () => {
      await reivindicarGravacaoMedicao({
        filialId: ctx.filialId,
        telefone: ctx.phone,
        chatJid: ctx.chatJid,
        mensagemId: ctx.mensagemId,
        fluxos,
        passos,
      });
      return executar(auditoriaDe(participante));
    });
    await clear(ctx);
    return resultado;
  } catch (err) {
    if (err.codigo === 'duplicada') {
      await reply(ctx, 'Essa confirmação já foi registrada. Nada foi gravado de novo.');
      return null;
    }
    await reply(ctx, `❌ ${err.message}\n*1* tenta de novo · *0* cancela`);
    return null;
  }
}

function decisaoConfirmacao(texto) {
  const sn = simNao(texto);
  if (sn === true) return 'confirma';
  if (sn === false) return 'cancela';
  return 'aguarda';
}

async function gravarMedicaoConfirmada(ctx, d) {
  const participante = await exigirParticipanteGrupo(ctx);
  if (!participante) return;
  const db = getDb();
  try {
    const resultado = await db.transaction(async () => {
      await reivindicarGravacaoMedicao({
        filialId: ctx.filialId,
        telefone: ctx.phone,
        chatJid: ctx.chatJid,
        mensagemId: ctx.mensagemId,
      });
      return ops.registrarMedicoesWhatsApp({
        filialId: ctx.filialId,
        veiculoId: d.veiculo_id,
        itens: d.ok,
        kmInformado: d.km_informado,
        responsavel: textoResponsavel(participante),
      });
    });
    await clear(ctx);
    const kmTxt = resultado.km != null ? ` · KM ${resultado.km}` : '';
    await reply(ctx, `✅ ${resultado.total} medições em *${resultado.placa}*${kmTxt}.`);
  } catch (err) {
    if (err.codigo === 'duplicada') {
      await reply(ctx, 'Essa confirmação já foi registrada. Nada foi gravado de novo.');
      return;
    }
    await reply(ctx, `❌ ${err.message}\n*1* tenta de novo · *0* cancela`);
  }
}

async function iniciarMedicaoWhatsApp(ctx, med) {
  const participante = await exigirParticipanteGrupo(ctx);
  if (!participante) return;
  let veiculoId = null;
  let placa = med.placa || null;
  if (placa) {
    const veiculo = await resolverPlacaMedicao(ctx, placa);
    if (!veiculo) {
      if (med.linhas?.length) {
        await setFluxo(ctx, 'medir_wa', 'placa', { linhas: med.linhas });
      }
      return;
    }
    veiculoId = veiculo.id;
    placa = veiculo.placa;
  }
  if (!veiculoId) {
    await setFluxo(ctx, 'medir_wa', 'placa', { linhas: med.linhas || [], km_informado: med.km });
    await reply(ctx, 'Envie a *placa* do caminhão.\n*0* cancela');
    return;
  }
  await aplicarLinhasMedicao(ctx, { veiculo_id: veiculoId, placa, linhas: [], km_informado: med.km }, med.linhas || [], med.km);
}

async function passoMedicaoWhatsApp(ctx, sessao, texto) {
  const d = sessao.dados || {};
  const med = parseMedicaoWhatsApp(texto);
  const kmSo = parseKmWhatsApp(texto);

  if (sessao.passo === 'placa') {
    if (med?.placa || parecePlacaOperacional(texto) || parecePlacaBrasil(texto)) {
      const placaTxt = med?.placa || texto;
      const veiculo = await resolverPlacaMedicao(ctx, placaTxt);
      if (!veiculo) return;
      const linhas = mesclarLinhasMedicao(d.linhas, med?.linhas || []);
      await aplicarLinhasMedicao(
        ctx,
        { veiculo_id: veiculo.id, placa: veiculo.placa, linhas: [], km_informado: d.km_informado },
        linhas,
        med?.km ?? d.km_informado,
      );
      return;
    }
    await reply(ctx, 'Envie a placa (ex.: ABC1D23).\n*0* cancela');
    return;
  }

  if (med?.linhas?.length) {
    if (med.placa && d.veiculo_id) {
      const veiculo = await resolverPlacaMedicao(ctx, med.placa);
      if (!veiculo) return;
      d.veiculo_id = veiculo.id;
      d.placa = veiculo.placa;
    }
    await aplicarLinhasMedicao(ctx, d, med.linhas, med.km);
    return;
  }

  if (kmSo != null && !med?.linhas?.length) {
    await aplicarLinhasMedicao(ctx, d, [], kmSo);
    return;
  }

  if (sessao.passo === 'confirma') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Cancelado.');
      return;
    }
    if (sn !== true) {
      await reply(ctx, 'Mais posições, *KM 123456*, *1* salva ou *0* cancela.');
      return;
    }
    if (d.erros?.length) {
      await reply(ctx, textoErrosMedicao(d.ok || [], d.erros));
      return;
    }
    if (!d.ok?.length) {
      await reply(ctx, 'Envie as medições: *1E 14,14,14*');
      return;
    }
    if (d.km_erro) {
      await reply(ctx, `❌ ${d.km_erro}`);
      return;
    }
    await gravarMedicaoConfirmada(ctx, d);
    return;
  }

  if (sessao.passo === 'coletar') {
    if (simNao(texto) === true && d.ok?.length && !d.erros?.length) {
      await setFluxo(ctx, 'medir_wa', 'confirma', d);
      await reply(ctx, ops.textoResumoMedicaoWa(d.placa, d.ok, {
        kmAtual: d.km_atual, kmInformado: d.km_informado,
      }));
      return;
    }
    await reply(ctx, 'Envie *1E 14,14,14* ou *14,5;14,5;14,5*.\n*0* cancela');
  }
}

async function fluxoTrocaPlaca(ctx, texto) {
  if (!parecePlacaOperacional(texto) && !parecePlacaBrasil(texto)) {
    await reply(ctx, 'Placa inválida (ex.: BH123). Tente de novo ou *0*.');
    return;
  }
  const r = await resolverVeiculoPorTexto(ctx.filialId, texto);
  if (!r.ok && r.motivo === 'varias') {
    await reply(ctx, `Várias:\n${r.veiculos.map((v) => `• ${v.placa}`).join('\n')}\nEnvie a exata.`);
    return;
  }
  if (!r.ok) {
    await reply(ctx, `Placa *${r.placa || normalizarPlaca(texto)}* não encontrada nesta unidade. *0* = cancelar.`);
    return;
  }
  const { link } = await gerarTokenAcessoRapido({
    tipo: 'troca',
    veiculoId: r.veiculo.id,
    filialId: ctx.filialId,
    whatsappOrigem: ctx.phone || ctx.destino,
  });
  await reply(
    ctx,
    [
      `🔄 *Troca — ${r.veiculo.placa}*`,
      '',
      'No link: escolha o pneu a *retirar* e depois o pneu do *estoque* para montar na mesma posição.',
      '',
      `👉 ${link}`,
      '',
      '_Link 24h. Digite *menu* quando terminar._',
    ].join('\n')
  );
  await clear(ctx);
}

async function enviarLinkCadastro(ctx, tipo) {
  const { link } = await gerarTokenAcessoRapido({
    tipo,
    filialId: ctx.filialId,
    whatsappOrigem: ctx.phone || ctx.destino,
  });
  if (tipo === 'cadastrar_veiculo') {
    await reply(
      ctx,
      `🚜 *Cadastrar equipamento*\n\nAbra o link, escolha o tipo e preencha os dados:\n👉 ${link}\n\n_Válido 24h. Digite *menu*._`
    );
  } else {
    await reply(
      ctx,
      `🛞 *Cadastrar pneu (estoque)*\n\nAbra o link e informe nº de fogo, modelo e padrão:\n👉 ${link}\n\n_Válido 24h. Digite *menu*._`
    );
  }
}

function textoTiposVeiculo() {
  return TIPOS_VEICULO.map((t, i) => `*${i + 1}* ${t}`).join('\n');
}

function resolverTipoVeiculoDigitado(texto) {
  const n = soNumero(texto);
  if (n != null) {
    const idx = parseInt(n, 10) - 1;
    if (idx >= 0 && idx < TIPOS_VEICULO.length) return TIPOS_VEICULO[idx];
  }
  const c = norm(texto);
  if (/caminhao|truck|tracao/.test(c)) return 'Truck / Tração';
  if (/trator/.test(c)) return 'Trator';
  if (/toco|mini/.test(c)) return 'Toco / Mini';
  if (/compactador/.test(c)) return 'Compactador';
  if (/utilit|varredeira/.test(c)) return 'Utilitário / Varredeira';
  return null;
}

function textoPreCadastroVeiculo(placa, link) {
  return [
    '✅ Pré-cadastro realizado!',
    '',
    `🚛 Veículo: ${placa}`,
    '',
    'Para concluir o cadastro, acesse o link abaixo e informe modelo, fabricante, configuração dos eixos e demais informações necessárias.',
    '',
    `🔗 ${link}`,
    '',
    '⚠️ O veículo só estará disponível para operações após a conclusão do cadastro.',
  ].join('\n');
}

function textoPreCadastroPneu(fogo, link) {
  return [
    '✅ Pré-cadastro realizado!',
    '',
    `🛞 Pneu: ${fogo}`,
    '',
    'Para concluir o cadastro, acesse o link abaixo e informe modelo, fabricante e demais informações técnicas.',
    '',
    `🔗 ${link}`,
    '',
    '⚠️ O pneu só estará disponível para operações após a conclusão do cadastro.',
  ].join('\n');
}

async function pedirConfirmacaoPreCadastro(ctx, dados) {
  await setFluxo(ctx, 'pre_cadastro', 'confirma', dados);
  if (dados.alvo === 'pneu') {
    await reply(ctx, `Pré-cadastrar pneu *${dados.fogo}*?\n*1* sim · *0* não`);
    return;
  }
  await reply(
    ctx,
    `Pré-cadastrar *${dados.placa}* como *${dados.tipoVeiculo}*?\n*1* sim · *0* não`
  );
}

async function concluirPreCadastroVeiculo(ctx, { placa, tipoVeiculo }) {
  const existente = await ops.buscarPlacaFilial(ctx.filialId, placa);
  if (existente) {
    await clear(ctx);
    if (!ops.cadastroEstaCompleto(existente)) {
      await reply(ctx, `❌ *${existente.placa}* já está em pré-cadastro nesta unidade. Conclua pelo link enviado.`);
    } else {
      await reply(ctx, `❌ Placa *${existente.placa}* já cadastrada nesta unidade.`);
    }
    return;
  }
  const created = await ops.criarVeiculo(ctx.filialId, {
    placa,
    tipo: tipoVeiculo,
    preCadastro: true,
  });
  const { link } = await gerarTokenAcessoRapido({
    tipo: 'cadastrar_veiculo',
    veiculoId: created.id,
    filialId: ctx.filialId,
    whatsappOrigem: ctx.phone || ctx.destino,
  });
  await clear(ctx);
  await reply(ctx, textoPreCadastroVeiculo(String(placa).trim().toUpperCase(), link));
}

async function concluirPreCadastroPneu(ctx, { fogo }) {
  const hits = await ops.buscarPneusPorFogo(ctx.filialId, fogo);
  const existente = hits.find((p) =>
    String(p.numero_fogo || '').replace(/[-\s]/g, '').toLowerCase()
    === String(fogo).replace(/[-\s]/g, '').toLowerCase()
  ) || (hits.length === 1 ? hits[0] : null);
  if (existente) {
    await clear(ctx);
    await reply(ctx, `❌ Já existe pneu com o nº de fogo *${existente.numero_fogo}* nesta unidade.`);
    return;
  }
  const created = await ops.criarPneuEstoque(ctx.filialId, {
    numero_fogo: fogo,
    modelo: 'Pendente',
    preCadastro: true,
  });
  const { link } = await gerarTokenAcessoRapido({
    tipo: 'cadastrar_pneu',
    pneuId: created.id,
    filialId: ctx.filialId,
    whatsappOrigem: ctx.phone || ctx.destino,
  });
  await clear(ctx);
  await reply(ctx, textoPreCadastroPneu(created.numero_fogo || fogo, link));
}

async function iniciarCadastroPneu(ctx, fogoInformado) {
  if (!await exigirParticipanteGrupo(ctx, 'o cadastro')) return;
  if (!fogoInformado) {
    await setFluxo(ctx, 'cadastro_pneu', 'fogo', {});
    await reply(ctx, '🛞 *Cadastro de pneu*\nEnvie o *nº de fogo*.\n_0 = cancelar_');
    return;
  }
  await avancarFogoCadastro(ctx, fogoInformado);
}

async function avancarFogoCadastro(ctx, informado) {
  const fogo = String(informado || '').replace(/^fogo\s+/i, '').trim();
  if (fogo.length < 3) {
    await reply(ctx, 'Envie o *nº de fogo* (mín. 3 caracteres).\n_0 = cancelar_');
    return;
  }
  let prep;
  try {
    prep = await ops.prepararFogoCadastro(ctx.filialId, fogo);
  } catch (err) {
    await reply(ctx, `❌ ${err.message}\nEnvie outro nº ou *0*.`);
    return;
  }
  if (prep.existente) {
    await clear(ctx);
    await reply(ctx, `❌ Já existe pneu *${prep.existente.numero_fogo}* nesta unidade. Nada foi cadastrado.`);
    return;
  }
  await setFluxo(ctx, 'cadastro_pneu', 'modelo', { fogo: prep.numero_fogo });
  await reply(ctx, `Fogo *${prep.numero_fogo}*.\nQual o *modelo*? (obrigatório)\n_0 = cancelar_`);
}

function tipoPneuDigitado(texto) {
  const c = norm(texto);
  if (/^(1|direcional|dianteira|direcao)$/.test(c)) return 'direcional';
  if (/^(2|misto)$/.test(c)) return 'misto';
  if (/^(3|borrachudo|tracao)$/.test(c)) return 'borrachudo';
  return null;
}

function condicaoPneuDigitada(texto) {
  const c = norm(texto);
  if (/^(1|novo)$/.test(c)) return 'novo';
  if (/^(2|recapado|recap|recauchutado)$/.test(c)) return 'recapado';
  return null;
}

function textoResumoCadastroPneu(d) {
  return [
    'Cadastrar este pneu no estoque?',
    `Fogo: *${d.fogo}*`,
    `Modelo: *${d.modelo}*`,
    `Marca: ${d.marca || '—'}`,
    `Tipo: ${d.tipo_pneu}`,
    `Condição: ${d.condicao}`,
    `Sulco inicial: ${d.sulco_inicial_mm != null ? `${d.sulco_inicial_mm} mm` : '—'}`,
    '',
    '*1* confirma · *0* cancela',
  ].join('\n');
}

async function passoCadastroPneu(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'fogo') {
    await avancarFogoCadastro(ctx, texto);
    return;
  }
  if (sessao.passo === 'modelo') {
    const modelo = String(texto || '').trim();
    if (modelo.length < 2 || /^pendente$/i.test(modelo)) {
      await reply(ctx, 'Informe o *modelo* do pneu (obrigatório).\n_0 = cancelar_');
      return;
    }
    await setFluxo(ctx, 'cadastro_pneu', 'marca', { ...d, modelo });
    await reply(ctx, 'Marca / fabricante? (ou *pular*)\n_0 = cancelar_');
    return;
  }
  if (sessao.passo === 'marca') {
    const t = String(texto || '').trim();
    if (!t) {
      await reply(ctx, 'Informe a marca ou *pular*.\n_0 = cancelar_');
      return;
    }
    const marca = /^(pular|skip|-|\.)$/i.test(t) ? null : t;
    await setFluxo(ctx, 'cadastro_pneu', 'tipo', { ...d, marca });
    await reply(ctx, 'Tipo: *1* direcional · *2* misto · *3* borrachudo\n_0 = cancelar_');
    return;
  }
  if (sessao.passo === 'tipo') {
    const tipo = tipoPneuDigitado(texto);
    if (!tipo) {
      await reply(ctx, 'Tipo inválido. *1* direcional · *2* misto · *3* borrachudo\n_0 = cancelar_');
      return;
    }
    await setFluxo(ctx, 'cadastro_pneu', 'condicao', { ...d, tipo_pneu: tipo });
    await reply(ctx, 'Condição: *1* novo · *2* recapado\n_0 = cancelar_');
    return;
  }
  if (sessao.passo === 'condicao') {
    const condicao = condicaoPneuDigitada(texto);
    if (!condicao) {
      await reply(ctx, 'Condição inválida. *1* novo · *2* recapado\n_0 = cancelar_');
      return;
    }
    await setFluxo(ctx, 'cadastro_pneu', 'sulco', { ...d, condicao });
    await reply(ctx, 'Sulco inicial em mm (ou *pular*)\n_0 = cancelar_');
    return;
  }
  if (sessao.passo === 'sulco') {
    const t = String(texto || '').trim();
    let sulco = null;
    if (!/^(pular|skip|-|\.)$/i.test(t)) {
      const n = Number(t.replace(',', '.'));
      if (!t || !Number.isFinite(n) || n < 0 || n > 40) {
        await reply(ctx, 'Sulco inicial em mm (0 a 40) ou *pular*.\n_0 = cancelar_');
        return;
      }
      sulco = n;
    }
    const dados = { ...d, sulco_inicial_mm: sulco };
    await setFluxo(ctx, 'cadastro_pneu', 'confirma', dados);
    await reply(ctx, textoResumoCadastroPneu(dados));
    return;
  }
  if (sessao.passo === 'confirma') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Cancelado. Nada foi cadastrado.\n\n' + textoMenu());
      return;
    }
    if (sn !== true) {
      await reply(ctx, '*1* confirma · *0* cancela');
      return;
    }
    const criado = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['cadastro_pneu'],
      executar: (auditoria) => ops.criarPneuEstoque(ctx.filialId, {
        numero_fogo: d.fogo,
        marca: d.marca,
        modelo: d.modelo,
        tipo_pneu: d.tipo_pneu,
        condicao: d.condicao,
        sulco_inicial_mm: d.sulco_inicial_mm,
        auditoria,
      }),
    });
    if (!criado) return;
    await reply(
      ctx,
      `✅ Pneu *${criado.numero_fogo}* cadastrado no estoque.\n${[criado.marca, criado.modelo].filter(Boolean).join(' ')}\n\n${textoMenu()}`
    );
  }
}

async function iniciarPreCadastro(ctx, natural) {
  if (natural.tipo === 'cadastrar_pneu') {
    await iniciarCadastroPneu(ctx, natural.fogo || null);
    return;
  }

  const placa = natural.placa ? String(natural.placa).toUpperCase() : null;
  const tipoVeiculo = natural.tipoVeiculo || null;
  if (placa) {
    const existente = await ops.buscarPlacaFilial(ctx.filialId, placa);
    if (existente) {
      if (!ops.cadastroEstaCompleto(existente)) {
        await reply(ctx, `❌ *${existente.placa}* já está em pré-cadastro nesta unidade. Conclua pelo link enviado.`);
      } else {
        await reply(ctx, `❌ Placa *${existente.placa}* já cadastrada nesta unidade.`);
      }
      return;
    }
  }
  if (!placa) {
    await setFluxo(ctx, 'pre_cadastro', 'placa', { alvo: 'veiculo', tipoVeiculo });
    await reply(ctx, '🚛 Envie a *placa* ou identificação interna do veículo.\n_0 = cancelar_');
    return;
  }
  if (!tipoVeiculo) {
    await setFluxo(ctx, 'pre_cadastro', 'tipo', { alvo: 'veiculo', placa });
    await reply(ctx, `Qual o tipo de *${placa}*?\n${textoTiposVeiculo()}\n_0 = cancelar_`);
    return;
  }
  await pedirConfirmacaoPreCadastro(ctx, { alvo: 'veiculo', placa, tipoVeiculo });
}

async function passoPreCadastro(ctx, sessao, texto) {
  const d = sessao.dados || {};
  if (sessao.passo === 'placa') {
    const placa = normalizarPlaca(texto);
    if (placa.length < 3 || !/[0-9]/.test(placa)) {
      await reply(ctx, 'Envie a *placa* ou identificação interna (ex.: ABC1D23 ou TR-015).\n_0 = cancelar_');
      return;
    }
    const existente = await ops.buscarPlacaFilial(ctx.filialId, placa);
    if (existente) {
      await clear(ctx);
      await reply(ctx, `❌ Placa *${existente.placa}* já cadastrada nesta unidade.`);
      return;
    }
    if (!d.tipoVeiculo) {
      await setFluxo(ctx, 'pre_cadastro', 'tipo', { ...d, alvo: 'veiculo', placa });
      await reply(ctx, `Qual o tipo de *${placa}*?\n${textoTiposVeiculo()}\n_0 = cancelar_`);
      return;
    }
    await pedirConfirmacaoPreCadastro(ctx, { alvo: 'veiculo', placa, tipoVeiculo: d.tipoVeiculo });
    return;
  }
  if (sessao.passo === 'tipo') {
    const tipoVeiculo = resolverTipoVeiculoDigitado(texto);
    if (!tipoVeiculo) {
      await reply(ctx, `Tipo inválido. Escolha:\n${textoTiposVeiculo()}\n_0 = cancelar_`);
      return;
    }
    await pedirConfirmacaoPreCadastro(ctx, { alvo: 'veiculo', placa: d.placa, tipoVeiculo });
    return;
  }
  if (sessao.passo === 'fogo') {
    const fogo = String(texto).replace(/^fogo\s+/i, '').trim();
    if (!fogo || fogo.length < 3) {
      await reply(ctx, 'Envie o *nº de fogo* (mín. 3 caracteres).\n_0 = cancelar_');
      return;
    }
    await pedirConfirmacaoPreCadastro(ctx, { alvo: 'pneu', fogo });
    return;
  }
  if (sessao.passo === 'confirma') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Cancelado. Nada foi alterado.');
      return;
    }
    if (sn !== true) {
      await reply(ctx, '*1* confirma · *0* cancela');
      return;
    }
    if (!await exigirParticipanteGrupo(ctx, 'o cadastro')) return;
    try {
      if (d.alvo === 'pneu') await concluirPreCadastroPneu(ctx, d);
      else await concluirPreCadastroVeiculo(ctx, d);
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}`);
    }
  }
}

async function pedirSubstitutoObrigatorio(ctx, {
  fluxo, passo, dados, titulo, placa, posicao,
}) {
  const estoque = await ops.listarEstoque(ctx.filialId, 20);
  if (!estoque.length) {
    await clear(ctx);
    await reply(
      ctx,
      [
        `⚠️ ${titulo}`,
        `Estoque vazio — o pneu original permanece montado em *${placa}* / *${posicao}*.`,
        'Cadastre um pneu (*3*) e tente de novo.',
        '',
        textoMenu(),
      ].join('\n')
    );
    return false;
  }
  await setFluxo(ctx, fluxo, passo, dados);
  const lista = estoque
    .slice(0, 15)
    .map((p) => `• *${p.numero_fogo}* — ${[p.marca, p.modelo].filter(Boolean).join(' ') || p.tipo_pneu}`)
    .join('\n');
  await reply(
    ctx,
    [
      titulo,
      `Para concluir, monte um pneu do estoque em *${placa}* / *${posicao}*.`,
      '',
      `Estoque:\n${lista}`,
      '',
      'Envie o *nº de fogo* do estoque.',
      '*0* cancela — o pneu original permanece montado.',
    ].join('\n')
  );
  return true;
}

async function pedirMontarEstoque(ctx, { veiculoId, posicao, placa, acaoLabel }) {
  const estoque = await ops.listarEstoque(ctx.filialId, 20);
  if (!estoque.length) {
    await clear(ctx);
    const { link } = await gerarTokenAcessoRapido({
      tipo: 'cadastrar_pneu',
      filialId: ctx.filialId,
      whatsappOrigem: ctx.phone || ctx.destino,
    });
    await reply(
      ctx,
      [
        `⚠️ ${acaoLabel} — posição *${posicao}* em *${placa}* ficou vazia.`,
        'Estoque vazio. Cadastre um pneu e depois use *4* para montar:',
        `👉 ${link}`,
        '',
        textoMenu(),
      ].join('\n')
    );
    return;
  }
  await setFluxo(ctx, 'montar_pos', 'fogo', {
    veiculo_id: veiculoId,
    posicao,
    placa,
  });
  const lista = estoque
    .slice(0, 15)
    .map((p) => `• *${p.numero_fogo}* — ${[p.marca, p.modelo].filter(Boolean).join(' ') || p.tipo_pneu}`)
    .join('\n');
  await reply(
    ctx,
    [
      `✅ ${acaoLabel}`,
      `Agora *obrigatório*: monte um pneu do estoque em *${placa}* / *${posicao}*.`,
      '',
      `Estoque:\n${lista}`,
      '',
      'Envie o *nº de fogo* do estoque (ou *0* cancela — posição fica vazia).',
    ].join('\n')
  );
}

async function passoMontarPos(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'confirma') {
    const decisao = decisaoConfirmacao(texto);
    if (decisao === 'cancela') {
      await clear(ctx);
      await reply(ctx, 'Cancelado. Nada foi alterado.');
      return;
    }
    if (decisao !== 'confirma') {
      await reply(ctx, '*1* confirma · *0* cancela');
      return;
    }
    const r = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['montar_pos'],
      executar: (auditoria) => ops.montarPneu({
        filialId: ctx.filialId,
        pneuId: d.pneu_id,
        veiculoId: d.veiculo_id,
        posicao: d.posicao,
        auditoria,
      }),
    });
    if (!r) return;
    await reply(ctx, `✅ Fogo *${r.fogo}* montado em *${r.placa}* (${r.posicao}).\n\n` + textoMenu());
    return;
  }
  if (sessao.passo !== 'fogo') {
    await clear(ctx);
    await reply(ctx, textoMenu());
    return;
  }
  if (await recusarFogoInvalido(ctx, texto)) return;
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
  if (!pneu || pneu.status_pneu !== 'estoque') {
    await reply(ctx, 'Fogo não encontrado no *estoque*. Envie outro nº ou *0*.');
    return;
  }
  await setFluxo(ctx, 'montar_pos', 'confirma', {
    ...d,
    pneu_id: pneu.id,
    fogo: pneu.numero_fogo,
  });
  await reply(
    ctx,
    `Montar fogo *${pneu.numero_fogo}* em *${d.placa}* / *${d.posicao}*?\n*1* confirma · *0* cancela`
  );
}

const MARCA_OPCAO = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/** Mesmos atalhos de filtroGrupoCaminhao. Não inclui código nem rótulo do catálogo. */
const GRUPOS_RELATORIO_ANTIGOS = new Set([
  'caminhao',
  'caminhoes',
  'compactadores',
  'caminhao/compactador',
  'caminhao compactador',
  'caminhao_compactador',
]);

const OPCOES_RELATORIO_FIXAS = [
  { id: 'todos', label: 'Todos' },
  { id: 'caminhao_compactador', label: 'Caminhão/Compactador' },
  { id: 'trator', label: 'Trator' },
  { id: 'mini_carregadeira', label: 'Mini carregadeira' },
  { id: 'giro_zero', label: 'Giro zero' },
];

const IDS_RELATORIO_FIXOS = new Set(OPCOES_RELATORIO_FIXAS.map((o) => o.id));

export function opcoesMenuRelatorio() {
  const extras = listarTiposEquipamento()
    .filter((t) => !IDS_RELATORIO_FIXOS.has(t.codigo))
    .map((t) => ({ id: t.codigo, label: t.label }));
  return [...OPCOES_RELATORIO_FIXAS, ...extras];
}

export function textoTiposRelatorio() {
  const linhas = opcoesMenuRelatorio().map((o, i) => {
    const n = i + 1;
    const marca = MARCA_OPCAO[i] || `*${n}*`;
    return `${marca} ${o.label}`;
  });
  return [
    '📊 *Relatório semanal*',
    '',
    'Qual tipo de equipamento?',
    ...linhas,
    '',
    '_2 = grupo: caminhao, caminhoes e caminhao/compactador._',
    '_0️⃣ cancela_',
  ].join('\n');
}

function numeroOpcaoRelatorio(texto) {
  const m = String(texto || '').trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

export function tipoRelatorioDaResposta(texto) {
  const c = norm(texto);
  const n = numeroOpcaoRelatorio(texto);
  const opcoes = opcoesMenuRelatorio();
  if (n) {
    if (n <= opcoes.length) return opcoes[n - 1].id;
    return null;
  }
  if (!c) return null;
  if (/^todos?$|^todas$/.test(c)) return 'todos';
  if (GRUPOS_RELATORIO_ANTIGOS.has(c)) return 'caminhao_compactador';
  const cat = resolverTipoEquipamento(texto);
  if (cat) return cat.codigo;
  if (c === 'mini' || c === 'skid' || c === 'bobcat') return 'mini_carregadeira';
  if (c === 'giro') return 'giro_zero';
  return null;
}

async function pedirTipoRelatorio(ctx) {
  await setFluxo(ctx, 'relatorio', 'tipo', {});
  await reply(ctx, textoTiposRelatorio(), 'relatorio_semanal');
}

async function passoTipoRelatorio(ctx, texto) {
  const tipo = tipoRelatorioDaResposta(texto);
  if (!tipo) {
    await reply(ctx, `Não entendi o tipo.\n\n${textoTiposRelatorio()}`, 'relatorio_semanal');
    return;
  }
  await clear(ctx);
  await enviarRelatorio(ctx, tipo);
}

async function enviarRelatorio(ctx, tipo = 'todos') {
  const filtro = resolverFiltroRelatorio(tipo);
  await reply(ctx, `📊 Gerando o *relatório* de *${filtro.label}*… aguarde alguns segundos.`, 'relatorio_semanal');
  try {
    const { buffer, filename, dados } = await gerarRelatorioSemanalPdfBuffer(ctx.filialId, {
      geradoPor: `WhatsApp · ${ctx.phone || ctx.destino}`,
      tipo: filtro.id,
    });
    const resumo = dados?.resumo || {};
    const caption = [
      `📊 *${dados.titulo || 'Relatório semanal'}* — ${dados.filial?.nome || 'Unidade'}`,
      `Tipo: ${dados.filtro_label || filtro.label}`,
      dados.periodo?.label ? `Semana: ${dados.periodo.label}` : null,
      `Montados: ${resumo.pneus_montados ?? 0} · Estoque: ${resumo.pneus_estoque ?? 0} · Em recap: ${resumo.pneus_em_recapagem ?? 0}`,
      `Críticos: ${resumo.sulco_critico ?? 0} · Monitorar: ${resumo.sulco_monitorar ?? 0} · Mov. na semana: ${resumo.movimentacoes_semana ?? 0}`,
      '',
      '_Digite *menu* para voltar._',
    ].filter(Boolean).join('\n');

    // Envia o PDF primeiro (mais confiável que texto + doc)
    const envio = await enviarDocumentoERegistrar({
      tipo: 'relatorio_semanal',
      destinatario: ctx.destino,
      buffer,
      fileName: filename,
      mensagem: caption,
      caption: `📊 ${dados.filtro_label || filtro.label} — ${dados.filial?.nome || 'Unidade'} (${dados.periodo?.label || ''})`.trim(),
      filialId: ctx.filialId,
      fallbackDestinatario: ctx.phone,
    });
    if (!envio?.ok) {
      await reply(
        ctx,
        `❌ Não consegui enviar o PDF (${envio?.erro || 'erro desconhecido'}).\n\nBaixe pelo painel: Filiais → unidade → *Baixar PDF semanal*.\n\n` + textoMenu(),
        'relatorio_semanal'
      );
      return;
    }
    await reply(ctx, `✅ PDF enviado.\n\n${caption}`, 'relatorio_semanal');
  } catch (err) {
    console.error('[whatsapp-menu] relatório:', err);
    await reply(ctx, `❌ Falha ao gerar/enviar relatório: ${err.message}\n\n` + textoMenu(), 'relatorio_semanal');
  }
}

async function enviarFrota(ctx) {
  const rows = await ops.listarFrota(ctx.filialId);
  if (!rows.length) {
    await reply(ctx, '📋 Nenhum veículo nesta unidade.\n\nDigite *2* para cadastrar ou *menu*.');
    return;
  }
  const linhas = rows.map((v) => {
    const apelido = v.apelido ? ` — ${v.apelido}` : '';
    const sulco = v.menor_sulco != null ? `${v.menor_sulco} mm` : 'sem medicao';
    return `• *${v.placa}*${apelido} — ${sulco} · ${v.status_label || '-'}`;
  });
  await reply(ctx, `🚛 *Frota visual* (${rows.length}):\n${linhas.join('\n')}\n\nEnvie a *placa* para medir, *8* para o PDF visual, ou *menu*.`);
}

async function iniciarOpcao(ctx, n) {
  switch (n) {
    case '1':
      await setFluxo(ctx, 'medir', 'placa', {});
      await reply(ctx, '📏 Envie a *placa* (ou as medições: *1E 14,14,14*).\n*0* cancela');
      return;
    case '2':
      await clear(ctx);
      await enviarLinkCadastro(ctx, 'cadastrar_veiculo');
      return;
    case '3':
      await clear(ctx);
      await enviarLinkCadastro(ctx, 'cadastrar_pneu');
      return;
    case '4':
      await setFluxo(ctx, 'troca_link', 'placa', {});
      await reply(ctx, '🔄 *Trocar / montar*\n\nEnvie a *placa* do caminhão.\n_0 = cancelar_');
      return;
    case '5':
      if (!await exigirParticipanteGrupo(ctx, 'a movimentação')) return;
      await setFluxo(ctx, 'estoque', 'fogo', {});
      await reply(ctx, '📦 *Enviar ao estoque*\n\nEnvie o *nº de fogo* do pneu montado.\n_0 = cancelar_');
      return;
    case '6':
      if (!await exigirParticipanteGrupo(ctx, 'a movimentação')) return;
      await setFluxo(ctx, 'recap', 'fogo', {});
      await reply(ctx, '♻️ *Recap*\n\nEnvie o *nº de fogo*.\n(Se já estiver em recap, você poderá devolver ao estoque.)\n_0 = cancelar_');
      return;
    case '7':
      if (!await exigirParticipanteGrupo(ctx, 'a movimentação')) return;
      await setFluxo(ctx, 'descarte', 'fogo', {});
      await reply(ctx, '🗑️ *Descarte*\n\nEnvie o *nº de fogo*.\n_0 = cancelar_');
      return;
    case '8':
      await pedirTipoRelatorio(ctx);
      return;
    case '9':
      await clear(ctx);
      await enviarFrota(ctx);
      return;
    default:
      await reply(ctx, textoMenu());
  }
}

async function passoEstoque(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };

  if (sessao.passo === 'confirma') {
    const decisao = decisaoConfirmacao(texto);
    if (decisao === 'cancela') {
      await clear(ctx);
      await reply(ctx, 'Cancelado. Nada foi alterado.');
      return;
    }
    if (decisao !== 'confirma') {
      await reply(ctx, '*1* confirma · *0* cancela');
      return;
    }
    const r = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['estoque'],
      executar: (auditoria) => ops.trocarPorEstoque({
        filialId: ctx.filialId,
        pneuMontadoId: d.pneu_id,
        pneuEstoqueId: d.substituto_id,
        auditoria,
      }),
    });
    if (!r) return;
    await reply(
      ctx,
      `✅ ${r.mensagem || `Fogo *${d.fogo}* foi para o estoque.`}\nFogo *${d.substituto_fogo}* montado em *${d.placa}* (${d.posicao}).\n\n` + textoMenu()
    );
    return;
  }

  if (sessao.passo === 'substituto') {
    if (await recusarFogoInvalido(ctx, texto)) return;
    const sub = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
    if (!sub || sub.status_pneu !== 'estoque') {
      await reply(ctx, 'Fogo não encontrado no *estoque*. Envie outro nº ou *0* (o pneu original permanece montado).');
      return;
    }
    try {
      await ops.validarSubstitutoEstoque({
        filialId: ctx.filialId,
        pneuEstoqueId: sub.id,
        veiculoId: d.veiculo_id,
        posicao: d.posicao,
      });
      await setFluxo(ctx, 'estoque', 'confirma', {
        ...d,
        substituto_id: sub.id,
        substituto_fogo: sub.numero_fogo,
      });
      await reply(
        ctx,
        `Enviar *${d.fogo}* ao estoque e montar *${sub.numero_fogo}* em *${d.placa}* / *${d.posicao}*?\n*1* confirma · *0* cancela`
      );
    } catch (err) {
      await reply(ctx, `❌ ${err.message}\nEnvie outro nº de fogo ou *0* (original permanece montado).`);
    }
    return;
  }

  if (await recusarFogoInvalido(ctx, texto)) return;
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
  if (!pneu) {
    await reply(ctx, 'Pneu não encontrado. Envie o nº de fogo ou *0*.');
    return;
  }
  if (pneu.status_pneu === 'estoque') {
    await clear(ctx);
    await reply(ctx, `Fogo *${pneu.numero_fogo}* já está no estoque.\n\n` + textoMenu());
    return;
  }
  if (pneu.status_pneu !== 'montado') {
    await clear(ctx);
    await reply(ctx, `Fogo *${pneu.numero_fogo}* está em *${pneu.status_pneu}* — não dá para enviar ao estoque assim.\n\n` + textoMenu());
    return;
  }
  await pedirSubstitutoObrigatorio(ctx, {
    fluxo: 'estoque',
    passo: 'substituto',
    dados: {
      pneu_id: pneu.id,
      fogo: pneu.numero_fogo,
      veiculo_id: pneu.veiculo_id,
      posicao: pneu.posicao,
      placa: pneu.placa,
    },
    titulo: `📦 Fogo *${pneu.numero_fogo}* será enviado ao estoque`,
    placa: pneu.placa,
    posicao: pneu.posicao,
  });
}

async function passoRecap(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };

  if (sessao.passo === 'confirma') {
    const decisao = decisaoConfirmacao(texto);
    if (decisao === 'cancela') {
      await clear(ctx);
      await reply(ctx, 'Cancelado. Nada foi alterado.');
      return;
    }
    if (decisao !== 'confirma') {
      await reply(ctx, '*1* confirma · *0* cancela');
      return;
    }
    const r = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['recap'],
      executar: (auditoria) => ops.registrarRecap({
        filialId: ctx.filialId,
        pneuId: d.pneu_id,
        pneuEstoqueId: d.substituto_id || null,
        auditoria,
      }),
    });
    if (!r) return;
    const lembrete = `\n\nQuando o recap voltar: digite *6* e o fogo *${r.fogo}* → opção *devolver ao estoque*.`;
    const montou = r.substituto
      ? `\nFogo *${r.substituto.fogo}* montado em *${r.substituto.placa}* (${r.substituto.posicao}).`
      : '';
    await reply(ctx, `✅ Fogo *${r.fogo}* em recapagem (${r.vida}ª vida).${montou}${lembrete}\n\n` + textoMenu());
    return;
  }

  if (sessao.passo === 'substituto') {
    if (await recusarFogoInvalido(ctx, texto)) return;
    const sub = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
    if (!sub || sub.status_pneu !== 'estoque') {
      await reply(ctx, 'Fogo não encontrado no *estoque*. Envie outro nº ou *0* (o pneu original permanece montado).');
      return;
    }
    try {
      await ops.validarSubstitutoEstoque({
        filialId: ctx.filialId,
        pneuEstoqueId: sub.id,
        veiculoId: d.veiculo_id,
        posicao: d.posicao,
      });
      await setFluxo(ctx, 'recap', 'confirma', {
        ...d,
        substituto_id: sub.id,
        substituto_fogo: sub.numero_fogo,
      });
      await reply(
        ctx,
        `Enviar *${d.fogo}* à recap e montar *${sub.numero_fogo}* em *${d.placa}* / *${d.posicao}*?\n*1* confirma · *0* cancela`
      );
    } catch (err) {
      await reply(ctx, `❌ ${err.message}\nEnvie outro nº de fogo ou *0* (original permanece montado).`);
    }
    return;
  }

  if (sessao.passo === 'devolver') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Ok.\n\n' + textoMenu());
      return;
    }
    if (sn !== true) {
      await reply(ctx, 'Responda *1* para devolver ao estoque ou *0* para cancelar.');
      return;
    }
    const r = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['recap'],
      passos: ['devolver'],
      executar: (auditoria) => ops.devolverRecapAoEstoque({
        filialId: ctx.filialId,
        pneuId: d.pneu_id,
        auditoria,
      }),
    });
    if (!r) return;
    await reply(ctx, `✅ ${r.mensagem}\nPronto para montar nos caminhões (*4*).\n\n` + textoMenu());
    return;
  }

  if (await recusarFogoInvalido(ctx, texto)) return;
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
  if (!pneu) {
    await reply(ctx, 'Pneu não encontrado. Envie o nº de fogo ou *0*.');
    return;
  }

  if (pneu.status_pneu === 'recapagem') {
    await setFluxo(ctx, 'recap', 'devolver', { pneu_id: pneu.id, fogo: pneu.numero_fogo });
    await reply(
      ctx,
      [
        `♻️ Fogo *${pneu.numero_fogo}* já está em *recapagem* (${pneu.vida_recap || 1}ª vida).`,
        '',
        '*1* — Devolver ao estoque (recap pronto para uso)',
        '*0* — Cancelar',
      ].join('\n')
    );
    return;
  }

  if (pneu.status_pneu === 'descarte') {
    await clear(ctx);
    await reply(ctx, `❌ Fogo *${pneu.numero_fogo}* já está no descarte.\n\n` + textoMenu());
    return;
  }

  if (pneu.status_pneu === 'montado' && pneu.veiculo_id && pneu.posicao) {
    await pedirSubstitutoObrigatorio(ctx, {
      fluxo: 'recap',
      passo: 'substituto',
      dados: {
        pneu_id: pneu.id,
        fogo: pneu.numero_fogo,
        veiculo_id: pneu.veiculo_id,
        posicao: pneu.posicao,
        placa: pneu.placa,
      },
      titulo: `♻️ Fogo *${pneu.numero_fogo}* será enviado à recap`,
      placa: pneu.placa,
      posicao: pneu.posicao,
    });
    return;
  }

  await setFluxo(ctx, 'recap', 'confirma', { pneu_id: pneu.id, fogo: pneu.numero_fogo });
  await reply(ctx, `Enviar fogo *${pneu.numero_fogo}* à recapagem?\n*1* confirma · *0* cancela`);
}

async function passoDescarte(ctx, sessao, texto) {
  if (sessao.passo === 'substituto') {
    const d = { ...(sessao.dados || {}) };
    if (await recusarFogoInvalido(ctx, texto)) return;
    const sub = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
    if (!sub || sub.status_pneu !== 'estoque') {
      await reply(ctx, 'Fogo não encontrado no *estoque*. Envie outro nº ou *0* (o pneu original permanece montado).');
      return;
    }
    try {
      await ops.validarSubstitutoEstoque({
        filialId: ctx.filialId,
        pneuEstoqueId: sub.id,
        veiculoId: d.veiculo_id,
        posicao: d.posicao,
      });
      await setFluxo(ctx, 'descarte', 'confirma', {
        ...d,
        substituto_id: sub.id,
        substituto_fogo: sub.numero_fogo,
      });
      await reply(
        ctx,
        `⚠️ Descartar fogo *${d.fogo}* e montar *${sub.numero_fogo}* em *${d.placa}* / *${d.posicao}*?\nMotivo: ${d.motivo || '—'}\n\n*1* Sim · *0* Não (original permanece montado)`
      );
    } catch (err) {
      await reply(ctx, `❌ ${err.message}\nEnvie outro nº de fogo ou *0* (original permanece montado).`);
    }
    return;
  }

  if (sessao.passo === 'confirma') {
    const d = { ...(sessao.dados || {}) };
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Cancelado.\n\n' + textoMenu());
      return;
    }
    if (sn !== true) {
      await reply(ctx, 'Responda *1* ou *0*.');
      return;
    }
    if (!motivoDescarteValido(d.motivo)) {
      await setFluxo(ctx, 'descarte', 'motivo', d);
      await reply(ctx, 'Informe o motivo do descarte. Não use `-` nem deixe em branco.');
      return;
    }
    const r = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['descarte'],
      executar: (auditoria) => ops.registrarDescarte({
        filialId: ctx.filialId,
        pneuId: d.pneu_id,
        motivo: d.motivo,
        pneuEstoqueId: d.substituto_id || null,
        auditoria,
      }),
    });
    if (!r) return;
    const montou = r.substituto
      ? `\nFogo *${r.substituto.fogo}* montado em *${r.substituto.placa}* (${r.substituto.posicao}).`
      : '';
    await reply(ctx, `✅ Fogo *${r.fogo}* no descarte.${montou}\n\n` + textoMenu());
    return;
  }

  if (sessao.passo === 'motivo') {
    const d = { ...(sessao.dados || {}) };
    if (!motivoDescarteValido(texto)) {
      await reply(ctx, 'Informe o motivo do descarte. Não use `-` nem deixe em branco.');
      return;
    }
    d.motivo = String(texto).trim();
    if (d.estava_montado && d.veiculo_id && d.posicao) {
      await pedirSubstitutoObrigatorio(ctx, {
        fluxo: 'descarte',
        passo: 'substituto',
        dados: d,
        titulo: `🗑️ Descarte de fogo *${d.fogo}*`,
        placa: d.placa,
        posicao: d.posicao,
      });
      return;
    }
    await setFluxo(ctx, 'descarte', 'confirma', d);
    await reply(ctx, `⚠️ Descartar fogo *${d.fogo}*?\nMotivo: ${d.motivo || '—'}\n\n*1* Sim · *0* Não`);
    return;
  }

  if (await recusarFogoInvalido(ctx, texto)) return;
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
  if (!pneu) {
    await reply(ctx, 'Pneu não encontrado. Envie o nº de fogo ou *0*.');
    return;
  }
  await setFluxo(ctx, 'descarte', 'motivo', {
    pneu_id: pneu.id,
    fogo: pneu.numero_fogo,
    estava_montado: pneu.status_pneu === 'montado' && !!pneu.veiculo_id,
    veiculo_id: pneu.veiculo_id || null,
    posicao: pneu.posicao || null,
    placa: pneu.placa || null,
  });
  await reply(ctx, 'Motivo do descarte? (obrigatório)');
}

function resumoOnde(p) {
  if (p.status_pneu === 'montado') return `montado em *${p.placa || '?'}* (${p.posicao || '?'})`;
  if (p.status_pneu === 'recapagem') return 'em recapagem';
  if (p.status_pneu === 'descarte') return 'no descarte';
  return 'no estoque';
}

function tituloAcaoNatural(tipo, pneu) {
  if (tipo === 'descarte') return `🗑️ Descarte de *${pneu.numero_fogo}*`;
  if (tipo === 'recap') return `♻️ Recap de *${pneu.numero_fogo}*`;
  if (tipo === 'estoque') return `📦 *${pneu.numero_fogo}* → estoque`;
  return `🔄 Troca de *${pneu.numero_fogo}*`;
}

function textoConfirmaNatural(tipo, d) {
  const sub = d.substituto_fogo
    ? ` e montar *${d.substituto_fogo}* em *${d.placa}* / *${d.posicao}*`
    : '';
  if (tipo === 'descarte') return `Descartar *${d.fogo}*${sub}?\nMotivo: ${d.motivo}\n*1* Sim · *0* Não`;
  if (tipo === 'recap') return `Enviar *${d.fogo}* à recap${sub}?\n*1* Sim · *0* Não`;
  if (tipo === 'estoque' || tipo === 'troca') {
    return `Enviar *${d.fogo}* ao estoque e montar *${d.substituto_fogo}* em *${d.placa}* / *${d.posicao}*?\n*1* Sim · *0* Não`;
  }
  return `Confirmar?\n*1* Sim · *0* Não`;
}

async function executarComandoNatural(ctx, d, auditoria) {
  const filialId = ctx.filialId;
  if (d.tipo === 'recap') {
    const r = await ops.registrarRecap({
      filialId,
      pneuId: d.pneu_id,
      pneuEstoqueId: d.substituto_id || null,
      auditoria,
    });
    const extra = r.substituto ? ` *${r.substituto.fogo}* em ${r.substituto.placa} (${r.substituto.posicao}).` : '';
    return `✅ *${r.fogo}* em recapagem (${r.vida}ª vida).${extra}`;
  }
  if (d.tipo === 'descarte') {
    if (!motivoDescarteValido(d.motivo)) {
      throw new Error('Informe o motivo do descarte');
    }
    const r = await ops.registrarDescarte({
      filialId,
      pneuId: d.pneu_id,
      motivo: d.motivo,
      pneuEstoqueId: d.substituto_id || null,
      auditoria,
    });
    const extra = r.substituto ? ` *${r.substituto.fogo}* em ${r.substituto.placa} (${r.substituto.posicao}).` : '';
    return `✅ *${r.fogo}* no descarte.${extra}`;
  }
  if (d.tipo === 'estoque' || d.tipo === 'troca') {
    const r = await ops.trocarPorEstoque({
      filialId,
      pneuMontadoId: d.pneu_id,
      pneuEstoqueId: d.substituto_id,
      auditoria,
    });
    return `✅ ${r.mensagem}`;
  }
  throw new Error('Ação inválida');
}

async function iniciarAcaoNatural(ctx, tipo, pneu, extra = {}) {
  if (tipo === 'onde') {
    await clear(ctx);
    const detalhe = await ops.textoConsultaFogo(ctx.filialId, pneu.numero_fogo);
    await reply(ctx, detalhe || `🛞 *${pneu.numero_fogo}* — ${resumoOnde(pneu)}`);
    return;
  }
  if (tipo === 'descarte' && !motivoDescarteValido(extra.motivo)) {
    await setFluxo(ctx, 'cmd_natural', 'motivo', {
      tipo,
      pneu_id: pneu.id,
      fogo: pneu.numero_fogo,
      veiculo_id: pneu.veiculo_id || null,
      posicao: pneu.posicao || null,
      placa: pneu.placa || null,
      substituto_id: extra.substituto?.id || null,
      substituto_fogo: extra.substituto?.numero_fogo || null,
    });
    await reply(ctx, 'Motivo do descarte? (obrigatório)');
    return;
  }
  if (tipo === 'recap' && pneu.status_pneu === 'recapagem') {
    await setFluxo(ctx, 'cmd_natural', 'devolver', {
      tipo, pneu_id: pneu.id, fogo: pneu.numero_fogo,
    });
    await reply(ctx, `♻️ *${pneu.numero_fogo}* já está em recapagem.\n*1* devolver ao estoque · *0* cancelar`);
    return;
  }
  if (tipo === 'estoque' && pneu.status_pneu === 'estoque') {
    await clear(ctx);
    await reply(ctx, `*${pneu.numero_fogo}* já está no estoque.`);
    return;
  }

  const montado = pneu.status_pneu === 'montado' && pneu.veiculo_id && pneu.posicao;
  if ((tipo === 'estoque' || tipo === 'troca' || tipo === 'recap' || tipo === 'descarte') && montado) {
    if (extra.substituto) {
      try {
        await ops.validarSubstitutoEstoque({
          filialId: ctx.filialId,
          pneuEstoqueId: extra.substituto.id,
          veiculoId: pneu.veiculo_id,
          posicao: pneu.posicao,
        });
      } catch (err) {
        await reply(ctx, `❌ ${err.message}\nEnvie outro fogo ou *0*.`);
        await setFluxo(ctx, 'cmd_natural', 'substituto', {
          tipo,
          pneu_id: pneu.id,
          fogo: pneu.numero_fogo,
          veiculo_id: pneu.veiculo_id,
          posicao: pneu.posicao,
          placa: pneu.placa,
          motivo: extra.motivo || null,
        });
        return;
      }
      const dados = {
        tipo,
        pneu_id: pneu.id,
        fogo: pneu.numero_fogo,
        veiculo_id: pneu.veiculo_id,
        posicao: pneu.posicao,
        placa: pneu.placa,
        motivo: extra.motivo || null,
        substituto_id: extra.substituto.id,
        substituto_fogo: extra.substituto.numero_fogo,
      };
      await setFluxo(ctx, 'cmd_natural', 'confirma', dados);
      await reply(ctx, textoConfirmaNatural(tipo, dados));
      return;
    }
    await pedirSubstitutoObrigatorio(ctx, {
      fluxo: 'cmd_natural',
      passo: 'substituto',
      dados: {
        tipo,
        pneu_id: pneu.id,
        fogo: pneu.numero_fogo,
        veiculo_id: pneu.veiculo_id,
        posicao: pneu.posicao,
        placa: pneu.placa,
        motivo: extra.motivo || null,
      },
      titulo: tituloAcaoNatural(tipo, pneu),
      placa: pneu.placa,
      posicao: pneu.posicao,
    });
    return;
  }

  if (tipo === 'troca' || tipo === 'estoque') {
    await clear(ctx);
    await reply(ctx, `*${pneu.numero_fogo}* não está montado (${pneu.status_pneu}).`);
    return;
  }

  const dados = { tipo, pneu_id: pneu.id, fogo: pneu.numero_fogo, motivo: extra.motivo || null };
  await setFluxo(ctx, 'cmd_natural', 'confirma', dados);
  await reply(ctx, textoConfirmaNatural(tipo, dados));
}

async function pedirEscolhaPneus(ctx, dados, lista) {
  await setFluxo(ctx, 'cmd_natural', 'escolher', {
    ...dados,
    candidatos: lista.slice(0, 8).map((p) => ({
      id: p.id,
      fogo: p.numero_fogo,
      status_pneu: p.status_pneu,
      placa: p.placa,
      posicao: p.posicao,
      veiculo_id: p.veiculo_id,
    })),
  });
  const linhas = lista.slice(0, 8).map((p, i) => `*${i + 1}* ${p.numero_fogo} — ${resumoOnde(p)}`);
  await reply(ctx, `Vários pneus. Qual?\n${linhas.join('\n')}\n\nNúmero ou fogo. *0* cancela.`);
}

async function resolverEIniciarComando(ctx, tipo, fogo, fogo2) {
  if (tipo !== 'onde') {
    const participante = await exigirParticipanteGrupo(ctx, 'a movimentação');
    if (!participante) return;
  }
  const lista = await ops.buscarPneusPorFogo(ctx.filialId, fogo);
  if (!lista.length) {
    await reply(ctx, `Pneu *${fogo}* não encontrado nesta unidade.`);
    return;
  }
  if (lista.length > 1) {
    await pedirEscolhaPneus(ctx, { tipo, fogo2: fogo2 || null }, lista);
    return;
  }
  let sub = null;
  if (fogo2) {
    const subs = await ops.buscarPneusPorFogo(ctx.filialId, fogo2);
    if (!subs.length) {
      await reply(ctx, `Substituto *${fogo2}* não encontrado nesta unidade.`);
      return;
    }
    if (subs.length > 1) {
      await pedirEscolhaPneus(ctx, {
        tipo,
        pneu_alvo: {
          id: lista[0].id,
          numero_fogo: lista[0].numero_fogo,
          status_pneu: lista[0].status_pneu,
          placa: lista[0].placa,
          posicao: lista[0].posicao,
          veiculo_id: lista[0].veiculo_id,
        },
        escolher: 'substituto',
      }, subs);
      return;
    }
    sub = subs[0];
  }
  await iniciarAcaoNatural(ctx, tipo, lista[0], { substituto: sub });
}

async function passoComandoNatural(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };

  if (sessao.passo === 'motivo') {
    if (!motivoDescarteValido(texto)) {
      await reply(ctx, 'Informe o motivo do descarte. Não use `-` nem deixe em branco.');
      return;
    }
    const pneu = await ops.buscarPneuPorFogo(ctx.filialId, d.fogo);
    if (!pneu) {
      await clear(ctx);
      await reply(ctx, 'Pneu não encontrado.');
      return;
    }
    const substituto = d.substituto_id
      ? { id: d.substituto_id, numero_fogo: d.substituto_fogo }
      : null;
    await iniciarAcaoNatural(ctx, d.tipo, pneu, { motivo: String(texto).trim(), substituto });
    return;
  }

  if (sessao.passo === 'escolher') {
    const cands = d.candidatos || [];
    const n = soNumero(texto);
    let escolhido = null;
    if (n && Number(n) >= 1 && Number(n) <= cands.length) {
      escolhido = cands[Number(n) - 1];
    } else {
      const hits = await ops.buscarPneusPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
      if (hits.length === 1) escolhido = hits[0];
      else if (hits.length > 1) {
        await pedirEscolhaPneus(ctx, d, hits);
        return;
      }
    }
    if (!escolhido) {
      await reply(ctx, 'Não achei. Envie o número da lista, o fogo ou *0*.');
      return;
    }
    const fogoEsc = escolhido.fogo || escolhido.numero_fogo;
    const full = (fogoEsc && await ops.buscarPneuPorFogo(ctx.filialId, fogoEsc)) || escolhido;
    const row = {
      ...full,
      numero_fogo: full.numero_fogo || fogoEsc,
    };
    if (d.escolher === 'substituto' && d.pneu_alvo) {
      await iniciarAcaoNatural(ctx, d.tipo, d.pneu_alvo, { substituto: row, motivo: d.motivo });
      return;
    }
    let sub = null;
    if (d.fogo2) {
      const subs = await ops.buscarPneusPorFogo(ctx.filialId, d.fogo2);
      if (subs.length === 1) sub = subs[0];
      else if (subs.length > 1) {
        await pedirEscolhaPneus(ctx, {
          tipo: d.tipo,
          pneu_alvo: row,
          escolher: 'substituto',
        }, subs);
        return;
      }
    }
    await iniciarAcaoNatural(ctx, d.tipo, row, { substituto: sub, motivo: d.motivo });
    return;
  }

  if (sessao.passo === 'substituto') {
    if (await recusarFogoInvalido(ctx, texto)) return;
    const busca = String(texto).replace(/^fogo\s+/i, '').trim();
    const hits = await ops.buscarPneusPorFogo(ctx.filialId, busca);
    if (hits.length > 1) {
      await pedirEscolhaPneus(ctx, { ...d, escolher: 'substituto', pneu_alvo: {
        id: d.pneu_id,
        numero_fogo: d.fogo,
        status_pneu: 'montado',
        placa: d.placa,
        posicao: d.posicao,
        veiculo_id: d.veiculo_id,
      } }, hits);
      return;
    }
    const sub = hits[0];
    if (!sub || sub.status_pneu !== 'estoque') {
      await reply(ctx, 'Fogo não encontrado no *estoque*. Outro nº ou *0*.');
      return;
    }
    try {
      await ops.validarSubstitutoEstoque({
        filialId: ctx.filialId,
        pneuEstoqueId: sub.id,
        veiculoId: d.veiculo_id,
        posicao: d.posicao,
      });
      const dados = { ...d, substituto_id: sub.id, substituto_fogo: sub.numero_fogo };
      await setFluxo(ctx, 'cmd_natural', 'confirma', dados);
      await reply(ctx, textoConfirmaNatural(d.tipo, dados));
    } catch (err) {
      await reply(ctx, `❌ ${err.message}\nOutro nº ou *0*.`);
    }
    return;
  }

  if (sessao.passo === 'devolver') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Ok.');
      return;
    }
    if (sn !== true) {
      await reply(ctx, '*1* devolver · *0* cancelar');
      return;
    }
    const r = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['cmd_natural'],
      passos: ['devolver'],
      executar: (auditoria) => ops.devolverRecapAoEstoque({
        filialId: ctx.filialId,
        pneuId: d.pneu_id,
        auditoria,
      }),
    });
    if (!r) return;
    await reply(ctx, `✅ ${r.mensagem}`);
    return;
  }

  if (sessao.passo === 'confirma') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Cancelado. Nada foi alterado.');
      return;
    }
    if (sn !== true) {
      const talvezFogo = String(texto).replace(/^fogo\s+/i, '').trim();
      const hits = await ops.buscarPneusPorFogo(ctx.filialId, talvezFogo);
      if (hits.length === 1 && d.veiculo_id) {
        try {
          await ops.validarSubstitutoEstoque({
            filialId: ctx.filialId,
            pneuEstoqueId: hits[0].id,
            veiculoId: d.veiculo_id,
            posicao: d.posicao,
          });
          const dados = { ...d, substituto_id: hits[0].id, substituto_fogo: hits[0].numero_fogo };
          await setFluxo(ctx, 'cmd_natural', 'confirma', dados);
          await reply(ctx, textoConfirmaNatural(d.tipo, dados));
          return;
        } catch (err) {
          await reply(ctx, `❌ ${err.message}\n*1* confirma · *0* cancela`);
          return;
        }
      }
      await reply(ctx, '*1* confirma · *0* cancela');
      return;
    }
    const msg = await gravarMovimentacaoConfirmada(ctx, {
      fluxos: ['cmd_natural'],
      executar: (auditoria) => executarComandoNatural(ctx, d, auditoria),
    });
    if (!msg) return;
    await reply(ctx, msg);
  }
}

async function responderConsulta(ctx, consulta) {
  if (consulta.tipo === 'estoque') {
    await reply(ctx, await ops.textoEstoqueUnidade(ctx.filialId, consulta.busca));
    return;
  }
  if (consulta.tipo === 'placa') {
    await reply(ctx, await ops.textoConsultaPlaca(ctx.filialId, consulta.placa));
    return;
  }
  const direto = await ops.textoConsultaFogo(ctx.filialId, consulta.fogo);
  if (direto) {
    await reply(ctx, direto);
    return;
  }
  const hits = await ops.buscarPneusPorFogo(ctx.filialId, consulta.fogo);
  if (hits.length === 1) {
    await reply(ctx, await ops.textoConsultaFogo(ctx.filialId, hits[0].numero_fogo));
    return;
  }
  if (hits.length > 1) {
    const linhas = hits.slice(0, 8).map((p) => `• *${p.numero_fogo}* — ${resumoOnde(p)}`);
    await reply(ctx, `Vários pneus:\n${linhas.join('\n')}\nEnvie *consultar fogo* com o número completo.`);
    return;
  }
  await reply(ctx, `Pneu *${consulta.fogo}* não encontrado nesta unidade.`);
}

async function atalhoFogo(ctx, texto) {
  const fogo = String(texto).replace(/^fogo\s+/i, '').trim();
  const detalhe = await ops.textoConsultaFogo(ctx.filialId, fogo);
  if (!detalhe) return false;
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, fogo);

  const linhas = [
    detalhe,
    '',
  ];
  if (pneu.status_pneu === 'recapagem') {
    linhas.push('*6* de novo neste fogo → devolver ao estoque');
  } else {
    linhas.push('*4* Trocar · *5* Estoque · *6* Recap · *7* Descarte');
  }
  linhas.push('*0* / *menu*');
  await reply(ctx, linhas.filter(Boolean).join('\n'));
  return true;
}

async function continuarSessao(ctx, sessao, texto) {
  try {
    if (
      sessao.fluxo !== 'cmd_natural'
      && sessao.fluxo !== 'pre_cadastro'
      && parseComandoNatural(texto)
    ) {
      await reply(ctx, 'Você está no meio de uma operação. Envie o que foi pedido, *0* para cancelar ou *menu*.');
      return;
    }
    switch (sessao.fluxo) {
      case 'medir':
        return await fluxoMedirPlaca(ctx, texto);
      case 'troca_link':
        return await fluxoTrocaPlaca(ctx, texto);
      case 'estoque':
        return await passoEstoque(ctx, sessao, texto);
      case 'recap':
        return await passoRecap(ctx, sessao, texto);
      case 'descarte':
        return await passoDescarte(ctx, sessao, texto);
      case 'montar_pos':
        return await passoMontarPos(ctx, sessao, texto);
      case 'cmd_natural':
        return await passoComandoNatural(ctx, sessao, texto);
      case 'pre_cadastro':
        return await passoPreCadastro(ctx, sessao, texto);
      case 'cadastro_pneu':
        return await passoCadastroPneu(ctx, sessao, texto);
      case 'medir_wa':
        return await passoMedicaoWhatsApp(ctx, sessao, texto);
      case 'relatorio':
        return await passoTipoRelatorio(ctx, texto);
      default:
        await clear(ctx);
        await reply(ctx, textoMenu());
    }
  } catch (err) {
    console.error('[whatsapp-menu] fluxo', sessao.fluxo, sessao.passo, err);
    await clear(ctx);
    await reply(ctx, `❌ Erro no fluxo: ${err.message}\n\n` + textoMenu());
  }
}

/**
 * @returns {{ handled: boolean }}
 */
export async function processarMensagemMenu(ctx) {
  const texto = String(ctx.texto || '').trim();
  if (!texto) return { handled: false };

  const unidade = await resolverUnidadeOficial(ctx.chatJid);
  if (!unidade) {
    await reply(ctx, 'Este grupo não está vinculado a uma unidade ativa.');
    return { handled: true, bloqueado: 'grupo' };
  }
  ctx.filialId = unidade.id;
  ctx.unidadeNome = unidade.nome;
  ctx.grupoOficial = String(unidade.whatsapp_grupo).trim();

  const cmd = norm(texto);
  const filialId = ctx.filialId;

  if (comandoDuplicado(ctx)) {
    console.info('[whatsapp-menu] duplicada ignorada', {
      filial: filialId,
      id: ctx.mensagemId || null,
      texto: texto.slice(0, 40),
    });
    return { handled: true, duplicado: true };
  }

  if (ehCancelar(cmd) || ehMenu(cmd)) {
    await clear(ctx);
    await reply(ctx, textoMenu());
    return { handled: true };
  }

  if (operacaoExigeRemetente(texto)) {
    const phone = telefoneConfiavel(ctx.phone);
    if (!phone || await telefoneEhDoChatbot(phone, unidade.whatsapp)) {
      await reply(ctx, 'Não identifiquei seu número neste grupo. Não gravei nada.');
      return { handled: true, bloqueado: 'remetente' };
    }
  }

  const sessao = await obterSessao(filialId, ctx.phone, ctx.chatJid);
  if (sessao) {
    await continuarSessao(ctx, sessao, texto);
    return { handled: true };
  }

  const n = soNumero(texto);
  if (n !== null) {
    if (n === '0') {
      await reply(ctx, textoMenu());
      return { handled: true };
    }
    try {
      await iniciarOpcao(ctx, n);
    } catch (err) {
      console.error('[whatsapp-menu] opcao', n, err);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
    return { handled: true };
  }

  if (/^(relatorio|report|pdf)\b/i.test(cmd)) {
    await pedirTipoRelatorio(ctx);
    return { handled: true };
  }
  if (/^(frota|placas|lista)\b/i.test(cmd)) {
    await enviarFrota(ctx);
    return { handled: true };
  }

  const consulta = parseConsultaWhatsApp(texto);
  if (consulta) {
    await responderConsulta(ctx, consulta);
    return { handled: true };
  }

  const medicao = parseMedicaoWhatsApp(texto);
  if (medicao) {
    try {
      await iniciarMedicaoWhatsApp(ctx, medicao);
    } catch (err) {
      console.error('[whatsapp-menu] medicao', err);
      await reply(ctx, `❌ ${err.message}`);
    }
    return { handled: true };
  }

  const natural = parseComandoNatural(texto);
  if (natural) {
    try {
      if (natural.tipo === 'cadastrar_veiculo' || natural.tipo === 'cadastrar_pneu') {
        await iniciarPreCadastro(ctx, natural);
      } else {
        await resolverEIniciarComando(ctx, natural.tipo, natural.fogo, natural.fogo2);
      }
    } catch (err) {
      console.error('[whatsapp-menu] comando natural', err);
      await reply(ctx, `❌ ${err.message}`);
    }
    return { handled: true };
  }

  if (parecePlacaBrasil(texto) || parecePlacaOperacional(texto)) {
    const r = await resolverVeiculoPorTexto(filialId, texto);
    if (r.ok || r.motivo === 'varias' || r.motivo === 'nao_encontrada') {
      await fluxoMedirPlaca(ctx, texto);
      return { handled: true };
    }
  }

  if (pareceFogoAvulso(texto)) {
    const ok = await atalhoFogo(ctx, texto);
    if (ok) return { handled: true };
    return { handled: false };
  }

  return { handled: false };
}
