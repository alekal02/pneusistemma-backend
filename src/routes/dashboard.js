import { Router } from 'express';
import { getDb } from '../database.js';
import { classificarSulco, getLimites, limitesDoVeiculo, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao } from '../diagnostico.js';
import { papelPosicao } from '../pneus-layouts.js';
import { requireAuth, requireFilial, filialScopeId } from '../auth.js';
import { normalizarDiaMedicao, labelDiaMedicao, semanaMedicaoBrasil } from '../dia-medicao.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';

const router = Router();

router.use(requireAuth);
router.use(requireFilial);

function statsPorVeiculo(pneus) {
  const acc = new Map();
  for (const p of pneus) {
    const vid = Number(p.veiculo_id);
    if (!acc.has(vid)) {
      acc.set(vid, {
        total_pneus: 0,
        pneus_medidos: 0,
        menor_sulco: null,
        ultima_medicao: null,
        ultima_atualizacao: null,
      });
    }
    const a = acc.get(vid);
    a.total_pneus += 1;
    const menor = menorSulco(p);
    if (p.data_medicao || menor != null) {
      a.pneus_medidos += 1;
    }
    if (menor != null) {
      a.menor_sulco = a.menor_sulco == null ? menor : Math.min(a.menor_sulco, menor);
    }
    if (p.data_medicao && (!a.ultima_medicao || String(p.data_medicao) > String(a.ultima_medicao))) {
      a.ultima_medicao = p.data_medicao;
    }
    if (p.medicao_created && (!a.ultima_atualizacao || String(p.medicao_created) > String(a.ultima_atualizacao))) {
      a.ultima_atualizacao = p.medicao_created;
    }
  }
  return acc;
}

function compactarPneusPorVeiculo(pneus) {
  const map = new Map();
  for (const p of pneus) {
    const vid = Number(p.veiculo_id);
    if (!map.has(vid)) map.set(vid, []);
    const menor = menorSulco(p);
    map.get(vid).push({
      id: p.id,
      posicao: p.posicao,
      menor_sulco: menor,
      status_sulco: classificarSulco(menor, limitesDoVeiculo(p)),
    });
  }
  return map;
}

async function logsMedicaoFilial(db, filialId, limite = 40) {
  const rows = await db.prepare(`
    SELECT
      m.id,
      m.data_medicao,
      m.created_at,
      LEAST(
        COALESCE(m.sulco_externo, 999),
        COALESCE(m.sulco_central, 999),
        COALESCE(m.sulco_interno, 999),
        COALESCE(m.sulco_auxiliar, 999)
      ) as menor_raw,
      p.posicao,
      p.numero_fogo,
      v.id as veiculo_id,
      v.placa,
      v.apelido,
      v.tipo,
      v.layout_pneus
    FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
    ORDER BY COALESCE(m.created_at, m.data_medicao::timestamp) DESC, m.id DESC
    LIMIT ?
  `).all(filialId, limite);
  return (rows || []).map((r) => {
    const menor = r.menor_raw == null || Number(r.menor_raw) >= 999 ? null : Number(r.menor_raw);
    return {
      id: r.id,
      data_medicao: r.data_medicao,
      created_at: r.created_at,
      menor_sulco: menor,
      status_sulco: classificarSulco(menor, limitesDoVeiculo(r)),
      posicao: r.posicao,
      numero_fogo: r.numero_fogo,
      veiculo_id: r.veiculo_id,
      placa: r.placa,
      apelido: r.apelido,
    };
  });
}

