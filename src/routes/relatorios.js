import { Router } from 'express';
import { getDb } from '../database.js';
import {
  requireAuth,
  requireAdmin,
  requireGerenteOuAdmin,
  requirePresidente,
  filiaisEscopoIds,
} from '../auth.js';
import { getLimites, limitesDoVeiculo } from '../limites.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { toCsv } from '../csv-utils.js';
import { gerarRelatorioSemanalPdfBuffer } from '../services/relatorio-semanal-pdf.js';
import {
  consultarDiagnosticoFrota,
  rejeitarFilialForaDoEscopo,
} from '../services/diagnostico-frota.js';
import { gerarPdfDiagnosticoFrota } from '../services/diagnostico-frota-pdf.js';
import { carregarRelatorioSaude } from '../services/saude-desgaste-relatorio.js';
import { gerarPdfSaudeBuffer, nomeArquivoSaude } from '../services/saude-desgaste-pdf.js';
import {
  acumularAlerta,
  avaliarPneuPainel,
  filtroTipoAtivo,
  indicadoresUso,
  novoAcumulador,
  unidadeUsoVeiculo,
  veiculoCombinaTipo,
} from '../services/indicadores-frota.js';

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
    const { buffer, filename } = await gerarRelatorioSemanalPdfBuffer(filialId, {
      geradoPor,
      tipo: req.query.tipo,
    });

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
async function montarRelatorioDiretoria(tipoFiltro = null) {
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
  const accKmGeral = novoAcumulador();
  const accHorasGeral = novoAcumulador();
  const veiculosUsoGeral = [];

  for (const f of filiais) {
    const veiculosRows = await db.prepare(`
      SELECT id, tipo, layout_pneus, km_atual, hr_atual
      FROM veiculos WHERE filial_id = ? AND ativo = 1
    `).all(f.id);
    const veiculosLista = veiculosRows.filter((v) => veiculoCombinaTipo(v.tipo, tipoFiltro));
    const veiculos = veiculosLista.length;
    veiculosUsoGeral.push(...veiculosLista);

    const pneus = await db.prepare(`
      SELECT
        p.id, p.vida_recap, p.status_pneu, p.custo, p.nota_fiscal, p.modelo, p.marca, p.numero_fogo,
        p.posicao,
        v.tipo, v.layout_pneus, v.km_atual, v.hr_atual,
        um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar, um.sulco_mm,
        um.inspecao_danos
      FROM pneus p
      LEFT JOIN veiculos v ON v.id = p.veiculo_id
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1 AND p.filial_id = ? AND p.status_pneu != 'descarte'
    `).all(f.id);

    const acc = novoAcumulador();
    const accKm = novoAcumulador();
    const accHoras = novoAcumulador();
    let custoEstoque = 0;
    let custoMontado = 0;
    let montados = 0;

    for (const p of pneus) {
      if (p.status_pneu === 'estoque' || p.status_pneu === 'recapagem') {
        if (p.custo != null) custoEstoque += Number(p.custo);
        continue;
      }
      if (p.status_pneu !== 'montado') continue;
      if (!veiculoCombinaTipo(p.tipo, tipoFiltro)) continue;
      montados += 1;
      if (p.custo != null) custoMontado += Number(p.custo);

      const aval = avaliarPneuPainel(p, { limites: limitesDoVeiculo(p) });
      const unidade = unidadeUsoVeiculo(p.tipo, p.layout_pneus);
      acumularAlerta(acc, aval);
      acumularAlerta(unidade === 'horas' ? accHoras : accKm, aval);
      acumularAlerta(unidade === 'horas' ? accHorasGeral : accKmGeral, aval);
    }
    const ok = acc.ok;
    const alerta = acc.monitorar;
    const critico = acc.critico;
    const semDado = acc.sem_dado;
    const troca = acc.troca;
    const monitorar = acc.acao_monitorar + acc.rodizio;
    const usoFilial = indicadoresUso(veiculosLista, accKm, accHoras);

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
      media_km: usoFilial.km.media,
      veiculos_km: usoFilial.km.veiculos,
      media_horas: usoFilial.horas.media,
      veiculos_horas: usoFilial.horas.veiculos,
      indicadores_uso: usoFilial,
    });
  }

  const usoGeral = indicadoresUso(veiculosUsoGeral, accKmGeral, accHorasGeral);

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
      indicadores_uso: usoGeral,
    },
    filtro_tipo: filtroTipoAtivo(tipoFiltro),
    por_filial: porFilial,
    leitura_diretoria: [
      `${totCritico} pneu(s) em crítico / ação necessária`,
      `${totOk} pneu(s) OK · ${totAlerta} pneu(s) em monitorar`,
      `Média KM (só equipamentos em km): ${usoGeral.km.media ?? '—'} (${usoGeral.km.veiculos} veículo(s))`,
      `Média horas (só equipamentos em horas): ${usoGeral.horas.media ?? '—'} (${usoGeral.horas.veiculos} veículo(s))`,
      `Custo estimado em pneus montados: R$ ${totCustoMontado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      `Custo em estoque: R$ ${totCustoEstoque.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
    ],
  };
}

