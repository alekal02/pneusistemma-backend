import { Router } from 'express';
import { getDb, classificarSulco } from '../database.js';
import { getLimites, limitesDoVeiculo, menorSulco, adicionarDias, alertaSulcoMaxMm } from '../limites.js';
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
async function requireAuthOrAcessoRapido(req, res, next) {
  const tokenAcesso = req.headers['x-acesso-rapido-token']
    || req.body?.token_acesso
    || req.query?.token_acesso;

  try {
    if (tokenAcesso) {
      const tokenRow = await validarTokenAcessoRapido(String(tokenAcesso));
      if (!tokenRow) {
        return res.status(401).json({ erro: 'Token de acesso rápido inválido ou expirado' });
      }
      await marcarTokenUsado(tokenRow.id);
      req.acessoRapido = tokenRow;
      return next();
    }

    return await requireAuth(req, res, (err) => {
      if (err) return next(err);
      return requireFilial(req, res, next);
    });
  } catch (err) {
    return next(err);
  }
}

router.get('/alertas', requireAuth, requireFilial, async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);

    const alertas = await db.prepare(`
    SELECT
      m.*,
      p.posicao, p.marca as pneu_marca, p.modelo as pneu_modelo,
      p.numero_fogo, p.tipo_pneu, p.condicao, p.vida_recap, p.sulco_inicial_mm,
      v.placa, v.apelido, v.tipo, v.layout_pneus,
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
  `).all(filialId, alertaSulcoMaxMm());

    const resultado = alertas.map((a) => {
      const menor = a.menor_sulco_raw === 999 ? null : a.menor_sulco_raw;
      const limV = limitesDoVeiculo(a);
      const diag = diagnosticarPerfil(a, limV.diagnostico_tolerancia_mm);
      const acao = sugerirAcao(menor, limV, a.vida_recap || 0);
      return {
        ...a,
        menor_sulco: menor,
        status_sulco: classificarSulco(menor, limV),
        diagnostico: diag.codigo,
        diagnostico_label: diag.label,
        acao_sugerida: acao.codigo,
        acao_label: acao.label,
        acao_motivo: acao.motivo,
      };
    });

    res.json(resultado.filter((a) => a.status_sulco === 'alerta' || a.status_sulco === 'critico'));
  } catch (err) {
    next(err);
  }
});