router.get('/resumo', async (req, res, next) => {
  try {
    const db = getDb();
    const limites = getLimites();
    const filialId = filialScopeId(req);

    const [pneus, veiculosRows, filial] = await Promise.all([
      db.prepare(`
        SELECT
          p.id, p.veiculo_id, p.vida_recap, p.condicao, p.numero_fogo, p.posicao,
          v.placa, v.apelido, v.tipo, v.layout_pneus,
          um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar,
          um.data_medicao, um.created_at as medicao_created
        FROM pneus p
        JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
        ${SQL_LATERAL_ULTIMA_MEDICAO}
        WHERE p.ativo = 1 AND p.status_pneu = 'montado'
      `).all(filialId),
      db.prepare(`
        SELECT * FROM veiculos
        WHERE ativo = 1 AND filial_id = ?
        ORDER BY apelido, placa
      `).all(filialId),
      db.prepare('SELECT dia_medicao FROM filiais WHERE id = ?').get(filialId),
    ]);

    let ok = 0;
    let alerta = 0;
    let critico = 0;
    let semDado = 0;
    let troca = 0;
    let recap = 0;
    let monitorar = 0;
    let rodizio = 0;
    const diagnosticos = {};
    const acoesItens = [];
    const diagnosticosItens = [];

    for (const p of pneus) {
      const menor = menorSulco(p);
      const limV = limitesDoVeiculo(p);
      const status = classificarSulco(menor, limV);
      if (status === 'ok') ok += 1;
      else if (status === 'alerta') alerta += 1;
      else if (status === 'critico') critico += 1;
      else semDado += 1;

      const acao = sugerirAcao(menor, limV, p.vida_recap || 0, {
        pontos: p,
        posicaoAtual: p.posicao || null,
      });
      if (acao.codigo === 'troca') troca += 1;
      else if (acao.codigo === 'recap') recap += 1;
      else if (acao.codigo === 'monitorar') monitorar += 1;
      else if (acao.codigo === 'rodizio') rodizio += 1;
      if (acao.codigo && acao.codigo !== 'ok') {
        acoesItens.push({
          pneu_id: p.id,
          veiculo_id: p.veiculo_id,
          placa: p.placa,
          apelido: p.apelido,
          posicao: p.posicao,
          menor_sulco: menor,
          status_sulco: status,
          acao_sugerida: acao.codigo,
          acao_label: acao.label,
          acao_motivo: acao.motivo,
        });
      }

      const diag = diagnosticarPerfil(p, limites.diagnostico_tolerancia_mm, {
        papel: p.posicao ? papelPosicao(p.posicao) : null,
        posicao: p.posicao || null,
      });
      if (diag.codigo !== 'sem_dado' && diag.codigo !== 'ok') {
        diagnosticos[diag.codigo] = (diagnosticos[diag.codigo] || 0) + 1;
        diagnosticosItens.push({
          pneu_id: p.id,
          veiculo_id: p.veiculo_id,
          placa: p.placa,
          apelido: p.apelido,
          posicao: p.posicao,
          menor_sulco: menor,
          status_sulco: status,
          diagnostico: diag.codigo,
          diagnostico_label: diag.label,
          diagnostico_desc: diag.descricao || '',
        });
      }
    }

    const ordemAcao = { troca: 0, recap: 1, rodizio: 2, monitorar: 3 };
    acoesItens.sort((a, b) => (ordemAcao[a.acao_sugerida] ?? 9) - (ordemAcao[b.acao_sugerida] ?? 9)
      || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99));
    const ordemDiag = {
      critico: 0, falta_calib: 1, excesso_calib: 2, irregular: 3, desgaste_progressivo: 4,
    };
    diagnosticosItens.sort((a, b) => (ordemDiag[a.diagnostico] ?? 9) - (ordemDiag[b.diagnostico] ?? 9)
      || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99));

    const porVeiculo = statsPorVeiculo(pneus);
    const pneusMap = compactarPneusPorVeiculo(pneus);
    const logsMedicao = await logsMedicaoFilial(db, filialId);
    const veiculos = veiculosRows.map((v) => {
      const tipo = normalizarTipoVeiculo(v.tipo);
      const a = porVeiculo.get(Number(v.id)) || {
        total_pneus: 0,
        pneus_medidos: 0,
        menor_sulco: null,
        ultima_medicao: null,
        ultima_atualizacao: null,
      };
      return {
        ...v,
        tipo,
        total_pneus: a.total_pneus,
        pneus_medidos: a.pneus_medidos,
        menor_sulco: a.menor_sulco,
        status_sulco: classificarSulco(a.menor_sulco, limitesDoVeiculo({ ...v, tipo })),
        ultima_medicao: a.ultima_medicao,
        ultima_atualizacao: a.ultima_atualizacao,
        dia_medicao: normalizarDiaMedicao(v.dia_medicao),
        pneus: pneusMap.get(Number(v.id)) || [],
      };
    });

    const semana = semanaMedicaoBrasil();

    res.json({
      veiculos_ativos: veiculos.length,
      pneus_total: pneus.length,
      pneus_ok: ok,
      pneus_alerta: alerta,
      pneus_critico: critico,
      pneus_sem_dado: semDado,
      acoes: { troca, recap, monitorar, rodizio },
      acoes_itens: acoesItens,
      diagnosticos,
      diagnosticos_itens: diagnosticosItens,
      limites,
      filial_id: filialId,
      dia_medicao: normalizarDiaMedicao(filial?.dia_medicao),
      dia_medicao_label: labelDiaMedicao(filial?.dia_medicao),
      semana,
      veiculos,
      logs_medicao: logsMedicao,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/dia-medicao', async (req, res, next) => {
  try {
    const filialId = filialScopeId(req);
    if (!filialId) {
      return res.status(400).json({ erro: 'Usuário sem unidade vinculada' });
    }
    const dia = normalizarDiaMedicao(req.body?.dia_medicao);
    const db = getDb();
    await db.prepare(`
      UPDATE filiais SET dia_medicao = ?, updated_at = NOW() WHERE id = ? AND ativo = 1
    `).run(dia, filialId);
    res.json({
      mensagem: dia
        ? `Dia da medição da frota: ${labelDiaMedicao(dia)}`
        : 'Dia da medição da frota removido',
      dia_medicao: dia,
      dia_medicao_label: labelDiaMedicao(dia),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