router.get('/diretoria', requireAdmin, async (req, res, next) => {
  try {
    res.json(await montarRelatorioDiretoria(req.query.tipo));
  } catch (err) {
    next(err);
  }
});

router.get('/diretoria.csv', requireAdmin, async (req, res, next) => {
  try {
    const rel = await montarRelatorioDiretoria(req.query.tipo);
    const headers = [
      'filial', 'codigo', 'veiculos', 'pneus_montados',
      'sulco_ok', 'sulco_monitorar', 'sulco_critico', 'sem_medicao',
      'acao_trocar', 'acao_monitorar', 'custo_montado', 'custo_estoque',
      'media_km', 'media_horas',
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
      media_km: r.media_km ?? '',
      media_horas: r.media_horas ?? '',
    }));
    const csv = toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorio-diretoria-pneus.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

function filtrosDiagnostico(query) {
  const data = (valor) => {
    if (valor == null || valor === '') return null;
    const s = String(valor).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return s;
  };
  const inicio = data(query.periodo_inicio);
  const fim = data(query.periodo_fim);
  if (inicio === false || fim === false) {
    return { erro: 'Período inválido. Use AAAA-MM-DD.' };
  }
  if (inicio && fim && inicio > fim) {
    return { erro: 'A data inicial do período é posterior à final.' };
  }
  const pendencia = String(query.pendencia || '').trim().toLowerCase();
  if (pendencia && !['critica', 'atencao', 'cadastral'].includes(pendencia)) {
    return { erro: 'Pendência inválida.' };
  }
  return {
    filtros: {
      filial_id: query.filial_id,
      placa: query.placa,
      tipo: query.tipo,
      pendencia,
      periodo_inicio: inicio,
      periodo_fim: fim,
    },
  };
}

async function diagnosticoNoEscopo(req) {
  const escopo = filiaisEscopoIds(req);
  const fora = rejeitarFilialForaDoEscopo(escopo, req.query.filial_id);
  if (fora) return fora;
  const parsed = filtrosDiagnostico(req.query);
  if (parsed.erro) return { status: 400, erro: parsed.erro };
  const relatorio = await consultarDiagnosticoFrota(getDb(), {
    escopo,
    filtros: parsed.filtros,
  });
  return { relatorio };
}

router.get('/diagnostico-frota', requireGerenteOuAdmin, async (req, res, next) => {
  try {
    const out = await diagnosticoNoEscopo(req);
    if (out.erro) return res.status(out.status).json({ erro: out.erro });
    res.json(out.relatorio);
  } catch (err) {
    next(err);
  }
});

router.get('/diagnostico-frota.pdf', requireGerenteOuAdmin, async (req, res, next) => {
  try {
    const out = await diagnosticoNoEscopo(req);
    if (out.erro) return res.status(out.status).json({ erro: out.erro });
    const buffer = await gerarPdfDiagnosticoFrota(out.relatorio);
    const dia = (out.relatorio.semana?.hoje || new Date().toISOString().slice(0, 10));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="diagnostico-frota-${dia}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * Saúde e desgaste — somente o perfil presidente. Somente leitura.
 * GET /api/relatorios/saude-desgaste
 * GET /api/relatorios/saude-desgaste.pdf
 */
router.get('/saude-desgaste', requirePresidente, async (req, res, next) => {
  try {
    const filialId = req.query.filial_id != null && req.query.filial_id !== ''
      ? Number(req.query.filial_id)
      : null;
    res.json(await carregarRelatorioSaude(getDb(), { filialId }));
  } catch (err) {
    next(err);
  }
});

router.get('/saude-desgaste.pdf', requirePresidente, async (req, res, next) => {
  try {
    const filialId = req.query.filial_id != null && req.query.filial_id !== ''
      ? Number(req.query.filial_id)
      : null;
    const rel = await carregarRelatorioSaude(getDb(), { filialId });
    const buffer = await gerarPdfSaudeBuffer(rel);
    const filename = nomeArquivoSaude(rel.gerado_em);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

export default router;
