/**
 * Alertas WhatsApp após medição crítica/monitorar.
 * Destinos: canal da filial (número/grupo) + lista alerta_destinatarios + fallback gerentes.
 */
import { config } from '../config.js';
import { getDb } from '../database.js';
import { enviarERegistrar, normalizarDestino } from './whatsapp.js';

function adicionarDestino(map, { id = null, nome, whatsapp, origem, cargo = null }) {
  const dest = normalizarDestino(whatsapp);
  if (!dest?.phone) return;
  if (map.has(dest.logKey)) return;
  map.set(dest.logKey, {
    id,
    nome,
    whatsapp: dest.phone,
    origem,
    cargo,
  });
}

/**
 * Destinos que devem receber alerta desta filial.
 * Usa o número de alertas (whatsapp_alerta). Não envia no grupo do chatbot.
 */
export function listarDestinatariosAlerta(filialId) {
  const db = getDb();
  const phones = new Map();

  const filial = db.prepare(`
    SELECT id, nome, whatsapp, whatsapp_grupo, whatsapp_alerta
    FROM filiais WHERE id = ? AND ativo = 1
  `).get(filialId);

  if (filial) {
    // Número dedicado para alertas (prioridade)
    if (filial.whatsapp_alerta) {
      adicionarDestino(phones, {
        id: filial.id,
        nome: `${filial.nome} (alerta)`,
        whatsapp: filial.whatsapp_alerta,
        origem: 'filial_alerta',
      });
    }
  }

  const cadastrados = db.prepare(`
    SELECT id, nome, whatsapp, escopo, filial_id
    FROM alerta_destinatarios
    WHERE ativo = 1
      AND whatsapp IS NOT NULL AND TRIM(whatsapp) != ''
      AND (
        escopo = 'todas'
        OR (escopo = 'filial' AND filial_id = ?)
      )
  `).all(filialId);

  for (const d of cadastrados) {
    adicionarDestino(phones, {
      id: d.id,
      nome: d.nome,
      whatsapp: d.whatsapp,
      origem: 'lista',
    });
  }

  // Fallback só se ainda não houver nenhum destino (nem canal da unidade)
  if (phones.size === 0) {
    const gerentes = db.prepare(`
      SELECT id, login, cargo, whatsapp, filial_id
      FROM usuarios
      WHERE ativo = 1
        AND whatsapp IS NOT NULL AND TRIM(whatsapp) != ''
        AND (
          cargo = 'gerente_compras'
          OR (cargo = 'gerente_filial' AND filial_id = ?)
          OR (papel = 'gerente' AND filial_id IS NULL)
          OR (papel = 'gerente' AND filial_id = ?)
        )
    `).all(filialId, filialId);

    for (const g of gerentes) {
      adicionarDestino(phones, {
        id: g.id,
        nome: g.login,
        whatsapp: g.whatsapp,
        origem: 'usuario',
        cargo: g.cargo,
      });
    }

    if (config.gerenteComprasWhatsapp) {
      adicionarDestino(phones, {
        nome: 'Gerente compras (.env)',
        whatsapp: config.gerenteComprasWhatsapp,
        origem: 'env',
      });
    }
  }

  return [...phones.values()];
}

/** @deprecated use listarDestinatariosAlerta */
export function listarGerentesParaAlerta(filialId) {
  return listarDestinatariosAlerta(filialId);
}

export function jaNotificouMedicao(medicaoId) {
  if (!medicaoId) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT id FROM notificacoes_whatsapp
    WHERE medicao_id = ?
      AND tipo IN ('alerta_critico', 'alerta_desgaste')
    LIMIT 1
  `).get(medicaoId);
  return Boolean(row);
}

/**
 * Dispara WhatsApp aos canais da unidade / números selecionados se status for alerta/crítico.
 */
export async function notificarGerentesAposMedicao({
  statusSulco,
  diagnosticoLabel,
  acaoLabel,
  menorSulco,
  veiculo,
  pneu,
  medicaoId,
}) {
  if (!['alerta', 'critico'].includes(statusSulco)) return { enviados: 0 };

  if (jaNotificouMedicao(medicaoId)) {
    return { enviados: 0, motivo: 'ja_notificado' };
  }

  const filialId = veiculo.filial_id;
  const destinatarios = listarDestinatariosAlerta(filialId);
  const tipo = statusSulco === 'critico' ? 'alerta_critico' : 'alerta_desgaste';
  const statusLabel = statusSulco === 'critico' ? 'CRÍTICO — TROCAR' : 'MONITORAR — programar substituição';

  let mensagem = `🚨 *ALERTA DE PNEU* 🚨\n\n`;
  mensagem += `🚛 Veículo: *${veiculo.placa}*\n`;
  mensagem += `📍 Posição: ${pneu.posicao || '-'}${pneu.numero_fogo ? ` — Fogo: ${pneu.numero_fogo}` : ''}\n`;
  mensagem += `⚠️ Status: *${statusLabel}*\n`;
  mensagem += `📏 Sulco mínimo: ${menorSulco ?? '-'} mm\n`;
  mensagem += `🔧 Diagnóstico: ${diagnosticoLabel || '-'}\n`;
  mensagem += `💡 Ação: ${acaoLabel || '-'}\n\n`;
  mensagem += `Acesse o sistema para organizar compras e recapagens.`;

  if (!destinatarios.length) {
    console.warn('[alerta] Nenhum destinatário — cadastre WhatsApp/grupo na filial ou em Destinatários de alerta');
    return { enviados: 0, motivo: 'sem_destinatarios' };
  }

  let enviados = 0;
  for (const dest of destinatarios) {
    const result = await enviarERegistrar({
      tipo,
      destinatario: dest.whatsapp,
      mensagem,
      veiculoId: veiculo.id,
      medicaoId,
      filialId,
    });
    if (result.ok) enviados += 1;
  }

  return { enviados, destinatarios: destinatarios.length };
}
