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

      const diag = diagnosticarPerfil(p, limites.diagnostico_tolerancia_mm, {
        papel: p.posicao ? papelPosicao(p.posicao) : null,
        posicao: p.posicao || null,
      });
      if (diag.codigo !== 'sem_dado' && diag.codigo !== 'ok') {
        diagnosticos[diag.codigo] = (diagnosticos[diag.codigo] || 0) + 1;
      }
    }

    const porVeiculo = statsPorVeiculo(pneus);
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
      diagnosticos,
      limites,
      filial_id: filialId,
      dia_medicao: normalizarDiaMedicao(filial?.dia_medicao),
      dia_medicao_label: labelDiaMedicao(filial?.dia_medicao),
      semana,
      veiculos,
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