router.get('/acoes', requireAuth, requireFilial, async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);

    const pneus = await db.prepare(`
    SELECT
      p.*,
      v.placa, v.apelido, v.tipo, v.layout_pneus,
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
        const limV = limitesDoVeiculo(p);
        const diag = diagnosticarPerfil(p, limV.diagnostico_tolerancia_mm);
        const acao = sugerirAcao(menor, limV, p.vida_recap || 0);
        return {
          pneu_id: p.id,
          veiculo_id: p.veiculo_id,
          placa: p.placa,
          apelido: p.apelido,
          posicao: p.posicao,
          numero_fogo: p.numero_fogo,
          menor_sulco: menor,
          status_sulco: classificarSulco(menor, limV),
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
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuthOrAcessoRapido, async (req, res, next) => {
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

  try {
    if (req.acessoRapido) {
      filialId = req.acessoRapido.filial_id;
      pneu = await assertPneuDaFilial(pneu_id, filialId);
      if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });
      // R3: só o veículo do token
      if (Number(pneu.veiculo_id) !== Number(req.acessoRapido.veiculo_id)) {
        return res.status(403).json({ erro: 'Este token não permite medir este veículo' });
      }
    } else {
      filialId = filialScopeId(req);
      pneu = await assertPneuDaFilial(pneu_id, filialId);
      if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });
    }
  } catch (err) {
    return next(err);
  }

  const limites = pneu.veiculo_id
    ? limitesDoVeiculo({ tipo: pneu.veiculo_tipo, layout_pneus: pneu.layout_pneus })
    : getLimites();
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
    posicao: pneu.posicao || null,
    limites,
  });

  let acao;
  let statusSulco;
  let desgaste = null;
  let veiculo;
  let placa;
  let medicaoId;
  let prazoDias;
  let dataLimiteRecap = null;
  let diasRestantes = null;
  let reaproveitar = false;

  try {
    let candidatos = [];
    if (pneu.veiculo_id) {
      const rows = await db.prepare(`
        SELECT p.id, p.posicao, p.numero_fogo,
          (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
          (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
          (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
          (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux
        FROM pneus p
        WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
      `).all(pneu.veiculo_id, pneu_id);
      candidatos = rows.map((c) => ({
        ...c,
        posicao_label: c.posicao,
        sulco_externo: c.ult_sulco_ext,
        sulco_central: c.ult_sulco_cent,
        sulco_interno: c.ult_sulco_int,
        sulco_auxiliar: c.ult_sulco_aux,
      }));
    }

    acao = sugerirAcao(menor, limites, pneu.vida_recap || 0, {
      pontos: medicaoRow,
      candidatos,
      posicaoAtual: pneu.posicao || null,
    });
    statusSulco = classificarSulco(menor, limites);

    const anterior = await db.prepare(`
      SELECT * FROM medicoes WHERE pneu_id = ?
      ORDER BY data_medicao DESC, id DESC LIMIT 1
    `).get(pneu_id);

    if (anterior && km_veiculo != null) {
      desgaste = desgastePorKm(
        menorSulco(anterior),
        menor,
        anterior.km_veiculo,
        km_veiculo
      );
    }

    if (pneu.status_pneu === 'estoque' || pneu.status_pneu === 'recapagem') {
      // Em estoque/recap a medição atualiza o sulco de referência do inventário
      await db.prepare('UPDATE pneus SET sulco_inicial_mm = ? WHERE id = ?').run(menor, pneu_id);
    } else if (pneu.sulco_inicial_mm == null && menor != null) {
      await db.prepare('UPDATE pneus SET sulco_inicial_mm = ? WHERE id = ?').run(menor, pneu_id);
    }

    const data = data_medicao || new Date().toISOString().split('T')[0];
    const responsavelFinal = responsavel?.trim()
      || (req.acessoRapido ? `WhatsApp ${req.acessoRapido.whatsapp_origem || 'acesso-rapido'}` : null);
    const mesmoNumero = (a, b) => {
      if (a == null && b == null) return true;
      if (a == null || b == null) return false;
      return Number(a) === Number(b);
    };
    reaproveitar = Boolean(
      anterior
      && String(anterior.data_medicao) === String(data)
      && mesmoNumero(anterior.sulco_externo, sulco_externo)
      && mesmoNumero(anterior.sulco_central, sulco_central)
      && mesmoNumero(anterior.sulco_interno, sulco_interno)
      && mesmoNumero(anterior.sulco_auxiliar, sulco_auxiliar)
    );

    // Prazo de 15 dias para iniciar recap quando entra em monitorar
    if (statusSulco === 'alerta') {
      await db.prepare(`
        UPDATE pneus SET data_alerta_monitorar = COALESCE(data_alerta_monitorar, ?)
        WHERE id = ?
      `).run(data, pneu_id);
    } else if (statusSulco === 'ok' || statusSulco === 'critico') {
      await db.prepare(`UPDATE pneus SET data_alerta_monitorar = NULL WHERE id = ?`).run(pneu_id);
    }

    veiculo = await db.prepare(`SELECT * FROM veiculos WHERE id = ?`).get(pneu.veiculo_id);
    placa = veiculo?.placa || pneu.placa || null;

    if (reaproveitar) {
      await db.prepare(`
        UPDATE medicoes SET
          km_veiculo = ?,
          hr_veiculo = ?,
          pressao_psi = ?,
          responsavel = ?,
          observacoes = ?,
          marcacao_json = ?,
          diagnostico = ?,
          acao_sugerida = ?,
          desgaste_mm_km = ?,
          veiculo_placa = ?
        WHERE id = ?
      `).run(
        km_veiculo || null,
        hr_veiculo ?? null,
        pressao_psi ?? null,
        responsavelFinal,
        observacoes?.trim() || null,
        marcacao_json ? JSON.stringify(marcacao_json) : null,
        diag.codigo,
        acao.codigo,
        desgaste,
        placa,
        anterior.id
      );
      medicaoId = anterior.id;
    } else {
      const result = await db.prepare(`
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
      medicaoId = result.lastInsertRowid;
    }

    if (km_veiculo && pneu.veiculo_id) {
      await db.prepare(`
        UPDATE veiculos SET km_atual = MAX(km_atual, ?), updated_at = NOW()
        WHERE id = ? AND filial_id = ?
      `).run(km_veiculo, pneu.veiculo_id, filialId);
    }

    if (hr_veiculo != null && pneu.veiculo_id) {
      await db.prepare(`
        UPDATE veiculos SET hr_atual = MAX(COALESCE(hr_atual, 0), ?), updated_at = NOW()
        WHERE id = ? AND filial_id = ?
      `).run(hr_veiculo, pneu.veiculo_id, filialId);
    }

    const pneuAtualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu_id);
    prazoDias = limites.prazo_recap_dias ?? 15;
    if (statusSulco === 'alerta' && pneuAtualizado?.data_alerta_monitorar) {
      dataLimiteRecap = adicionarDias(pneuAtualizado.data_alerta_monitorar, prazoDias);
      const [y, m, d] = String(dataLimiteRecap).split('-').map(Number);
      const fim = new Date(y, m - 1, d);
      const hoje = new Date();
      diasRestantes = Math.ceil(
        (fim - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000
      );
    }
  } catch (err) {
    return next(err);
  }

  let notificacao = null;
  try {
    if (!reaproveitar) {
      notificacao = await notificarGerentesAposMedicao({
        statusSulco,
        diagnosticoLabel: diag.label,
        acaoLabel: acao.label,
        menorSulco: menor,
        veiculo,
        pneu,
        medicaoId,
      });
    }
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

router.delete('/:id', requireAuth, requireFilial, async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const med = await db.prepare(`
      SELECT m.id FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      JOIN veiculos v ON v.id = p.veiculo_id AND v.filial_id = ?
      WHERE m.id = ?
    `).get(filialId, req.params.id);
    if (!med) return res.status(404).json({ erro: 'Medição não encontrada' });

    await db.prepare('DELETE FROM medicoes WHERE id = ?').run(req.params.id);
    res.json({ mensagem: 'Medição removida' });
  } catch (err) {
    next(err);
  }
});

export default router;
