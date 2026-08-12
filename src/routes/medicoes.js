import { Router } from 'express';
import { getDb, classificarSulco } from '../database.js';
import { getLimites, menorSulco, adicionarDias } from '../limites.js';
import {
  diagnosticarPerfil,
  sugerirAcao,
  desgastePorKm,
} from '../diagnostico.js';
import { papelPosicao } from '../pneus-layouts.js';
import {
  requireAuth,
  requireFilial,
  filialScopeId,
  assertPneuDaFilial,
} from '../auth.js';
import {
  validarTokenAcessoRapido,
  marcarTokenUsado,
} from '../services/acesso-rapido.js';
import { notificarGerentesAposMedicao } from '../services/alertas-whatsapp.js';

const router = Router();

/**
 * JWT de filial OU token de acesso rápido (WhatsApp)
 */
function requireAuthOrAcessoRapido(req, res, next) {
  const tokenAcesso = req.headers['x-acesso-rapido-token']
    || req.body?.token_acesso
    || req.query?.token_acesso;

  if (tokenAcesso) {
    const tokenRow = validarTokenAcessoRapido(String(tokenAcesso));
    if (!tokenRow) {
      return res.status(401).json({ erro: 'Token de acesso rápido inválido ou expirado' });
    }
    marcarTokenUsado(tokenRow.id);
    req.acessoRapido = tokenRow;
    return next();
  }

  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return requireFilial(req, res, next);
  });
}

router.get('/alertas', requireAuth, requireFilial, (req, res) => {
  const db = getDb();
  const limites = getLimites();
  const filialId = filialScopeId(req);

  const alertas = db.prepare(`
    SELECT
      m.*,
      p.posicao, p.marca as pneu_marca, p.modelo as pneu_modelo,
      p.numero_fogo, p.tipo_pneu, p.condicao, p.vida_recap, p.sulco_inicial_mm,
      v.placa, v.apelido, v.tipo,
      MIN(
        COALESCE(m.sulco_externo, 999),
        COALESCE(m.sulco_central, 999),
        COALESCE(m.sulco_interno, 999),
        COALESCE(m.sulco_auxiliar, 999)
      ) as menor_sulco_raw
    FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id AND p.ativo = 1
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
    WHERE m.id = (
      SELECT id FROM medicoes WHERE pneu_id = p.id
      ORDER BY data_medicao DESC, id DESC LIMIT 1
    )
    AND MIN(
      COALESCE(m.sulco_externo, 999),
      COALESCE(m.sulco_central, 999),
      COALESCE(m.sulco_interno, 999),
      COALESCE(m.sulco_auxiliar, 999)
    ) <= ?
    ORDER BY menor_sulco_raw ASC
  `).all(filialId, Math.max(limites.sulco_alerta_mm, limites.sulco_recap_mm));

  const resultado = alertas.map((a) => {
    const menor = a.menor_sulco_raw === 999 ? null : a.menor_sulco_raw;
    const diag = diagnosticarPerfil(a, limites.diagnostico_tolerancia_mm);
    const acao = sugerirAcao(menor, limites, a.vida_recap || 0);
    return {
      ...a,
      menor_sulco: menor,
      status_sulco: classificarSulco(menor),
      diagnostico: diag.codigo,
      diagnostico_label: diag.label,
      acao_sugerida: acao.codigo,
      acao_label: acao.label,
      acao_motivo: acao.motivo,
    };
  });

  res.json(resultado);
});

router.get('/acoes', requireAuth, requireFilial, (req, res) => {
  const db = getDb();
  const limites = getLimites();
  const filialId = filialScopeId(req);

  const pneus = db.prepare(`
    SELECT
      p.*,
      v.placa, v.apelido, v.tipo,
      m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar,
      m.data_medicao, m.km_veiculo, m.diagnostico, m.acao_sugerida
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
    LEFT JOIN medicoes m ON m.pneu_id = p.id
      AND m.id = (SELECT id FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1)
    WHERE p.ativo = 1 AND p.status_pneu = 'montado'
  `).all(filialId);

  const itens = pneus
    .map((p) => {
      const menor = menorSulco(p);
      const diag = diagnosticarPerfil(p, limites.diagnostico_tolerancia_mm);
      const acao = sugerirAcao(menor, limites, p.vida_recap || 0);
      return {
        pneu_id: p.id,
        veiculo_id: p.veiculo_id,
        placa: p.placa,
        apelido: p.apelido,
        posicao: p.posicao,
        numero_fogo: p.numero_fogo,
        menor_sulco: menor,
        status_sulco: classificarSulco(menor),
        diagnostico: diag.codigo,
        diagnostico_label: diag.label,
        acao_sugerida: acao.codigo,
        acao_label: acao.label,
        acao_motivo: acao.motivo,
        vida_recap: p.vida_recap,
        data_medicao: p.data_medicao,
      };
    })
    .filter((i) => i.acao_sugerida !== 'ok')
    .sort((a, b) => {
      const ordem = { troca: 0, recap: 1, monitorar: 2 };
      return (ordem[a.acao_sugerida] ?? 9) - (ordem[b.acao_sugerida] ?? 9);
    });

  res.json({
    total: itens.length,
    troca: itens.filter((i) => i.acao_sugerida === 'troca').length,
    recap: itens.filter((i) => i.acao_sugerida === 'recap').length,
    monitorar: itens.filter((i) => i.acao_sugerida === 'monitorar').length,
    itens,
  });
});

