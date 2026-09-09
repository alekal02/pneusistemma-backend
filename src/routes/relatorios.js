import { Router } from 'express';
import { getDb } from '../database.js';
import {
  requireAuth,
  requireAdmin,
  requireGerenteOuAdmin,
  filiaisEscopoIds,
} from '../auth.js';
import { classificarSulco, getLimites, limitesDoVeiculo, menorSulco } from '../limites.js';
import { sugerirAcao } from '../diagnostico.js';
import { toCsv } from '../csv-utils.js';
import { gerarRelatorioSemanalPdfBuffer } from '../services/relatorio-semanal-pdf.js';

const router = Router();

router.use(requireAuth);

function assertFilialNoEscopo(req, filialId) {
  const escopo = filiaisEscopoIds(req);
  if (escopo === null) return true;
  return escopo.includes(Number(filialId));
}

/**
 * Relatório PDF semanal gerencial da unidade (gerente/admin).
 * GET /api/relatorios/unidade/semanal.pdf?filial_id=
 */
router.get('/unidade/semanal.pdf', requireGerenteOuAdmin, async (req, res, next) => {
  try {
    let filialId = req.query.filial_id != null ? Number(req.query.filial_id) : null;
    if (!filialId || Number.isNaN(filialId)) {
      filialId = req.user.filial_id ? Number(req.user.filial_id) : null;
    }
    if (!filialId) {
      const escopo = filiaisEscopoIds(req);
      if (escopo?.length) {
        filialId = escopo[0];
      } else {
        const row = await getDb().prepare(`
          SELECT id FROM filiais WHERE ativo = 1 ORDER BY nome LIMIT 1
        `).get();
        filialId = row?.id || null;
      }
    }
    if (!filialId) {
      return res.status(400).json({ erro: 'Informe filial_id' });
    }
    if (!assertFilialNoEscopo(req, filialId)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }

    const geradoPor = [req.user.papel, req.user.login].filter(Boolean).join(' · ');
    const { buffer, filename } = await gerarRelatorioSemanalPdfBuffer(filialId, { geradoPor });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Relatório executivo para diretoria — consolidado por filial + frota.
 * GET /api/relatorios/diretoria
 * GET /api/relatorios/diretoria.csv
 */
async function montarRelatorioDiretoria() {
  const db = getDb();
  const limites = getLimites();

  const filiais = await db.prepare(`
    SELECT id, nome, codigo, contrato, ativo FROM filiais ORDER BY nome
  `).all();

  const porFilial = [];
  let totVeiculos = 0;
  let totPneus = 0;
  let totOk = 0;
  let totAlerta = 0;
  let totCritico = 0;
  let totSemDado = 0;
  let totTroca = 0;
  let totMonitorar = 0;
  let totCustoEstoque = 0;
  let totCustoMontado = 0;

  for (const f of filiais) {
    const veiculos = Number((await db.prepare(`
      SELECT COUNT(*) as n FROM veiculos WHERE filial_id = ? AND ativo = 1
    `).get(f.id)).n);

    const pneus = await db.prepare(`
      SELECT
        p.id, p.vida_recap, p.status_pneu, p.custo, p.nota_fiscal, p.modelo, p.marca, p.numero_fogo,
        v.tipo, v.layout_pneus,
        (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_externo,
        (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_central,
        (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_interno,
        (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_auxiliar
      FROM pneus p
      LEFT JOIN veiculos v ON v.id = p.veiculo_id
      WHERE p.ativo = 1 AND p.filial_id = ? AND p.status_pneu != 'descarte'
    `).all(f.id);

    let ok = 0;
    let alerta = 0;
    let critico = 0;
    let semDado = 0;
    let troca = 0;
    let monitorar = 0;
    let custoEstoque = 0;
    let custoMontado = 0;
    let montados = 0;

    for (const p of pneus) {
      if (p.status_pneu === 'estoque' || p.status_pneu === 'recapagem') {
        if (p.custo != null) custoEstoque += Number(p.custo);
        continue;
      }
      if (p.status_pneu !== 'montado') continue;
      montados += 1;
      if (p.custo != null) custoMontado += Number(p.custo);

      const menor = menorSulco(p);
      const limV = limitesDoVeiculo(p);
      const status = classificarSulco(menor, limV);
      if (status === 'ok') ok += 1;
      else if (status === 'alerta') alerta += 1;
      else if (status === 'critico') critico += 1;
      else semDado += 1;

      const acao = sugerirAcao(menor, limV, p.vida_recap || 0);
      if (acao.codigo === 'troca') troca += 1;
      else if (acao.codigo === 'monitorar' || acao.codigo === 'rodizio') monitorar += 1;
    }

    totVeiculos += veiculos;
    totPneus += montados;
    totOk += ok;
    totAlerta += alerta;
    totCritico += critico;
    totSemDado += semDado;
    totTroca += troca;
    totMonitorar += monitorar;
    totCustoEstoque += custoEstoque;
    totCustoMontado += custoMontado;

    porFilial.push({
      filial_id: f.id,
      filial: f.nome,
      codigo: f.codigo,
      contrato: f.contrato || null,
      ativo: !!f.ativo,
      veiculos,
      pneus_montados: montados,
      sulco_ok: ok,
      sulco_monitorar: alerta,
      sulco_critico: critico,
      sem_medicao: semDado,
      acao_trocar: troca,
      acao_monitorar: monitorar,
      custo_montado: Math.round(custoMontado * 100) / 100,
      custo_estoque: Math.round(custoEstoque * 100) / 100,
    });
  }

  const usuarios = Number((await db.prepare(`
    SELECT COUNT(*) as n FROM usuarios WHERE ativo = 1
  `).get()).n);

  const geradosEm = new Date().toISOString();

  return {
    titulo: 'Relatório executivo — Controle de Pneus',
    gerado_em: geradosEm,
    limites: {
      critico_mm: limites.sulco_critico_mm,
      monitorar_ate_mm: limites.sulco_alerta_mm,
      prazo_recap_dias: limites.prazo_recap_dias,
    },
    consolidado: {
      filiais_ativas: filiais.filter((f) => f.ativo).length,
      veiculos: totVeiculos,
      pneus_montados: totPneus,
      sulco_ok: totOk,
      sulco_monitorar: totAlerta,
      sulco_critico: totCritico,
      sem_medicao: totSemDado,
      acao_trocar: totTroca,
      acao_monitorar: totMonitorar,
      custo_montado: Math.round(totCustoMontado * 100) / 100,
      custo_estoque: Math.round(totCustoEstoque * 100) / 100,
      custo_total_pneus: Math.round((totCustoMontado + totCustoEstoque) * 100) / 100,
      usuarios_ativos: usuarios,
    },
    por_filial: porFilial,
    leitura_diretoria: [
      `${totCritico} pneu(s) em estado crítico (troca imediata)`,
      `${totAlerta} pneu(s) em monitorar — programar substituição / recap em até ${limites.prazo_recap_dias} dias`,
      `Custo estimado em pneus montados: R$ ${totCustoMontado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      `Custo em estoque: R$ ${totCustoEstoque.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
    ],
  };
}

router.get('/diretoria', requireAdmin, async (_req, res, next) => {
  try {
    res.json(await montarRelatorioDiretoria());
  } catch (err) {
    next(err);
  }
});

router.get('/diretoria.csv', requireAdmin, async (_req, res, next) => {
  try {
    const rel = await montarRelatorioDiretoria();
    const headers = [
      'filial', 'codigo', 'veiculos', 'pneus_montados',
      'sulco_ok', 'sulco_monitorar', 'sulco_critico', 'sem_medicao',
      'acao_trocar', 'acao_monitorar', 'custo_montado', 'custo_estoque',
    ];
    const rows = rel.por_filial.map((r) => ({
      filial: r.filial,
      codigo: r.codigo,
      veiculos: r.veiculos,
      pneus_montados: r.pneus_montados,
      sulco_ok: r.sulco_ok,
      sulco_monitorar: r.sulco_monitorar,
      sulco_critico: r.sulco_critico,
      sem_medicao: r.sem_medicao,
      acao_trocar: r.acao_trocar,
      acao_monitorar: r.acao_monitorar,
      custo_montado: r.custo_montado,
      custo_estoque: r.custo_estoque,
    }));
    const csv = toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorio-diretoria-pneus.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
