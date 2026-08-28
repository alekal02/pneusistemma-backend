/**
 * Alerta operacional: posição do caminhão ficou vazia
 * (recap, descarte ou envio ao estoque) e precisa de um pneu novo.
 */
import { labelPosicao } from '../pneus-layouts.js';
import { gerarTokenAcessoRapido } from './acesso-rapido.js';
import { listarDestinatariosAlerta } from './alertas-whatsapp.js';
import { enviarERegistrar, normalizarDestino } from './whatsapp.js';

export const MOTIVO_VAGA_LABEL = {
  recap: 'enviado para recap',
  descarte: 'enviado para descarte',
  estoque: 'retirado para o estoque',
};

export async function capturarVagaDoPneu(db, pneu) {
  if (!pneu || pneu.status_pneu !== 'montado' || !pneu.veiculo_id || !pneu.posicao) {
    return null;
  }
  const v = await db.prepare(`
    SELECT id, placa, apelido, filial_id, tipo
    FROM veiculos WHERE id = ? AND ativo = 1
  `).get(pneu.veiculo_id);
  if (!v) return null;
  return {
    filialId: v.filial_id || pneu.filial_id,
    veiculoId: v.id,
    placa: v.placa,
    apelido: v.apelido || null,
    veiculoTipo: v.tipo || null,
    posicao: pneu.posicao,
    posicaoLabel: labelPosicao(pneu.posicao),
    pneuId: pneu.id,
    numeroFogo: pneu.numero_fogo || null,
  };
}

export async function abrirAlertaPosicaoVaga(db, {
  filialId,
  veiculoId,
  posicao,
  motivo = 'recap',
  pneuId = null,
  numeroFogo = null,
  detalhes = null,
}) {
  if (!filialId || !veiculoId || !posicao) return null;
  const existente = await db.prepare(`
    SELECT id FROM alertas_posicao_vaga
    WHERE veiculo_id = ? AND posicao = ? AND aberto = 1
    LIMIT 1
  `).get(veiculoId, posicao);
  if (existente) {
    await db.prepare(`
      UPDATE alertas_posicao_vaga SET
        motivo = ?, pneu_id = ?, numero_fogo = ?, detalhes = ?, filial_id = ?
      WHERE id = ?
    `).run(motivo, pneuId, numeroFogo, detalhes, filialId, existente.id);
    return existente.id;
  }
  const r = await db.prepare(`
    INSERT INTO alertas_posicao_vaga (
      filial_id, veiculo_id, posicao, motivo, pneu_id, numero_fogo, detalhes, aberto
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(filialId, veiculoId, posicao, motivo, pneuId, numeroFogo, detalhes);
  return r.lastInsertRowid;
}

export async function resolverAlertaPosicaoVaga(db, { veiculoId, posicao }) {
  if (!veiculoId || !posicao) return;
  await db.prepare(`
    UPDATE alertas_posicao_vaga
    SET aberto = 0, resolvido_em = NOW()
    WHERE veiculo_id = ? AND posicao = ? AND aberto = 1
  `).run(veiculoId, posicao);
}

export async function listarAlertasPosicaoVaga(db, filialId) {
  if (!filialId) return [];
  const rows = await db.prepare(`
    SELECT a.*, v.placa, v.apelido, v.tipo as veiculo_tipo
    FROM alertas_posicao_vaga a
    JOIN veiculos v ON v.id = a.veiculo_id AND v.ativo = 1
    WHERE a.filial_id = ? AND a.aberto = 1
    ORDER BY a.created_at DESC, a.id DESC
  `).all(filialId);
  return rows.map((a) => ({
    ...a,
    tipo_alerta: 'posicao_vaga',
    posicao_label: labelPosicao(a.posicao),
    motivo_label: MOTIVO_VAGA_LABEL[a.motivo] || a.motivo,
  }));
}

export function montarMensagemAlertaVaga({
  vaga,
  motivo = 'recap',
  detalhesAcao = null,
  link = null,
} = {}) {
  if (!vaga) return '';
  const motivoTxt = MOTIVO_VAGA_LABEL[motivo] || motivo;
  const fogo = vaga.numeroFogo || vaga.numero_fogo;
  const pos = vaga.posicaoLabel || vaga.posicao_label || vaga.posicao;
  const apelido = vaga.apelido ? ` (${vaga.apelido})` : '';
  let msg = `⚠️ *Posição vaga — informe um pneu novo*\n\n`;
  msg += `🚛 *${vaga.placa}*${apelido}\n`;
  msg += `📍 Posição *${vaga.posicao}* (${pos})\n`;
  if (fogo) msg += `🔧 Fogo ${fogo} ${motivoTxt}\n`;
  else msg += `🔧 Pneu ${motivoTxt}\n`;
  if (detalhesAcao) msg += `${detalhesAcao}\n`;
  msg += `\nColoque outro pneu nessa posição.`;
  if (link) msg += `\n👉 ${link}`;
  return msg;
}

export async function notificarAlertaPosicaoVaga({
  vaga,
  motivo = 'recap',
  detalhesAcao = null,
  link = null,
  excetoDestino = null,
  whatsappOrigem = null,
} = {}) {
  if (!vaga?.veiculoId) return { enviados: 0, mensagem: '', link: null };

  let linkFinal = link;
  if (!linkFinal && vaga.veiculoId && vaga.filialId) {
    try {
      const gerado = await gerarTokenAcessoRapido({
        veiculoId: vaga.veiculoId,
        filialId: vaga.filialId,
        whatsappOrigem,
      });
      linkFinal = gerado.link;
    } catch (err) {
      console.warn('[alerta-vaga] link acesso rápido:', err.message);
    }
  }

  const mensagem = montarMensagemAlertaVaga({
    vaga,
    motivo,
    detalhesAcao,
    link: linkFinal,
  });

  const destinos = await listarDestinatariosAlerta(vaga.filialId);
  const exceto = normalizarDestino(excetoDestino);
  let enviados = 0;
  for (const dest of destinos) {
    const n = normalizarDestino(dest.whatsapp);
    if (exceto && n?.logKey && n.logKey === exceto.logKey) continue;
    const result = await enviarERegistrar({
      tipo: 'alerta_posicao',
      destinatario: dest.whatsapp,
      mensagem,
      veiculoId: vaga.veiculoId,
      filialId: vaga.filialId,
    });
    if (result?.ok) enviados += 1;
  }

  return { enviados, mensagem, link: linkFinal };
}
