/**
 * Relatório PDF semanal gerencial da unidade (frota + pneus).
 */
import PDFDocument from 'pdfkit';
import { getDb } from '../database.js';
import { classificarSulco, getLimites, limitesDoVeiculo, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao } from '../diagnostico.js';
import {
  labelPosicao,
  labelTipoPneu,
  labelTratamentoDescarte,
  sqlOrderPosicao,
} from '../pneus-layouts.js';
import { desenharRelatorioVisual } from './relatorio-frota-visual-pdf.js';
import { SQL_LOGS_MEDICAO_SEMANA } from '../sql-ultima-medicao.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

const TZ_BR = 'America/Sao_Paulo';

export function partesDataBrasil(iso) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_BR,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso || Date.now()));
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return {
    yyyy: get('year'),
    mm: get('month'),
    dd: get('day'),
    hh: get('hour'),
    mi: get('minute'),
  };
}

export function formatarDataHoraBrasil(iso) {
  const p = partesDataBrasil(iso);
  return `${p.dd}/${p.mm}/${p.yyyy} ${p.hh}:${p.mi}`;
}

/** Data YYYY-MM-DD no fuso local do servidor */
function dataISO(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatBr(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

function formatMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNum(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('pt-BR');
}

/** Segunda-feira da semana corrente até hoje */
export function periodoSemanaCorrente(agora = new Date()) {
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const dia = hoje.getDay(); // 0=dom
  const diffSeg = dia === 0 ? -6 : 1 - dia;
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() + diffSeg);
  return {
    inicio: dataISO(inicio),
    fim: dataISO(hoje),
    label: `${formatBr(dataISO(inicio))} a ${formatBr(dataISO(hoje))}`,
  };
}

function labelStatusSulco(s) {
  return ({
    ok: 'OK',
    alerta: 'Monitorar',
    critico: 'Crítico',
    sem_dado: 'Sem medição',
  })[s] || s || '—';
}

function mm(v) {
  return v == null ? '—' : `${Number(v)} mm`;
}

/**
 * Monta o snapshot gerencial da filial para a semana corrente.
 */
export async function montarDadosRelatorioSemanal(filialId, { geradoPor = null } = {}) {
  const db = getDb();
  const limites = getLimites();
  const periodo = periodoSemanaCorrente();

  const filial = await db.prepare(`
    SELECT id, nome, codigo, contrato FROM filiais WHERE id = ?
  `).get(filialId);
  if (!filial) {
    const err = new Error('Filial não encontrada');
    err.status = 404;
    throw err;
  }

  const veiculos = await db.prepare(`
    SELECT id, placa, apelido, tipo, marca, modelo, ano, layout_pneus,
           km_atual, hr_atual, ativo
    FROM veiculos
    WHERE filial_id = ? AND ativo = 1
    ORDER BY placa
  `).all(filialId);

  const orderPos = sqlOrderPosicao('p.posicao');

  const frota = [];
  let totOk = 0;
  let totAlerta = 0;
  let totCritico = 0;
  let totSemDado = 0;
  let totTroca = 0;
  let totRecap = 0;
  let totMonitorar = 0;
  let totRodizio = 0;
  let totMontados = 0;
  let custoMontado = 0;
  let veiculosAtrasados = 0;

  const prioridadesTroca = [];
  const prioridadesMonitorar = [];
  const prioridadesRodizio = [];

  for (const v of veiculos) {
    const limV = limitesDoVeiculo(v);
    const pneus = await db.prepare(`
      SELECT
        p.*,
        m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar,
        m.data_medicao, m.pressao_psi, m.diagnostico as med_diagnostico,
        m.acao_sugerida as med_acao
      FROM pneus p
      LEFT JOIN medicoes m ON m.pneu_id = p.id
        AND m.id = (
          SELECT id FROM medicoes
          WHERE pneu_id = p.id
          ORDER BY data_medicao DESC, id DESC
          LIMIT 1
        )
      WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
      ORDER BY ${orderPos}, p.id
    `).all(v.id);

    const candidatos = pneus.map((p) => ({
      id: p.id,
      posicao: p.posicao,
      sulco_externo: p.sulco_externo,
      sulco_central: p.sulco_central,
      sulco_interno: p.sulco_interno,
      sulco_auxiliar: p.sulco_auxiliar,
    }));

    let ultimaMedicaoVeiculo = null;
    let piorStatus = 'ok';
    const ordemStatus = { critico: 0, alerta: 1, sem_dado: 2, ok: 3 };
    const pneusDetalhe = [];

    for (const p of pneus) {
      totMontados += 1;
      if (p.custo != null) custoMontado += Number(p.custo);

      const pontos = {
        sulco_externo: p.sulco_externo,
        sulco_central: p.sulco_central,
        sulco_interno: p.sulco_interno,
        sulco_auxiliar: p.sulco_auxiliar,
        externo: p.sulco_externo,
        central: p.sulco_central,
        interno: p.sulco_interno,
        auxiliar: p.sulco_auxiliar,
      };
      const menor = menorSulco(pontos);
      const status = classificarSulco(menor, limV);
      const diag = diagnosticarPerfil(pontos, limV.diagnostico_tolerancia_mm, {
        limites: limV,
        posicao: p.posicao,
      });
      const acao = sugerirAcao(menor, limV, p.vida_recap || 0, {
        pontos,
        candidatos,
        posicaoAtual: p.posicao,
      });

      if (status === 'ok') totOk += 1;
      else if (status === 'alerta') totAlerta += 1;
      else if (status === 'critico') totCritico += 1;
      else totSemDado += 1;

      if (acao.codigo === 'troca') totTroca += 1;
      else if (acao.codigo === 'recap') totRecap += 1;
      else if (acao.codigo === 'monitorar') totMonitorar += 1;
      else if (acao.codigo === 'rodizio') totRodizio += 1;

      if (ordemStatus[status] < ordemStatus[piorStatus]) piorStatus = status;
      if (p.data_medicao && (!ultimaMedicaoVeiculo || p.data_medicao > ultimaMedicaoVeiculo)) {
        ultimaMedicaoVeiculo = p.data_medicao;
      }

      const item = {
        fogo: p.numero_fogo || `ID ${p.id}`,
        posicao: p.posicao,
        posicao_label: labelPosicao(p.posicao),
        padrao: labelTipoPneu(p.tipo_pneu),
        marca: p.marca || null,
        modelo: p.modelo || null,
        vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
        sulcos: {
          ext: p.sulco_externo,
          cent: p.sulco_central,
          int: p.sulco_interno,
          aux: p.sulco_auxiliar,
        },
        menor_sulco: menor,
        status_sulco: status,
        status_label: labelStatusSulco(status),
        diagnostico: diag.label || '—',
        acao: acao.label || acao.codigo,
        acao_codigo: acao.codigo,
        motivo: acao.motivo || null,
        data_medicao: p.data_medicao,
        custo: p.custo,
        nota_fiscal: p.nota_fiscal,
        placa: v.placa,
        apelido: v.apelido,
      };
      pneusDetalhe.push(item);

      if (acao.codigo === 'troca' || status === 'critico') {
        prioridadesTroca.push(item);
      } else if (acao.codigo === 'monitorar' || acao.codigo === 'recap' || status === 'alerta') {
        prioridadesMonitorar.push(item);
      } else if (acao.codigo === 'rodizio') {
        prioridadesRodizio.push(item);
      }
    }

    let diasSemMedicao = null;
    if (ultimaMedicaoVeiculo) {
      const diff = Date.now() - new Date(`${ultimaMedicaoVeiculo}T12:00:00`).getTime();
      diasSemMedicao = Math.floor(diff / (1000 * 60 * 60 * 24));
    }
    const atrasado = pneus.length > 0 && (diasSemMedicao == null || diasSemMedicao >= 7);
    if (atrasado) veiculosAtrasados += 1;

    frota.push({
      id: v.id,
      placa: v.placa,
      apelido: v.apelido,
      tipo: v.tipo,
      marca: v.marca,
      modelo: v.modelo,
      layout: v.layout_pneus,
      km_atual: v.km_atual,
      hr_atual: v.hr_atual,
      total_pneus: pneus.length,
      status_sulco: pneus.length ? piorStatus : 'sem_dado',
      status_label: pneus.length ? labelStatusSulco(piorStatus) : 'Sem pneus',
      ultima_medicao: ultimaMedicaoVeiculo,
      dias_sem_medicao: diasSemMedicao,
      atrasado_semana: atrasado,
      menor_sulco: pneusDetalhe.reduce((acc, p) => {
        if (p.menor_sulco == null) return acc;
        return acc == null ? p.menor_sulco : Math.min(acc, p.menor_sulco);
      }, null),
      pneus: pneusDetalhe,
    });
  }

  const estoqueRows = await db.prepare(`
    SELECT
      p.id, p.numero_fogo, p.marca, p.modelo, p.medida, p.tipo_pneu, p.condicao, p.vida_recap,
      p.custo, p.nota_fiscal, p.sulco_inicial_mm, p.observacoes, p.status_pneu,
      m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.data_medicao
    FROM pneus p
    LEFT JOIN medicoes m ON m.pneu_id = p.id
      AND m.id = (
        SELECT id FROM medicoes WHERE pneu_id = p.id
        ORDER BY data_medicao DESC, id DESC LIMIT 1
      )
    WHERE p.filial_id = ? AND p.ativo = 1 AND p.status_pneu = 'estoque'
    ORDER BY p.numero_fogo NULLS LAST, p.id DESC
  `).all(filialId);

  const emRecapagemRows = await db.prepare(`
    SELECT
      p.id, p.numero_fogo, p.marca, p.modelo, p.medida, p.tipo_pneu, p.condicao, p.vida_recap,
      p.custo, p.nota_fiscal, p.sulco_inicial_mm, p.observacoes, p.status_pneu,
      m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.data_medicao,
      (SELECT mv.data_evento FROM movimentacoes mv
        WHERE mv.pneu_id = p.id AND mv.tipo IN ('recap', 'retirada')
        ORDER BY mv.id DESC LIMIT 1) as data_envio,
      (SELECT COALESCE(mv.veiculo_placa, '') FROM movimentacoes mv
        WHERE mv.pneu_id = p.id AND mv.tipo = 'retirada'
        ORDER BY mv.id DESC LIMIT 1) as placa_origem
    FROM pneus p
    LEFT JOIN medicoes m ON m.pneu_id = p.id
      AND m.id = (
        SELECT id FROM medicoes WHERE pneu_id = p.id
        ORDER BY data_medicao DESC, id DESC LIMIT 1
      )
    WHERE p.filial_id = ? AND p.ativo = 1 AND p.status_pneu = 'recapagem'
    ORDER BY p.numero_fogo NULLS LAST, p.id DESC
  `).all(filialId);

  const mapInventario = (p) => {
    const menor = menorSulco(p) ?? (p.sulco_inicial_mm != null ? Number(p.sulco_inicial_mm) : null);
    return {
      fogo: p.numero_fogo || `ID ${p.id}`,
      marca: p.marca,
      modelo: p.modelo,
      medida: p.medida,
      padrao: labelTipoPneu(p.tipo_pneu),
      vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
      custo: p.custo,
      nota_fiscal: p.nota_fiscal,
      status: p.status_pneu,
      sulco: menor,
      sulco_inicial: p.sulco_inicial_mm != null ? Number(p.sulco_inicial_mm) : null,
      data_medicao: p.data_medicao || p.data_envio || null,
      placa_origem: p.placa_origem || null,
    };
  };

  const estoque = estoqueRows.map(mapInventario);
  const emRecapagem = emRecapagemRows.map(mapInventario);

  let custoEstoque = 0;
  for (const p of [...estoque, ...emRecapagem]) {
    if (p.custo != null) custoEstoque += Number(p.custo);
  }

  const descarte = await db.prepare(`
    SELECT id, numero_fogo, marca, modelo, tipo_pneu, vida_recap, custo, nota_fiscal,
           tratamento_descarte, tratamento_descarte_obs, tratamento_descarte_em, observacoes
    FROM pneus
    WHERE filial_id = ? AND status_pneu = 'descarte'
    ORDER BY tratamento_descarte_em DESC NULLS LAST, id DESC
  `).all(filialId);

  const descartePendentes = descarte.filter(
    (p) => !p.tratamento_descarte || p.tratamento_descarte === 'pendente'
  );

  const medicoesSemana = Number((await db.prepare(`
    SELECT COUNT(*) as n
    FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id
    WHERE p.filial_id = ?
      AND m.data_medicao >= ?
      AND m.data_medicao <= ?
  `).get(filialId, periodo.inicio, periodo.fim)).n);

  const labelsMov = {
    montagem: 'Montagem',
    retirada: 'Retirada',
    desmontagem: 'Desmontagem',
    mudanca_posicao: 'Rodizio / reposicao',
    recap: 'Envio a recap',
    retorno_recap: 'Retorno de recap',
    descarte: 'Descarte',
  };

  const movimentacoesSemana = await db.prepare(`
    SELECT
      mv.id, mv.tipo, mv.data_evento, mv.posicao, mv.posicao_anterior, mv.detalhes,
      mv.sulco_mm, mv.veiculo_placa, mv.km_veiculo,
      p.numero_fogo, p.marca, p.modelo, p.status_pneu
    FROM movimentacoes mv
    JOIN pneus p ON p.id = mv.pneu_id
    WHERE p.filial_id = ?
      AND mv.data_evento >= ?
      AND mv.data_evento <= ?
    ORDER BY mv.data_evento DESC, mv.id DESC
    LIMIT 120
  `).all(filialId, periodo.inicio, periodo.fim);

  const historico = movimentacoesSemana.map((m) => ({
    data: m.data_evento,
    tipo: m.tipo,
    tipo_label: labelsMov[m.tipo] || m.tipo,
    fogo: m.numero_fogo || '—',
    placa: m.veiculo_placa || '—',
    posicao: m.posicao || m.posicao_anterior || '—',
    sulco: m.sulco_mm != null ? Number(m.sulco_mm) : null,
    detalhes: m.detalhes || '',
    status_atual: m.status_pneu,
  }));

  const medicoesDetalheSemana = await db.prepare(SQL_LOGS_MEDICAO_SEMANA)
    .all(filialId, periodo.inicio, periodo.fim);

  const medicoesLista = medicoesDetalheSemana.map((m) => {
    const menor = menorSulco(m);
    return {
      id: m.id,
      data: m.data_medicao,
      created_at: m.created_at,
      fogo: m.numero_fogo || '—',
      veiculo_id: m.veiculo_id,
      placa: m.placa || m.veiculo_placa || (m.status_pneu === 'estoque' ? 'Estoque' : m.status_pneu === 'recapagem' ? 'Recap' : '—'),
      apelido: m.apelido || '',
      posicao: m.posicao || '—',
      menor_sulco: menor,
      status: labelStatusSulco(classificarSulco(menor, limitesDoVeiculo(m))),
      acao: m.acao_sugerida || '—',
      diag: m.diagnostico || '—',
      obs: m.observacoes || m.responsavel || '',
    };
  });

  return {
    titulo: 'Relatório semanal gerencial — Controle de Pneus',
    gerado_em: new Date().toISOString(),
    gerado_por: geradoPor,
    periodo,
    filial: {
      id: filial.id,
      nome: filial.nome,
      codigo: filial.codigo,
      contrato: filial.contrato || null,
    },
    limites: {
      critico_mm: limites.sulco_critico_mm,
      monitorar_ate_mm: limites.sulco_alerta_mm,
      prazo_recap_dias: limites.prazo_recap_dias,
    },
    resumo: {
      veiculos: veiculos.length,
      pneus_montados: totMontados,
      pneus_estoque: estoque.length,
      pneus_em_recapagem: emRecapagem.length,
      pneus_descarte: descarte.length,
      sulco_ok: totOk,
      sulco_monitorar: totAlerta,
      sulco_critico: totCritico,
      sem_medicao: totSemDado,
      acao_trocar: totTroca,
      acao_recap: totRecap + emRecapagem.length,
      acao_monitorar: totMonitorar,
      acao_rodizio: totRodizio,
      medicoes_semana: medicoesSemana,
      movimentacoes_semana: historico.length,
      veiculos_atrasados_medicao: veiculosAtrasados,
      custo_montado: Math.round(custoMontado * 100) / 100,
      custo_estoque: Math.round(custoEstoque * 100) / 100,
      descarte_aguardando: descartePendentes.length,
    },
    prioridades: {
      troca: prioridadesTroca,
      monitorar: prioridadesMonitorar,
      rodizio: prioridadesRodizio,
      descarte_pendente: descartePendentes.map((p) => ({
        fogo: p.numero_fogo || `ID ${p.id}`,
        marca: p.marca,
        modelo: p.modelo,
        tratamento: labelTratamentoDescarte(p.tratamento_descarte || 'pendente'),
        obs: p.tratamento_descarte_obs,
      })),
      em_recapagem: emRecapagem,
    },
    frota,
    diagnosticos: frota.flatMap((v) => (v.pneus || [])
      .filter((p) => p.diagnostico && !/^ok$/i.test(p.diagnostico) && !/sem dados/i.test(p.diagnostico))
      .map((p) => ({ ...p, placa: v.placa, apelido: v.apelido }))),
    estoque,
    em_recapagem: emRecapagem,
    historico,
    medicoes_semana_lista: medicoesLista,
    descarte: descarte.map((p) => ({
      fogo: p.numero_fogo || `ID ${p.id}`,
      marca: p.marca,
      modelo: p.modelo,
      padrao: labelTipoPneu(p.tipo_pneu),
      vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : '—',
      tratamento: labelTratamentoDescarte(p.tratamento_descarte || 'pendente'),
      tratamento_em: p.tratamento_descarte_em,
      obs: p.tratamento_descarte_obs,
      custo: p.custo,
    })),
  };
}

const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  soft: '#f8fafc',
  softAlt: '#f1f5f9',
  brand: '#0f766e',
  brandSoft: '#ccfbf1',
  ok: '#166534',
  okBg: '#dcfce7',
  alerta: '#9a3412',
  alertaBg: '#ffedd5',
  critico: '#991b1b',
  criticoBg: '#fee2e2',
  white: '#ffffff',
};

