/**
 * Alertas WhatsApp após medição crítica/monitorar.
 * Destinos: canal da filial (número/grupo) + lista alerta_destinatarios + fallback gerentes.
 */
import { config } from '../config.js';
import { getDb } from '../database.js';
import { textoMensagemAlerta } from '../medicao-perfil.js';
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
export async function listarDestinatariosAlerta(filialId) {
  const db = getDb();
  const phones = new Map();

  const filial = await db.prepare(`
    SELECT id, nome, whatsapp, whatsapp_grupo, whatsapp_alerta
    FROM filiais WHERE id = ? AND ativo = 1
  `).get(filialId);

  if (filial) {
    // Destinos marcados no checklist (números e/ou grupos), separados por vírgula
    const destinosAlerta = String(filial.whatsapp_alerta || '')
      .split(/[,;\n]+/)
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    for (const dest of destinosAlerta) {
      adicionarDestino(phones, {
        id: filial.id,
        nome: `${filial.nome} (alerta)`,
        whatsapp: dest,
        origem: 'filial_alerta',
      });
    }
  }

  const cadastrados = await db.prepare(`
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
    const gerentes = await db.prepare(`
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
export async function listarGerentesParaAlerta(filialId) {
  return listarDestinatariosAlerta(filialId);
}

export async function jaNotificouMedicao(medicaoId) {
  if (!medicaoId) return false;
  const db = getDb();
  const row = await db.prepare(`
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
  alerta,
  menorSulco,
  veiculo,
  pneu,
  medicaoId,
}) {
  if (!alerta?.notificar) return { enviados: 0 };

  // Desligado até segunda ordem (WHATSAPP_ALERTAS_ENABLED=true para religar)
  if (!config.whatsappAlertasEnabled) {
    return { enviados: 0, motivo: 'alertas_desabilitados' };
  }

  if (await jaNotificouMedicao(medicaoId)) {
    return { enviados: 0, motivo: 'ja_notificado' };
  }

  const filialId = veiculo.filial_id;
  const destinatarios = await listarDestinatariosAlerta(filialId);
  const tipo = alerta.severidade === 'critico' ? 'alerta_critico' : 'alerta_desgaste';
  const mensagem = textoMensagemAlerta(alerta, {
    veiculo,
    pneu,
    menorSulco: menorSulco ?? alerta.menor_sulco,
  });

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