router.post('/', requireAuthOrAcessoRapido, async (req, res) => {
  const {
    pneu_id,
    data_medicao,
    km_veiculo,
    hr_veiculo,
    sulco_externo,
    sulco_central,
    sulco_interno,
    sulco_auxiliar,
    pressao_psi,
    responsavel,
    observacoes,
    marcacao_json,
  } = req.body;

  if (!pneu_id) return res.status(400).json({ erro: 'pneu_id é obrigatório' });

  const db = getDb();
  let filialId;
  let pneu;

  if (req.acessoRapido) {
    filialId = req.acessoRapido.filial_id;
    pneu = assertPneuDaFilial(pneu_id, filialId);
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });
    // R3: só o veículo do token
    if (Number(pneu.veiculo_id) !== Number(req.acessoRapido.veiculo_id)) {
      return res.status(403).json({ erro: 'Este token não permite medir este veículo' });
    }
  } else {
    filialId = filialScopeId(req);
    pneu = assertPneuDaFilial(pneu_id, filialId);
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });
  }

  const limites = getLimites();
  const medicaoRow = {
    sulco_externo: sulco_externo ?? null,
    sulco_central: sulco_central ?? null,
    sulco_interno: sulco_interno ?? null,
    sulco_auxiliar: sulco_auxiliar ?? null,
  };

  const menor = menorSulco(medicaoRow);
  if (menor == null) {
    return res.status(400).json({ erro: 'Informe ao menos um valor de sulco' });
  }

  const diag = diagnosticarPerfil(medicaoRow, limites.diagnostico_tolerancia_mm, {
    papel: pneu.posicao ? papelPosicao(pneu.posicao) : null,
  });

  let candidatos = [];
  if (pneu.veiculo_id) {
    candidatos = db.prepare(`
      SELECT p.id, p.posicao, p.numero_fogo,
        (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
        (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
        (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
        (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux
      FROM pneus p
      WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
    `).all(pneu.veiculo_id, pneu_id).map((c) => ({
      ...c,
      posicao_label: c.posicao,
      sulco_externo: c.ult_sulco_ext,
      sulco_central: c.ult_sulco_cent,
      sulco_interno: c.ult_sulco_int,
      sulco_auxiliar: c.ult_sulco_aux,
    }));
  }

  const acao = sugerirAcao(menor, limites, pneu.vida_recap || 0, {
    pontos: medicaoRow,
    candidatos,
  });
  const statusSulco = classificarSulco(menor);

  const anterior = db.prepare(`
    SELECT * FROM medicoes WHERE pneu_id = ?
    ORDER BY data_medicao DESC, id DESC LIMIT 1
  `).get(pneu_id);

  let desgaste = null;
  if (anterior && km_veiculo != null) {
    desgaste = desgastePorKm(
      menorSulco(anterior),
      menor,
      anterior.km_veiculo,
      km_veiculo
    );
  }

  if (pneu.sulco_inicial_mm == null && menor != null) {
    db.prepare('UPDATE pneus SET sulco_inicial_mm = ? WHERE id = ?').run(menor, pneu_id);
  }

  const data = data_medicao || new Date().toISOString().split('T')[0];
  const responsavelFinal = responsavel?.trim()
    || (req.acessoRapido ? `WhatsApp ${req.acessoRapido.whatsapp_origem || 'acesso-rapido'}` : null);

  // Prazo de 15 dias para iniciar recap quando entra em monitorar
  if (statusSulco === 'alerta') {
    db.prepare(`
      UPDATE pneus SET data_alerta_monitorar = COALESCE(data_alerta_monitorar, ?)
      WHERE id = ?
    `).run(data, pneu_id);
  } else if (statusSulco === 'ok' || statusSulco === 'critico') {
    db.prepare(`UPDATE pneus SET data_alerta_monitorar = NULL WHERE id = ?`).run(pneu_id);
  }

  const veiculo = db.prepare(`SELECT * FROM veiculos WHERE id = ?`).get(pneu.veiculo_id);
  const placa = veiculo?.placa || pneu.placa || null;

  const result = db.prepare(`
    INSERT INTO medicoes (
      pneu_id, data_medicao, km_veiculo, hr_veiculo,
      sulco_externo, sulco_central, sulco_interno, sulco_auxiliar,
      pressao_psi, responsavel, observacoes, marcacao_json,
      diagnostico, acao_sugerida, desgaste_mm_km, veiculo_placa
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pneu_id,
    data,
    km_veiculo || null,
    hr_veiculo ?? null,
    sulco_externo ?? null,
    sulco_central ?? null,
    sulco_interno ?? null,
    sulco_auxiliar ?? null,
    pressao_psi ?? null,
    responsavelFinal,
    observacoes?.trim() || null,
    marcacao_json ? JSON.stringify(marcacao_json) : null,
    diag.codigo,
    acao.codigo,
    desgaste,
    placa
  );

  const medicaoId = result.lastInsertRowid;

  if (km_veiculo) {
    db.prepare(`
      UPDATE veiculos SET km_atual = MAX(km_atual, ?), updated_at = datetime('now', 'localtime')
      WHERE id = ? AND filial_id = ?
    `).run(km_veiculo, pneu.veiculo_id, filialId);
  }

  if (hr_veiculo != null) {
    db.prepare(`
      UPDATE veiculos SET hr_atual = MAX(COALESCE(hr_atual, 0), ?), updated_at = datetime('now', 'localtime')
      WHERE id = ? AND filial_id = ?
    `).run(hr_veiculo, pneu.veiculo_id, filialId);
  }

  const pneuAtualizado = db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu_id);
  const prazoDias = limites.prazo_recap_dias ?? 15;
  let dataLimiteRecap = null;
  let diasRestantes = null;
  if (statusSulco === 'alerta' && pneuAtualizado?.data_alerta_monitorar) {
    dataLimiteRecap = adicionarDias(pneuAtualizado.data_alerta_monitorar, prazoDias);
    const [y, m, d] = String(dataLimiteRecap).split('-').map(Number);
    const fim = new Date(y, m - 1, d);
    const hoje = new Date();
    diasRestantes = Math.ceil(
      (fim - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000
    );
  }

  let notificacao = null;
  try {
    notificacao = await notificarGerentesAposMedicao({
      statusSulco,
      diagnosticoLabel: diag.label,
      acaoLabel: acao.label,
      menorSulco: menor,
      veiculo,
      pneu,
      medicaoId,
    });
  } catch (err) {
    console.error('[medicoes] Falha ao notificar gerentes:', err);
  }

  res.status(201).json({
    id: medicaoId,
    menor_sulco: menor,
    status_sulco: statusSulco,
    diagnostico: diag.codigo,
    diagnostico_label: diag.label,
    diagnostico_desc: diag.descricao,
    acao_sugerida: acao.codigo,
    acao_label: acao.label,
    acao_motivo: acao.motivo,
    desvio_mm: acao.desvio_mm ?? null,
    rodizio_sugestao: acao.rodizio_sugestao || null,
    desgaste_mm_km: desgaste,
    veiculo_placa: placa,
    prazo_recap_dias: prazoDias,
    data_limite_recap: dataLimiteRecap,
    dias_restantes_recap: diasRestantes,
    notificacao_whatsapp: notificacao,
    mensagem: 'Medição registrada',
  });
});

router.delete('/:id', requireAuth, requireFilial, (req, res) => {
  const db = getDb();
  const filialId = filialScopeId(req);
  const med = db.prepare(`
    SELECT m.id FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id
    JOIN veiculos v ON v.id = p.veiculo_id AND v.filial_id = ?
    WHERE m.id = ?
  `).get(filialId, req.params.id);
  if (!med) return res.status(404).json({ erro: 'Medição não encontrada' });

  db.prepare('DELETE FROM medicoes WHERE id = ?').run(req.params.id);
  res.json({ mensagem: 'Medição removida' });
});

export default router;