function statusColor(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('crít') || s.includes('crit') || s.includes('troca')) {
    return { fg: COLORS.critico, bg: COLORS.criticoBg };
  }
  if (s.includes('monitor') || s.includes('alerta') || s.includes('atras')) {
    return { fg: COLORS.alerta, bg: COLORS.alertaBg };
  }
  if (s.includes('ok')) return { fg: COLORS.ok, bg: COLORS.okBg };
  return { fg: COLORS.muted, bg: COLORS.softAlt };
}

/** Texto ASCII seguro no Helvetica (evita ≤ ≥ → quebrarem) */
function asciiSafe(text) {
  return String(text ?? '')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/→/g, '->')
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/·/g, '|')
    .replace(/…/g, '...');
}

function labelFogoPdf(fogo) {
  const s = String(fogo ?? '').trim();
  if (!s) return 'S/ID';
  if (/^sem\s*ident/i.test(s) || /^n[\/.]?a$/i.test(s) || s === '-' || s === '—') return 'S/ID';
  return s;
}

function labelPadraoPdf(padrao) {
  const s = String(padrao ?? '').trim();
  if (!s) return '-';
  if (/misto/i.test(s)) return 'Misto';
  if (/direcional/i.test(s)) return 'Direcional';
  if (/borrachudo/i.test(s)) return 'Borrachudo';
  return s;
}

