/**
 * Menu numerado do chatbot WhatsApp.
 * 1 medir (placa→link) · 2/3 cadastro (link) · 4 troca (placa→link)
 * 5/6/7 fogo + montagem obrigatória do estoque · 6 também devolve recap→estoque
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
    '2️⃣ Cadastrar caminhão (link)',
    '3️⃣ Cadastrar pneu estoque (link)',
    '4️⃣ Trocar / montar (placa → link)',
    '5️⃣ Enviar pneu → estoque (nº fogo)',
    '6️⃣ Enviar pneu → recap (nº fogo)',
    '7️⃣ Enviar pneu → descarte (nº fogo)',
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

function pareceFogoAvulso(texto) {
  const t = String(texto || '').trim();
  if (!t || /^[0-9]$/.test(t)) return false;
  if (/^(menu|ajuda|help|frota|placas|lista|relatorio|report|pdf|cancelar|cancela|sair|voltar)$/i.test(norm(t))) {
    return false;
  }
  const fogo = t.replace(/^fogo\s+/i, '').trim();
  if (!fogo || /\s/.test(fogo)) return false;
  if (fogo.length < 1 || fogo.length > 24) return false;
  if (parecePlacaBrasil(fogo) || parecePlacaOperacional(fogo)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9\-_./]*$/.test(fogo);
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

async function resolverVeiculoPorTexto(filialId, texto) {
  const placaLimpa = normalizarPlaca(texto);
  if (!placaLimpa || placaLimpa.length < 3) return { ok: false, motivo: 'curta' };
  const veiculos = await ops.buscarVeiculoPorPlaca(filialId, placaLimpa);
  if (!veiculos.length) return { ok: false, motivo: 'nao_encontrada', placa: placaLimpa };
  if (veiculos.length > 1) {
    const exatos = veiculos.filter((v) => normalizarPlaca(v.placa) === placaLimpa);
    if (exatos.length === 1) return { ok: true, veiculo: exatos[0], placa: placaLimpa };
    return { ok: false, motivo: 'varias', placa: placaLimpa, veiculos };
  }
  return { ok: true, veiculo: veiculos[0], placa: placaLimpa };
}

export async function montarMensagemMedicao(veiculo, phone, destinoEnvio) {
  const { link } = await gerarTokenAcessoRapido({
    tipo: 'medir',
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
    await reply(ctx, `❌ Placa *${r.placa || normalizarPlaca(texto)}* não encontrada.\n\nDigite *9* para frota ou *menu*.`);
    await clear(ctx);
    return;
  }
  try {
    await reply(ctx, await montarMensagemMedicao(r.veiculo, ctx.phone, ctx.destino));
  } catch (err) {
    await reply(ctx, `❌ Não consegui gerar o link: ${err.message}\n\nDigite *menu*.`);
  }
  await clear(ctx);
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
    await reply(ctx, `Placa *${r.placa || normalizarPlaca(texto)}* não encontrada. *0* = cancelar.`);
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
      `🚛 *Cadastrar caminhão*\n\nAbra o link e preencha placa, tipo e KM:\n👉 ${link}\n\n_Válido 24h. Digite *menu*._`
    );
  } else {
    await reply(
      ctx,
      `🛞 *Cadastrar pneu (estoque)*\n\nAbra o link e informe nº de fogo, modelo e padrão:\n👉 ${link}\n\n_Válido 24h. Digite *menu*._`
    );
  }
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
  if (sessao.passo !== 'fogo') {
    await clear(ctx);
    await reply(ctx, textoMenu());
    return;
  }
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
  if (!pneu || pneu.status_pneu !== 'estoque') {
    await reply(ctx, 'Fogo não encontrado no *estoque*. Envie outro nº ou *0*.');
    return;
  }
  try {
    const r = await ops.montarPneu({
      filialId: ctx.filialId,
      pneuId: pneu.id,
      veiculoId: d.veiculo_id,
      posicao: d.posicao,
    });
    await clear(ctx);
    await reply(
      ctx,
      `✅ Fogo *${r.fogo}* montado em *${r.placa}* (${r.posicao}).\n\n` + textoMenu()
    );
  } catch (err) {
    await clear(ctx);
    await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
  }
}

async function enviarRelatorio(ctx) {
  await reply(ctx, '📊 Gerando o *relatório gerencial*… aguarde alguns segundos.', 'relatorio_semanal');
  try {
    const { buffer, filename, dados } = await gerarRelatorioSemanalPdfBuffer(ctx.filialId, {
      geradoPor: `WhatsApp · ${ctx.phone || ctx.destino}`,
    });
    const resumo = dados?.resumo || {};
    const caption = [
      `📊 *Relatório gerencial* — ${dados.filial?.nome || 'Unidade'}`,
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
      caption: `📊 Relatório — ${dados.filial?.nome || 'Unidade'} (${dados.periodo?.label || ''})`.trim(),
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
    return `• *${v.placa}*${apelido} (${v.tipo})`;
  });
  await reply(ctx, `📋 *Frota* (${rows.length}):\n${linhas.join('\n')}\n\nEnvie a *placa* para medir, ou *menu*.`);
}

async function iniciarOpcao(ctx, n) {
  switch (n) {
    case '1':
      await setFluxo(ctx, 'medir', 'placa', {});
      await reply(ctx, '📏 *Medir pneu*\n\nEnvie a *placa* do caminhão (ex.: BH123).\n_0 = cancelar_');
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
      await setFluxo(ctx, 'estoque', 'fogo', {});
      await reply(ctx, '📦 *Enviar ao estoque*\n\nEnvie o *nº de fogo* do pneu montado.\n_0 = cancelar_');
      return;
    case '6':
      await setFluxo(ctx, 'recap', 'fogo', {});
      await reply(ctx, '♻️ *Recap*\n\nEnvie o *nº de fogo*.\n(Se já estiver em recap, você poderá devolver ao estoque.)\n_0 = cancelar_');
      return;
    case '7':
      await setFluxo(ctx, 'descarte', 'fogo', {});
      await reply(ctx, '🗑️ *Descarte*\n\nEnvie o *nº de fogo*.\n_0 = cancelar_');
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

async function passoEstoque(ctx, sessao, texto) {
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
  const r = await ops.desmontarPneu({ filialId: ctx.filialId, pneuId: pneu.id });
  await pedirMontarEstoque(ctx, {
    veiculoId: r.veiculo_id,
    posicao: r.posicao,
    placa: r.placa,
    acaoLabel: `Fogo *${r.fogo}* foi para o estoque`,
  });
}

async function passoRecap(ctx, sessao, texto) {
  const d = { ...(sessao.dados || {}) };

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
    try {
      const r = await ops.devolverRecapAoEstoque({ filialId: ctx.filialId, pneuId: d.pneu_id });
      await clear(ctx);
      await reply(ctx, `✅ ${r.mensagem}\nPronto para montar nos caminhões (*4*).\n\n` + textoMenu());
    } catch (err) {
      await clear(ctx);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
    return;
  }

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

  try {
    const r = await ops.registrarRecap({ filialId: ctx.filialId, pneuId: pneu.id });
    const lembrete = `\n\nQuando o recap voltar: digite *6* e o fogo *${r.fogo}* → opção *devolver ao estoque*.`;

    if (r.estava_montado && r.veiculo_id && r.posicao) {
      await pedirMontarEstoque(ctx, {
        veiculoId: r.veiculo_id,
        posicao: r.posicao,
        placa: r.placa,
        acaoLabel: `Fogo *${r.fogo}* enviado à recap (${r.vida}ª vida)`,
      });
      return;
    }

    await clear(ctx);
    await reply(ctx, `✅ Fogo *${r.fogo}* em recapagem (${r.vida}ª vida).${lembrete}\n\n` + textoMenu());
  } catch (err) {
    await clear(ctx);
    await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
  }
}

async function passoDescarte(ctx, sessao, texto) {
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
    const r = await ops.registrarDescarte({
      filialId: ctx.filialId,
      pneuId: d.pneu_id,
      motivo: d.motivo,
    });
    if (r.estava_montado && r.veiculo_id && r.posicao) {
      await pedirMontarEstoque(ctx, {
        veiculoId: r.veiculo_id,
        posicao: r.posicao,
        placa: r.placa,
        acaoLabel: `Fogo *${r.fogo}* descartado`,
      });
      return;
    }
    await clear(ctx);
    await reply(ctx, `✅ Fogo *${r.fogo}* no descarte.\n\n` + textoMenu());
    return;
  }

  if (sessao.passo === 'motivo') {
    const d = { ...(sessao.dados || {}) };
    d.motivo = /^(?:-|\.|pular|skip)$/i.test(String(texto).trim()) ? null : String(texto).trim();
    await setFluxo(ctx, 'descarte', 'confirma', d);
    await reply(ctx, `⚠️ Descartar fogo *${d.fogo}*?\nMotivo: ${d.motivo || '—'}\n\n*1* Sim · *0* Não`);
    return;
  }

  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, String(texto).replace(/^fogo\s+/i, '').trim());
  if (!pneu) {
    await reply(ctx, 'Pneu não encontrado. Envie o nº de fogo ou *0*.');
    return;
  }
  await setFluxo(ctx, 'descarte', 'motivo', {
    pneu_id: pneu.id,
    fogo: pneu.numero_fogo,
  });
  await reply(ctx, 'Motivo do descarte? (ou `-` para pular)');
}

async function atalhoFogo(ctx, texto) {
  const fogo = String(texto).replace(/^fogo\s+/i, '').trim();
  const pneu = await ops.buscarPneuPorFogo(ctx.filialId, fogo);
  if (!pneu) return false;

  let onde = 'estoque';
  if (pneu.status_pneu === 'montado') {
    onde = `montado em *${pneu.placa || '?'}* (${pneu.posicao || '?'})`;
  } else if (pneu.status_pneu === 'recapagem') {
    onde = 'em recapagem';
  } else if (pneu.status_pneu === 'descarte') {
    onde = 'no descarte';
  }

  const linhas = [
    `🛞 Fogo *${pneu.numero_fogo}* — ${onde}`,
    pneu.marca || pneu.modelo ? `• ${[pneu.marca, pneu.modelo].filter(Boolean).join(' ')}` : null,
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
    try {
      await iniciarOpcao(ctx, n);
    } catch (err) {
      console.error('[whatsapp-menu] opcao', n, err);
      await reply(ctx, `❌ ${err.message}\n\n` + textoMenu());
    }
    return { handled: true };
  }

  if (/^(relatorio|report|pdf)\b/i.test(cmd)) {
    await enviarRelatorio(ctx);
    return { handled: true };
  }
  if (/^(frota|placas|lista)\b/i.test(cmd)) {
    await enviarFrota(ctx);
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
    await reply(
      ctx,
      `❌ Nº de fogo *${String(texto).replace(/^fogo\s+/i, '').trim()}* não encontrado nesta unidade.\n\nDigite *menu* ou *3* para cadastrar.`
    );
    return { handled: true };
  }

  return { handled: false };
}
