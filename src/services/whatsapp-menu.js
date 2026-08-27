/**
 * Menu numerado do chatbot WhatsApp — fases A/B/C.
 * Qualquer pessoa do grupo pode operar (escopo = filial do grupo).
 */
import {
  obterSessao,
  salvarSessao,
  limparSessao,
} from './whatsapp-sessao.js';
import * as ops from './whatsapp-ops.js';
import {
  gerarTokenAcessoRapido,
  resumoStatusPneusVeiculoRapido,
} from './acesso-rapido.js';
import { gerarRelatorioSemanalPdfBuffer } from './relatorio-semanal-pdf.js';
import {
  enviarERegistrar,
  enviarDocumentoERegistrar,
} from './whatsapp.js';

export function textoMenu() {
  return [
    '🛠️ *PneuSistemma — Menu*',
    '',
    '1️⃣ Medir pneu (placa → link)',
    '2️⃣ Cadastrar caminhão',
    '3️⃣ Cadastrar pneu (estoque)',
    '4️⃣ Trocar / montar pneu',
    '5️⃣ Enviar pneu → estoque',
    '6️⃣ Enviar pneu → recap',
    '7️⃣ Enviar pneu → descarte',
    '8️⃣ Relatório gerencial (PDF)',
    '9️⃣ Frota (lista de placas)',
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

function ehCancelar(cmd) {
  return /^(0|cancelar|cancela|sair|voltar|menu)$/i.test(cmd);
}

function ehMenu(cmd) {
  return /^(menu|ajuda|help|\?)$/i.test(cmd);
}

function soNumero(texto) {
  const m = String(texto || '').trim().match(/^([1-9]|0)$/);
  return m ? m[1] : null;
}

function pular(texto) {
  return /^(?:-|\.|pular|skip)$/i.test(String(texto || '').trim());
}

function simNao(texto) {
  const c = norm(texto);
  if (/^(1|s|sim|ok|confirmar|confirma)$/.test(c)) return true;
  if (/^(0|n|nao|não|cancelar)$/.test(c)) return false;
  return null;
}

async function reply(ctx, mensagem, tipo = 'link_veiculo') {
  await enviarERegistrar({
    tipo,
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

/** Mensagem de link de medição (fluxo 1) */
export async function montarMensagemMedicao(veiculo, phone, destinoEnvio) {
  const { link } = await gerarTokenAcessoRapido({
    veiculoId: veiculo.id,
    filialId: veiculo.filial_id,
    whatsappOrigem: phone || destinoEnvio,
  });
  const { criticos, alertas, ultimaMedicao } = await resumoStatusPneusVeiculoRapido(veiculo.id);

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
  if (criticos === 0 && alertas === 0) mensagem += `✅ Todos os pneus estão OK\n`;
  mensagem += `\n👉 *Abrir medição de sulcos:*\n${link}\n\n`;
  mensagem += `Meça todas as posições e salve.\n`;
  mensagem += `_Link válido por 24 horas._\n\n_Digite *menu* para outras opções._`;
  return mensagem;
}

async function fluxoMedirPlaca(ctx, texto) {
  const placaLimpa = normalizarPlaca(texto);
  if (!placaLimpa || placaLimpa.length < 3) {
    await reply(ctx, 'Envie a *placa* do caminhão (ex.: ABC1D23).\n_0 = cancelar_');
    return;
  }
  const veiculos = await ops.buscarVeiculoPorPlaca(ctx.filialId, placaLimpa);
  if (!veiculos.length) {
    await reply(ctx, `❌ Placa *${texto}* não encontrada nesta unidade.\n\nDigite *9* para ver a frota ou *menu*.`);
    await clear(ctx);
    return;
  }
  if (veiculos.length > 1) {
    const lista = veiculos.map((v) => `• ${v.placa}${v.apelido ? ` — ${v.apelido}` : ''}`).join('\n');
    await reply(ctx, `🔍 Encontrei várias:\n${lista}\n\nEnvie a *placa exata*.`);
    return;
  }
  const veiculo = veiculos[0];
  const mensagem = await montarMensagemMedicao(veiculo, ctx.phone, ctx.destino);
  await reply(ctx, mensagem);
  await clear(ctx);
}

async function enviarRelatorio(ctx) {
  await reply(ctx, '📊 Gerando o *relatório gerencial*… aguarde.', 'relatorio_semanal');
  try {
    const { buffer, filename, dados } = await gerarRelatorioSemanalPdfBuffer(ctx.filialId, {
      geradoPor: `WhatsApp · ${ctx.phone || ctx.destino}`,
    });
    const caption = [
      `📊 *Relatório gerencial* — ${dados.filial?.nome || 'Unidade'}`,
      dados.filial?.codigo ? `Código: ${dados.filial.codigo}` : null,
      `_Arquivo: ${filename}_`,
      '',
      '_Digite *menu* para voltar._',
    ].filter(Boolean).join('\n');
    await reply(ctx, caption, 'relatorio_semanal');
    const envio = await enviarDocumentoERegistrar({
      tipo: 'relatorio_semanal',
      destinatario: ctx.destino,
      buffer,
      fileName: filename,
      mensagem: caption,
      filialId: ctx.filialId,
      fallbackDestinatario: ctx.phone,
    });
    if (!envio?.ok) {
      await reply(ctx, `❌ Não consegui enviar o PDF. ${envio?.erro || ''}`, 'relatorio_semanal');
    }
  } catch (err) {
    await reply(ctx, `❌ Falha ao gerar relatório: ${err.message}`, 'relatorio_semanal');
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
    return `• *${v.placa}*${apelido} (${v.tipo})`;
  });
  await reply(
    ctx,
    `📋 *Frota* (${rows.length}):\n${linhas.join('\n')}\n\nEnvie a *placa* para medir, ou *menu*.`
  );
}

async function iniciarOpcao(ctx, n) {
  switch (n) {
    case '1':
      await setFluxo(ctx, 'medir', 'placa', {});
      await reply(ctx, '📏 *Medir pneu*\n\nEnvie a *placa* do caminhão.\n_0 = cancelar_');
      return;
    case '2':
      await setFluxo(ctx, 'caminhao', 'placa', {});
      await reply(ctx, '🚛 *Cadastrar caminhão*\n\nEnvie a *placa*.\n_0 = cancelar_');
      return;
    case '3':
      await setFluxo(ctx, 'pneu', 'fogo', {});
      await reply(ctx, '🛞 *Cadastrar pneu (estoque)*\n\nEnvie o *nº de fogo*.\n_0 = cancelar_');
      return;
    case '4':
      await setFluxo(ctx, 'troca', 'placa', {});
      await reply(ctx, '🔄 *Trocar / montar pneu*\n\nEnvie a *placa* do caminhão.\n_0 = cancelar_');
      return;
    case '5':
      await setFluxo(ctx, 'estoque', 'busca', {});
      await reply(ctx, '📦 *Enviar ao estoque*\n\nEnvie o *nº de fogo* do pneu montado (ou placa + posição depois).\nEx.: `fogo 123` ou só `123`.\n_0 = cancelar_');
      return;
    case '6':
      await setFluxo(ctx, 'recap', 'fogo', {});
      await reply(ctx, '♻️ *Enviar para recap*\n\nEnvie o *nº de fogo*.\n_0 = cancelar_');
      return;
    case '7':
      await setFluxo(ctx, 'descarte', 'fogo', {});
      await reply(ctx, '🗑️ *Enviar para descarte*\n\nEnvie o *nº de fogo*.\n_0 = cancelar_');
      return;
    case '8':
      await clear(ctx);
      await enviarRelatorio(ctx);
      return;
    case '9':
      await clear(ctx);
      await enviarFrota(ctx);
      return;
    default:
      await reply(ctx, textoMenu());
  }
}

async function passoCaminhao(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'placa') {
    const placa = normalizarPlaca(texto);
    if (placa.length < 5) {
      await reply(ctx, 'Placa inválida. Envie de novo (ex.: ABC1D23).');
      return;
    }
    d.placa = placa;
    await setFluxo(ctx, 'caminhao', 'apelido', d);
    await reply(ctx, 'Apelido do caminhão? (ou `-` para pular)');
    return;
  }
  if (sessao.passo === 'apelido') {
    d.apelido = pular(texto) ? null : String(texto).trim();
    await setFluxo(ctx, 'caminhao', 'tipo', d);
    await reply(ctx, 'Tipo:\n*1* Truck / Tração\n*2* Toco / Mini');
    return;
  }
  if (sessao.passo === 'tipo') {
    const n = soNumero(texto) || (norm(texto).includes('toco') ? '2' : norm(texto).includes('truck') ? '1' : null);
    if (n !== '1' && n !== '2') {
      await reply(ctx, 'Responda *1* (Truck) ou *2* (Toco).');
      return;
    }
    d.tipo = n === '2' ? 'Toco / Mini' : 'Truck / Tração';
    await setFluxo(ctx, 'caminhao', 'km', d);
    await reply(ctx, 'KM atual? (ou `-` para 0)');
    return;
  }
  if (sessao.passo === 'km') {
    if (pular(texto)) d.km = 0;
    else {
      const km = parseInt(String(texto).replace(/\D/g, ''), 10);
      if (!Number.isFinite(km) || km < 0) {
        await reply(ctx, 'KM inválido. Envie um número ou `-`.');
        return;
      }
      d.km = km;
    }
    await setFluxo(ctx, 'caminhao', 'confirma', d);
    await reply(
      ctx,
      `Confirma cadastro?\n• Placa: *${d.placa}*\n• Apelido: ${d.apelido || '—'}\n• Tipo: ${d.tipo}\n• KM: ${d.km}\n\n*1* Sim · *0* Não`
    );
    return;
  }
  if (sessao.passo === 'confirma') {
    const sn = simNao(texto);
    if (sn === false) {
      await clear(ctx);
      await reply(ctx, 'Cancelado.\n\n' + textoMenu());
      return;
    }
    if (sn !== true) {
      await reply(ctx, 'Responda *1* para confirmar ou *0* para cancelar.');
      return;
    }
    try {
      const r = await ops.criarVeiculo(ctx.filialId, {
        placa: d.placa,
        apelido: d.apelido,
        tipo: d.tipo,
        km_atual: d.km,
      });
      await clear(ctx);
      await reply(
        ctx,
        `✅ Caminhão *${d.placa}* cadastrado (${r.total_posicoes} posições).\n\nDigite *4* para montar pneus ou *menu*.`
      );
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
  }
}

async function passoPneu(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'fogo') {
    const fogo = String(texto).trim();
    if (fogo.length < 1) {
      await reply(ctx, 'Informe o nº de fogo.');
      return;
    }
    d.fogo = fogo;
    await setFluxo(ctx, 'pneu', 'modelo', d);
    await reply(ctx, 'Modelo do pneu?');
    return;
  }
  if (sessao.passo === 'modelo') {
    d.modelo = String(texto).trim();
    await setFluxo(ctx, 'pneu', 'marca', d);
    await reply(ctx, 'Marca? (ou `-` para pular)');
    return;
  }
  if (sessao.passo === 'marca') {
    d.marca = pular(texto) ? null : String(texto).trim();
    await setFluxo(ctx, 'pneu', 'padrao', d);
    await reply(ctx, 'Padrão:\n*1* Direcional\n*2* Misto\n*3* Borrachudo');
    return;
  }
  if (sessao.passo === 'padrao') {
    const map = { 1: 'direcional', 2: 'misto', 3: 'borrachudo' };
    const n = soNumero(texto);
    if (!map[n]) {
      await reply(ctx, 'Responda *1*, *2* ou *3*.');
      return;
    }
    d.tipo_pneu = map[n];
    await setFluxo(ctx, 'pneu', 'condicao', d);
    await reply(ctx, 'Condição:\n*1* Novo\n*2* Recapado');
    return;
  }
  if (sessao.passo === 'condicao') {
    const n = soNumero(texto);
    if (n !== '1' && n !== '2') {
      await reply(ctx, 'Responda *1* (Novo) ou *2* (Recapado).');
      return;
    }
    d.condicao = n === '2' ? 'recapado' : 'novo';
    await setFluxo(ctx, 'pneu', 'sulco', d);
    await reply(ctx, 'Sulco inicial (mm)? (ou `-` para padrão)');
    return;
  }
  if (sessao.passo === 'sulco') {
    if (pular(texto)) d.sulco = null;
    else {
      const s = parseFloat(String(texto).replace(',', '.'));
      if (!Number.isFinite(s) || s < 0) {
        await reply(ctx, 'Valor inválido. Envie mm ou `-`.');
        return;
      }
      d.sulco = s;
    }
    await setFluxo(ctx, 'pneu', 'confirma', d);
    await reply(
      ctx,
      `Confirma pneu no estoque?\n• Fogo: *${d.fogo}*\n• ${d.marca || '—'} ${d.modelo}\n• ${d.tipo_pneu} · ${d.condicao}\n• Sulco: ${d.sulco ?? 'padrão'}\n\n*1* Sim · *0* Não`
    );
    return;
  }
  if (sessao.passo === 'confirma') {
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
    try {
      await ops.criarPneuEstoque(ctx.filialId, {
        numero_fogo: d.fogo,
        marca: d.marca,
        modelo: d.modelo,
        tipo_pneu: d.tipo_pneu,
        condicao: d.condicao,
        sulco_inicial_mm: d.sulco,
      });
      await clear(ctx);
      await reply(ctx, `✅ Pneu fogo *${d.fogo}* no estoque.\n\nDigite *4* para montar ou *menu*.`);
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
  }
}

async function passoTroca(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'placa') {
    const placa = normalizarPlaca(texto);
    const veiculos = await ops.buscarVeiculoPorPlaca(ctx.filialId, placa);
    if (!veiculos.length) {
      await reply(ctx, 'Placa não encontrada. Tente de novo ou *0* para cancelar.');
      return;
    }
    if (veiculos.length > 1) {
      await reply(ctx, `Várias placas:\n${veiculos.map((v) => `• ${v.placa}`).join('\n')}\nEnvie a exata.`);
      return;
    }
    d.veiculo_id = veiculos[0].id;
    d.placa = veiculos[0].placa;
    const livres = await ops.posicoesLivres(d.veiculo_id);
    if (!livres.length) {
      await clear(ctx);
      await reply(ctx, `❌ *${d.placa}* sem posição livre. Retire um pneu (*5*) antes.\n\n` + textoMenu());
      return;
    }
    d.livres = livres;
    await setFluxo(ctx, 'troca', 'posicao', d);
    await reply(ctx, `Posições livres em *${d.placa}*:\n${livres.map((p) => `• ${p}`).join('\n')}\n\nEnvie a posição (ex.: ${livres[0]}).`);
    return;
  }
  if (sessao.passo === 'posicao') {
    const pos = String(texto).trim().toUpperCase();
    if (!(d.livres || []).includes(pos)) {
      await reply(ctx, `Posição inválida. Use uma destas: ${(d.livres || []).join(', ')}`);
      return;
    }
    d.posicao = pos;
    await setFluxo(ctx, 'troca', 'origem', d);
    await reply(ctx, 'Origem do pneu:\n*1* Puxar do estoque\n*2* Cadastrar pneu novo agora');
    return;
  }
  if (sessao.passo === 'origem') {
    const n = soNumero(texto);
    if (n === '1') {
      const estoque = await ops.listarEstoque(ctx.filialId, 25);
      if (!estoque.length) {
        await reply(ctx, 'Estoque vazio. Escolha *2* para cadastrar novo, ou *0* cancelar.');
        return;
      }
      d.estoque = estoque.map((p) => ({ id: p.id, fogo: p.numero_fogo }));
      await setFluxo(ctx, 'troca', 'fogo_estoque', d);
      const lista = estoque
        .slice(0, 15)
        .map((p) => `• *${p.numero_fogo}* — ${[p.marca, p.modelo].filter(Boolean).join(' ') || p.tipo_pneu}`)
        .join('\n');
      await reply(ctx, `Estoque:\n${lista}\n\nEnvie o *nº de fogo*.`);
      return;
    }
    if (n === '2') {
      await setFluxo(ctx, 'troca', 'novo_fogo', d);
      await reply(ctx, 'Nº de fogo do pneu novo:');
      return;
    }
    await reply(ctx, 'Responda *1* (estoque) ou *2* (novo).');
    return;
  }
  if (sessao.passo === 'fogo_estoque') {
    const pneu = await ops.buscarPneuPorFogo(ctx.filialId, texto);
    if (!pneu || pneu.status_pneu !== 'estoque') {
      await reply(ctx, 'Fogo não encontrado no estoque. Tente de novo.');
      return;
    }
    d.pneu_id = pneu.id;
    d.fogo = pneu.numero_fogo;
    await setFluxo(ctx, 'troca', 'confirma', d);
    await reply(
      ctx,
      `Montar fogo *${d.fogo}* em *${d.placa}* / *${d.posicao}*?\n\n*1* Sim · *0* Não`
    );
    return;
  }
  if (sessao.passo === 'novo_fogo') {
    d.fogo = String(texto).trim();
    await setFluxo(ctx, 'troca', 'novo_modelo', d);
    await reply(ctx, 'Modelo:');
    return;
  }
  if (sessao.passo === 'novo_modelo') {
    d.modelo = String(texto).trim();
    await setFluxo(ctx, 'troca', 'novo_marca', d);
    await reply(ctx, 'Marca? (ou `-`)');
    return;
  }
  if (sessao.passo === 'novo_marca') {
    d.marca = pular(texto) ? null : String(texto).trim();
    await setFluxo(ctx, 'troca', 'novo_padrao', d);
    await reply(ctx, 'Padrão:\n*1* Direcional\n*2* Misto\n*3* Borrachudo');
    return;
  }
  if (sessao.passo === 'novo_padrao') {
    const map = { 1: 'direcional', 2: 'misto', 3: 'borrachudo' };
    const n = soNumero(texto);
    if (!map[n]) {
      await reply(ctx, 'Responda *1*, *2* ou *3*.');
      return;
    }
    d.tipo_pneu = map[n];
    await setFluxo(ctx, 'troca', 'novo_condicao', d);
    await reply(ctx, 'Condição:\n*1* Novo\n*2* Recapado');
    return;
  }
  if (sessao.passo === 'novo_condicao') {
    const n = soNumero(texto);
    if (n !== '1' && n !== '2') {
      await reply(ctx, 'Responda *1* ou *2*.');
      return;
    }
    d.condicao = n === '2' ? 'recapado' : 'novo';
    d.criar_novo = true;
    await setFluxo(ctx, 'troca', 'confirma', d);
    await reply(
      ctx,
      `Cadastrar e montar?\n• Fogo *${d.fogo}* · ${d.marca || ''} ${d.modelo}\n• ${d.tipo_pneu} · ${d.condicao}\n• Em *${d.placa}* / *${d.posicao}*\n\n*1* Sim · *0* Não`
    );
    return;
  }
  if (sessao.passo === 'confirma') {
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
    try {
      let pneuId = d.pneu_id;
      if (d.criar_novo) {
        const p = await ops.criarPneuEstoque(ctx.filialId, {
          numero_fogo: d.fogo,
          marca: d.marca,
          modelo: d.modelo,
          tipo_pneu: d.tipo_pneu,
          condicao: d.condicao,
        });
        pneuId = p.id;
      }
      const r = await ops.montarPneu({
        filialId: ctx.filialId,
        pneuId,
        veiculoId: d.veiculo_id,
        posicao: d.posicao,
      });
      await clear(ctx);
      await reply(
        ctx,
        `✅ Pneu fogo *${r.fogo}* montado em *${r.placa}* (${r.posicao}).\n\nDigite *menu*.`
      );
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
  }
}

async function resolverPneuPorTexto(filialId, texto, { soMontado = false } = {}) {
  const fogo = String(texto).replace(/^fogo\s+/i, '').trim();
  const pneu = await ops.buscarPneuPorFogo(filialId, fogo);
  if (!pneu) return null;
  if (soMontado && pneu.status_pneu !== 'montado') return null;
  return pneu;
}

async function passoEstoque(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'busca') {
    const pneu = await resolverPneuPorTexto(ctx.filialId, texto, { soMontado: true });
    if (!pneu) {
      await reply(ctx, 'Pneu montado não encontrado. Envie o nº de fogo correto.');
      return;
    }
    d.pneu_id = pneu.id;
    d.fogo = pneu.numero_fogo;
    d.placa = pneu.placa;
    d.posicao = pneu.posicao;
    await setFluxo(ctx, 'estoque', 'confirma', d);
    await reply(
      ctx,
      `Retirar fogo *${d.fogo}* de *${d.placa}* (${d.posicao}) → estoque?\n\n*1* Sim · *0* Não`
    );
    return;
  }
  if (sessao.passo === 'confirma') {
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
    try {
      const r = await ops.desmontarPneu({ filialId: ctx.filialId, pneuId: d.pneu_id });
      await clear(ctx);
      await reply(ctx, `✅ Fogo *${r.fogo}* no estoque (saiu de ${r.placa}).\n\n` + 'Digite *menu*.');
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
  }
}

async function passoRecap(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'fogo') {
    const pneu = await resolverPneuPorTexto(ctx.filialId, texto);
    if (!pneu) {
      await reply(ctx, 'Pneu não encontrado. Envie o nº de fogo.');
      return;
    }
    d.pneu_id = pneu.id;
    d.fogo = pneu.numero_fogo;
    await setFluxo(ctx, 'recap', 'confirma', d);
    await reply(ctx, `Enviar fogo *${d.fogo}* para *recap*?\n\n*1* Sim · *0* Não`);
    return;
  }
  if (sessao.passo === 'confirma') {
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
    try {
      const r = await ops.registrarRecap({ filialId: ctx.filialId, pneuId: d.pneu_id });
      await clear(ctx);
      await reply(ctx, `✅ Fogo *${r.fogo}* em recapagem (${r.vida}ª vida).\n\nDigite *menu*.`);
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
  }
}

async function passoDescarte(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };
  if (sessao.passo === 'fogo') {
    const pneu = await resolverPneuPorTexto(ctx.filialId, texto);
    if (!pneu) {
      await reply(ctx, 'Pneu não encontrado. Envie o nº de fogo.');
      return;
    }
    d.pneu_id = pneu.id;
    d.fogo = pneu.numero_fogo;
    await setFluxo(ctx, 'descarte', 'motivo', d);
    await reply(ctx, 'Motivo do descarte? (ou `-` para pular)');
    return;
  }
  if (sessao.passo === 'motivo') {
    d.motivo = pular(texto) ? null : String(texto).trim();
    await setFluxo(ctx, 'descarte', 'confirma', d);
    await reply(
      ctx,
      `⚠️ Descartar fogo *${d.fogo}*?\nMotivo: ${d.motivo || '—'}\n\n*1* Sim · *0* Não`
    );
    return;
  }
  if (sessao.passo === 'confirma') {
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
    try {
      const r = await ops.registrarDescarte({
        filialId: ctx.filialId,
        pneuId: d.pneu_id,
        motivo: d.motivo,
      });
      await clear(ctx);
      await reply(ctx, `✅ Fogo *${r.fogo}* enviado ao descarte.\n\nDigite *menu*.`);
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
  }
}

async function continuarSessao(ctx, sessao, texto) {
  switch (sessao.fluxo) {
    case 'medir':
      return fluxoMedirPlaca(ctx, texto);
    case 'caminhao':
      return passoCaminhao(ctx, sessao, texto);
    case 'pneu':
      return passoPneu(ctx, sessao, texto);
    case 'troca':
      return passoTroca(ctx, sessao, texto);
    case 'estoque':
      return passoEstoque(ctx, sessao, texto);
    case 'recap':
      return passoRecap(ctx, sessao, texto);
    case 'descarte':
      return passoDescarte(ctx, sessao, texto);
    default:
      await clear(ctx);
      await reply(ctx, textoMenu());
  }
}

/**
 * @returns {{ handled: boolean }}
 */
export async function processarMensagemMenu(ctx) {
  const texto = String(ctx.texto || '').trim();
  if (!texto) return { handled: false };

  const cmd = norm(texto);
  const filialId = ctx.filialId;
  if (!filialId) {
    await reply(ctx, '❌ Unidade do chat não identificada. Configure o grupo no painel WhatsApp.');
    return { handled: true };
  }

  if (ehCancelar(cmd) || ehMenu(cmd)) {
    await clear(ctx);
    await reply(ctx, textoMenu());
    return { handled: true };
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
    await iniciarOpcao(ctx, n);
    return { handled: true };
  }

  // Atalhos texto
  if (/^(relatorio|report|pdf)\b/i.test(cmd)) {
    await enviarRelatorio(ctx);
    return { handled: true };
  }
  if (/^(frota|placas|lista)\b/i.test(cmd)) {
    await enviarFrota(ctx);
    return { handled: true };
  }

  // Placa direta (sem menu) — Fase A compatível
  const placaLimpa = normalizarPlaca(texto);
  if (placaLimpa && placaLimpa.length >= 5 && placaLimpa.length <= 8 && normalizarPlaca(texto) === placaLimpa) {
    await fluxoMedirPlaca(ctx, texto);
    return { handled: true };
  }

  return { handled: false };
}