function labelDiagPdf(diag) {
  const s = asciiSafe(diag).trim();
  if (!s || s === '-') return '-';
  if (/desgaste progressivo/i.test(s)) return 'Prog. Ext->Int';
  if (/desgaste irregular/i.test(s)) return 'Irregular';
  if (/sem dados/i.test(s)) return 'Sem dados';
  if (/^ok$/i.test(s)) return 'OK';
  if (/cr[ií]tico/i.test(s)) return 'Critico';
  return s;
}

function clip(text, max = 40) {
  const s = asciiSafe(text ?? '-');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 3))}...`;
}

/** Corta pelo espaço real da coluna (fonte Helvetica ~0.5*size) */
function fitWidth(doc, text, maxWidth, fontSize = 7.5, bold = false) {
  const raw = asciiSafe(text ?? '-');
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
  if (doc.widthOfString(raw) <= maxWidth) return raw;
  let s = raw;
  while (s.length > 1 && doc.widthOfString(`${s}...`) > maxWidth) {
    s = s.slice(0, -1);
  }
  return s.length ? `${s}...` : '...';
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Texto absoluto sem disparar quebra de pagina do PDFKit */
function absText(doc, text, x, y, opts = {}) {
  const savedY = doc.y;
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.text(asciiSafe(text), x, y, { lineBreak: false, ...opts });
  doc.page.margins.bottom = savedBottom;
  doc.y = savedY;
}

function softGap(doc, px = 8) {
  const next = doc.y + px;
  if (next < pageBottom(doc)) doc.y = next;
}

function createPager(doc) {
  let pageNo = 1;

  const addPage = () => {
    doc.addPage({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 40, bottom: 40, left: 32, right: 32 },
    });
    pageNo += 1;
  };

  const ensureSpace = (need = 48) => {
    if (doc.y + need > pageBottom(doc)) addPage();
  };

  return { ensureSpace, addPage, pageNo: () => pageNo };
}

function stampFooters(doc, dados) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i += 1) {
    doc.switchToPage(range.start + i);
    if (!doc.page.margins.left) continue;
    const left = doc.page.margins.left;
    const w = contentWidth(doc);
    const y = doc.page.height - 26;
    const savedY = doc.y;
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc.save();
    doc.strokeColor(COLORS.line).lineWidth(0.6)
      .moveTo(left, y - 7)
      .lineTo(left + w, y - 7)
      .stroke();
    doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
    doc.text(
      asciiSafe(`PneuSistemma | ${dados.filial.codigo} | ${dados.periodo.label}`),
      left,
      y,
      { width: w - 52, lineBreak: false }
    );
    doc.text(`Pag. ${i + 1}/${total}`, left + w - 50, y, {
      width: 50,
      align: 'right',
      lineBreak: false,
    });
    doc.restore();

    doc.page.margins.bottom = savedBottom;
    doc.y = savedY;
  }
}

function sectionTitle(doc, pager, number, title) {
  pager.ensureSpace(36);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = contentWidth(doc);
  const savedBottom = doc.page.margins.bottom;
  doc.roundedRect(x, y, w, 22, 4).fill(COLORS.brand);
  doc.page.margins.bottom = 0;
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(10)
    .text(asciiSafe(`${number}.  ${title}`), x + 12, y + 5, { width: w - 24, lineBreak: false });
  doc.page.margins.bottom = savedBottom;
  doc.y = y + 28;
}

function subTitle(doc, pager, title, accent = COLORS.brand) {
  pager.ensureSpace(22);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.rect(x, y + 1, 3, 11).fill(accent);
  const savedY = doc.y;
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9)
    .text(asciiSafe(title), x + 10, y, { width: contentWidth(doc) - 10, lineBreak: false });
  doc.page.margins.bottom = savedBottom;
  doc.y = y + 15;
}

function mutedLine(doc, pager, text) {
  pager.ensureSpace(12);
  const y = doc.y;
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
    .text(asciiSafe(text), doc.page.margins.left, y, {
      width: contentWidth(doc),
      lineBreak: false,
    });
  doc.page.margins.bottom = savedBottom;
  doc.y = y + 12;
}

function drawKpiGrid(doc, pager, items) {
  const cols = 4;
  const gap = 6;
  const w = contentWidth(doc);
  const cardW = (w - gap * (cols - 1)) / cols;
  const cardH = 40;
  const startX = doc.page.margins.left;
  pager.ensureSpace(cardH + 6);
  let x = startX;
  let y = doc.y;
  const savedBottom = doc.page.margins.bottom;

  items.forEach((item, idx) => {
    if (idx > 0 && idx % cols === 0) {
      const nextY = y + cardH + gap;
      if (nextY + cardH > pageBottom(doc)) {
        pager.addPage();
        x = startX;
        y = doc.y;
      } else {
        y = nextY;
        x = startX;
      }
    }
    doc.roundedRect(x, y, cardW, cardH, 4).fill(item.bg || COLORS.soft);
    doc.roundedRect(x, y, 3, cardH, 2).fill(item.accent || COLORS.brand);

    doc.page.margins.bottom = 0;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5)
      .text(asciiSafe(item.label), x + 10, y + 7, { width: cardW - 14, lineBreak: false });
    doc.fillColor(item.accent || COLORS.ink).font('Helvetica-Bold').fontSize(11)
      .text(fitWidth(doc, item.value, cardW - 14, 11, true), x + 10, y + 20, {
        width: cardW - 14,
        lineBreak: false,
      });
    doc.page.margins.bottom = savedBottom;
    x += cardW + gap;
  });
  doc.y = y + cardH + 10;
}

function drawTable(doc, pager, columns, rows, { emptyText = 'Sem registros.' } = {}) {
  const x0 = doc.page.margins.left;
  const totalW = contentWidth(doc);
  const colWs = columns.map((c) => totalW * c.w);
  const rowH = 14;
  const headerH = 15;
  const savedBottom = doc.page.margins.bottom;

  const drawHeader = () => {
    pager.ensureSpace(headerH + rowH + 2);
    let x = x0;
    const y = doc.y;
    doc.rect(x0, y, totalW, headerH).fill(COLORS.ink);
    doc.page.margins.bottom = 0;
    columns.forEach((col, i) => {
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(6.5)
        .text(asciiSafe(col.label), x + 3, y + 4, {
          width: colWs[i] - 6,
          lineBreak: false,
        });
      x += colWs[i];
    });
    doc.page.margins.bottom = savedBottom;
    doc.y = y + headerH;
  };

  drawHeader();

  if (!rows.length) {
    pager.ensureSpace(18);
    const y = doc.y;
    doc.rect(x0, y, totalW, 16).fill(COLORS.soft);
    doc.page.margins.bottom = 0;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
      .text(asciiSafe(emptyText), x0 + 6, y + 4, { width: totalW - 12, lineBreak: false });
    doc.page.margins.bottom = savedBottom;
    doc.y = y + 20;
    return;
  }

  rows.forEach((row, ri) => {
    if (doc.y + rowH > pageBottom(doc)) {
      pager.addPage();
      drawHeader();
    }
    const y = doc.y;
    const bg = ri % 2 === 0 ? COLORS.white : COLORS.soft;
    doc.rect(x0, y, totalW, rowH).fill(bg);
    let x = x0;
    doc.page.margins.bottom = 0;
    columns.forEach((col, i) => {
      const raw = row[col.key];
      const cellW = colWs[i] - 6;
      const val = fitWidth(doc, raw == null || raw === '' ? '-' : raw, cellW, 6.5, Boolean(col.bold));
      const color = col.colorize ? statusColor(val).fg : COLORS.ink;
      doc.fillColor(color)
        .font(col.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(6.5)
        .text(val, x + 3, y + 3.5, {
          width: cellW,
          align: col.align || 'left',
          lineBreak: false,
        });
      x += colWs[i];
    });
    doc.page.margins.bottom = savedBottom;
    doc.y = y + rowH;
  });
  softGap(doc, 6);
}

function drawVehicleBlock(doc, pager, v) {
  const tableNeed = 15 + Math.max(1, v.pneus.length) * 14 + 8;
  pager.ensureSpace(36 + Math.min(tableNeed, 80));
  const x0 = doc.page.margins.left;
  const w = contentWidth(doc);
  const st = statusColor(v.atrasado_semana ? 'atrasado' : v.status_label);
  const headH = 28;
  const y0 = doc.y;
  const savedBottom = doc.page.margins.bottom;

  doc.roundedRect(x0, y0, w, headH, 3).fill(COLORS.softAlt);
  doc.rect(x0, y0, 4, headH).fill(st.fg);

  doc.page.margins.bottom = 0;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9)
    .text(
      fitWidth(doc, `${v.placa}${v.apelido ? ` | ${v.apelido}` : ''}`, w * 0.55, 9, true),
      x0 + 12,
      y0 + 4,
      { width: w * 0.55, lineBreak: false }
    );
  doc.fillColor(st.fg).font('Helvetica-Bold').fontSize(7.5)
    .text(
      fitWidth(doc, v.atrasado_semana ? `${v.status_label} | ATRASADO` : v.status_label, w * 0.35, 7.5, true),
      x0 + 12,
      y0 + 4,
      { width: w - 24, align: 'right', lineBreak: false }
    );
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5)
    .text(
      fitWidth(doc, [
        v.tipo || null,
        `KM ${formatNum(v.km_atual)}`,
        v.hr_atual != null ? `HR ${formatNum(v.hr_atual)}` : null,
        `${v.total_pneus} pneus`,
        `Medicao ${formatBr(v.ultima_medicao)}`,
      ].filter(Boolean).join('  |  '), w - 24, 6.5),
      x0 + 12,
      y0 + 15,
      { width: w - 24, lineBreak: false }
    );
  doc.page.margins.bottom = savedBottom;
  doc.y = y0 + headH + 3;

  drawTable(doc, pager, [
    { key: 'pos', label: 'Pos.', w: 0.07 },
    { key: 'fogo', label: 'Fogo', w: 0.12 },
    { key: 'padrao', label: 'Padrao', w: 0.11 },
    { key: 'vida', label: 'Vida', w: 0.09 },
    { key: 'sulcos', label: 'Ext/Cent/Int/Aux', w: 0.22 },
    { key: 'menor', label: 'Menor', w: 0.08, bold: true },
    { key: 'status', label: 'Status', w: 0.11, colorize: true },
    { key: 'acao', label: 'Acao', w: 0.10, colorize: true },
    { key: 'diag', label: 'Diagnostico', w: 0.10 },
  ], v.pneus.map((p) => ({
    pos: p.posicao,
    fogo: labelFogoPdf(p.fogo),
    padrao: labelPadraoPdf(p.padrao),
    vida: p.vida,
    sulcos: `${p.sulcos.ext ?? '-'} / ${p.sulcos.cent ?? '-'} / ${p.sulcos.int ?? '-'} / ${p.sulcos.aux ?? '-'}`,
    menor: p.menor_sulco != null ? `${p.menor_sulco}` : '-',
    status: p.status_label,
    acao: p.acao,
    diag: labelDiagPdf(p.diagnostico),
  })));
}

const COORDS_MINI = {
  '1E': [170, 145], '1D': [430, 145],
  '2E': [170, 320], '2D': [430, 320],
  '2EE': [130, 320], '2EI': [192, 320], '2DI': [408, 320], '2DE': [470, 320],
  '3E': [170, 420], '3D': [430, 420],
  '3EE': [130, 420], '3EI': [192, 420], '3DI': [408, 420], '3DE': [470, 420],
  DE: [170, 145], DD: [430, 145], D: [300, 145],
  TE: [170, 320], TD: [430, 320], T: [300, 320],
  TEE: [130, 320], TEI: [192, 320], TDI: [408, 320], TDE: [470, 320],
  E2EE: [130, 320], E2EI: [192, 320], E2DI: [408, 320], E2DE: [470, 320],
  E3EE: [130, 420], E3EI: [192, 420], E3DI: [408, 420], E3DE: [470, 420],
  ESTEPE: [300, 500],
};

function fillSulco(status) {
  if (status === 'critico') return '#dc2626';
  if (status === 'alerta') return '#d97706';
  if (status === 'ok') return '#16a34a';
  return '#94a3b8';
}

function bgSulco(status) {
  if (status === 'critico') return COLORS.criticoBg;
  if (status === 'alerta') return COLORS.alertaBg;
  if (status === 'ok') return COLORS.okBg;
  return COLORS.softAlt;
}

function drawMiniTruck(doc, x, y, w, h, v) {
  const savedY = doc.y;
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.roundedRect(x, y, w, h, 6).fill(bgSulco(v.status_sulco));
  doc.lineWidth(0.6).strokeColor(COLORS.line).roundedRect(x, y, w, h, 6).stroke();

  const footer = 34;
  const scale = Math.min((w - 18) / 600, (h - footer - 12) / 480);
  const ox = x + (w - 600 * scale) / 2;
  const oy = y + 6;
  const tw = 48 * scale;
  const th = 58 * scale;

  for (const p of v.pneus || []) {
    const xy = COORDS_MINI[p.posicao];
    if (!xy) continue;
    const px = ox + (xy[0] - 24) * scale;
    const py = oy + (xy[1] - 29) * scale;
    doc.roundedRect(px, py, tw, th, 2).fill(fillSulco(p.status_sulco));
    absText(doc, p.posicao, px, py + 2, { width: tw, align: 'center' });
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(Math.max(5, tw * 0.38));
    doc.text(p.menor_sulco != null ? String(p.menor_sulco) : '-', px, py + th * 0.42, {
      width: tw,
      align: 'center',
      lineBreak: false,
    });
  }

  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9);
  doc.text(fitWidth(doc, v.placa, w * 0.55, 9, true), x + 8, y + h - 26, {
    width: w * 0.55, lineBreak: false,
  });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7);
  doc.text(fitWidth(doc, v.ultima_medicao ? `Med. ${formatBr(v.ultima_medicao)}` : 'Sem medicão', w * 0.55, 7), x + 8, y + h - 14, {
    width: w * 0.55, lineBreak: false,
  });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8);
  doc.text(v.menor_sulco != null ? `${v.menor_sulco} mm` : '-', x + 8, y + h - 26, {
    width: w - 16, align: 'right', lineBreak: false,
  });
  const st = statusColor(v.status_label);
  doc.fillColor(st.fg).font('Helvetica-Bold').fontSize(7);
  doc.text(v.status_label || '-', x + 8, y + h - 14, {
    width: w - 16, align: 'right', lineBreak: false,
  });
  doc.page.margins.bottom = savedBottom;
  doc.y = savedY;
}

function drawTruckGrid(doc, pager, veiculos) {
  const cols = 3;
  const gap = 8;
  const w = contentWidth(doc);
  const cardW = (w - gap * (cols - 1)) / cols;
  const cardH = 158;
  let col = 0;
  for (const v of veiculos) {
    if (col === 0) pager.ensureSpace(cardH + 8);
    const x = doc.page.margins.left + col * (cardW + gap);
    const y = doc.y;
    drawMiniTruck(doc, x, y, cardW, cardH, v);
    col += 1;
    if (col >= cols) {
      doc.y = y + cardH + 8;
      col = 0;
    }
  }
  if (col !== 0) doc.y += cardH + 8;
}

function drawDecisaoCard(doc, x, y, w, h, titulo, placa, pos, sulco, motivo, fundo, corTitulo) {
  const savedY = doc.y;
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.roundedRect(x, y, w, h, 4).fill(fundo);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8)
    .text(fitWidth(doc, placa, w * 0.5, 8, true), x + 6, y + 5, { width: w * 0.5, lineBreak: false });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8)
    .text(sulco, x + 6, y + 5, { width: w - 12, align: 'right', lineBreak: false });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
    .text(pos, x + 6, y + 16, { width: w * 0.4, lineBreak: false });
  doc.fillColor(corTitulo).font('Helvetica-Bold').fontSize(7.5)
    .text(fitWidth(doc, titulo, w * 0.5, 7.5, true), x + 6, y + 16, {
      width: w - 12, align: 'right', lineBreak: false,
    });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5)
    .text(clip(motivo, 78), x + 6, y + 28, { width: w - 12, lineBreak: false });
  doc.page.margins.bottom = savedBottom;
  doc.y = savedY;
}

function drawAcoesDiagnosticos(doc, pager, acoes, diags) {
  const gap = 10;
  const colW = (contentWidth(doc) - gap) / 2;
  const cardH = 42;
  const x0 = doc.page.margins.left;
  pager.ensureSpace(56);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10)
    .text('Acoes', x0, doc.y, { lineBreak: false });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10)
    .text('Diagnosticos', x0 + colW + gap, doc.y, { lineBreak: false });
  doc.y += 14;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
    .text(`${acoes.length} pendentes — trocar, recapar, mudar posicao ou acompanhar`, x0, doc.y, {
      width: colW, lineBreak: false,
    });
  doc.text(`${diags.length} irregularidades — causa do desgaste`, x0 + colW + gap, doc.y, {
    width: colW, lineBreak: false,
  });
  doc.y += 14;

  const max = Math.max(acoes.length, diags.length, 0);
  if (!max) {
    mutedLine(doc, pager, 'Nenhuma acao nem diagnostico irregular nesta unidade.');
    return;
  }
  for (let i = 0; i < max; i += 1) {
    pager.ensureSpace(cardH + 6);
    const y = doc.y;
    if (acoes[i]) {
      const a = acoes[i];
      const st = statusColor(a.acao || a.status_label);
      drawDecisaoCard(
        doc, x0, y, colW, cardH,
        a.acao || a.status_label,
        a.placa || a.apelido || '-',
        a.posicao || '-',
        mm(a.menor_sulco),
        a.motivo || a.diagnostico || '',
        st.bg,
        st.fg,
      );
    }
    if (diags[i]) {
      const d = diags[i];
      const st = statusColor(d.status_label || d.diagnostico);
      drawDecisaoCard(
        doc, x0 + colW + gap, y, colW, cardH,
        labelDiagPdf(d.diagnostico),
        d.placa || d.apelido || '-',
        d.posicao || '-',
        mm(d.menor_sulco),
        d.motivo || d.diagnostico || '',
        st.bg,
        st.fg,
      );
    }
    doc.y = y + cardH + 6;
  }
}

/**
 * Gera Buffer PDF a partir dos dados montados.
 */
export function gerarPdfRelatorioSemanal(dados) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: dados.titulo,
        Author: 'PneuSistemma',
        Subject: `Unidade ${dados.filial.nome} - ${dados.periodo.label}`,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    desenharRelatorioVisual(doc, dados);
    stampFooters(doc, dados);
    doc.end();
  });
}

function nomeArquivoPdf(dados) {
  const p = partesDataBrasil(dados.gerado_em);
  const codigo = String(dados.filial?.codigo || dados.filial?.id || 'unidade')
    .replace(/[^\w\-]+/g, '_');
  return `relatorio-semanal-${codigo}-${p.yyyy}-${p.mm}-${p.dd}_${p.hh}h${p.mi}.pdf`;
}

export async function gerarRelatorioSemanalPdfBuffer(filialId, opts = {}) {
  const dados = await montarDadosRelatorioSemanal(filialId, opts);
  const buffer = await gerarPdfRelatorioSemanal(dados);
  return { buffer, filename: nomeArquivoPdf(dados), dados };
}
