/**
 * Relatório PDF semanal gerencial da unidade (frota + pneus).
 */
import PDFDocument from 'pdfkit';
import { getDb } from '../database.js';
import { classificarSulco, getLimites, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao } from '../diagnostico.js';
import {
  labelPosicao,
  labelTipoPneu,
  labelTratamentoDescarte,
  sqlOrderPosicao,
  papelPosicao,
} from '../pneus-layouts.js';

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

/** Ação que o gerente deve tomar — texto do relatório, sem abreviação. */
function textoOQueFazer(item, acao, limites) {
  const critico = limites.sulco_critico_mm;
  const prazo = limites.prazo_recap_dias ?? 15;
  const sulco = item.menor_sulco != null ? `${item.menor_sulco} mm` : 'sem medição';
  const codigo = acao?.codigo;
  const motivo = String(acao?.motivo || '').trim();
  const rodizio = acao?.rodizio_sugestao;

  if (codigo === 'troca' || item.status_sulco === 'critico') {
    const base = `Trocar agora: retirar o pneu do caminhão (sulco ${sulco} ≤ ${critico} mm) e montar outro na posição.`;
    return motivo && !/crítico|critico|retirar e trocar/i.test(motivo) ? `${base} ${motivo}` : (motivo || base);
  }
  if (codigo === 'recap') {
    return motivo || 'Enviar para recapagem: desmonte, registre a recap e coloque outro pneu (estoque) na posição.';
  }
  if (codigo === 'monitorar' || item.status_sulco === 'alerta') {
    const base = `Programar substituição: iniciar recap/compra em até ${prazo} dias e acompanhar o sulco nas próximas medições (${sulco}).`;
    return motivo || base;
  }
  if (codigo === 'rodizio') {
    if (rodizio?.motivo) return rodizio.motivo;
    return motivo || 'Fazer rodízio para o lado oposto do eixo para equalizar o desgaste.';
  }
  return motivo || 'Nenhuma ação urgente — manter medição periódica.';
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
      const status = classificarSulco(menor);
      const diag = diagnosticarPerfil(pontos, limites.diagnostico_tolerancia_mm, {
        limites,
        posicao: p.posicao,
        papel: papelPosicao(p.posicao),
      });
      const acao = sugerirAcao(menor, limites, p.vida_recap || 0, {
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
        diagnostico_codigo: diag.codigo || null,
        diagnostico_desc: diag.descricao || null,
        acao: acao.label || acao.codigo,
        acao_codigo: acao.codigo,
        motivo: acao.motivo || null,
        o_que_fazer: textoOQueFazer({ menor_sulco: menor, status_sulco: status }, acao, limites),
        rodizio_sugestao: acao.rodizio_sugestao
          ? (acao.rodizio_sugestao.label || acao.rodizio_sugestao.posicao_label || null)
          : null,
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
      pneus: pneusDetalhe,
    });
  }

  const porSulco = (a, b) => (Number(a.menor_sulco) ?? 99) - (Number(b.menor_sulco) ?? 99);
  prioridadesTroca.sort(porSulco);
  prioridadesMonitorar.sort(porSulco);
  prioridadesRodizio.sort(porSulco);

  const estoque = await db.prepare(`
    SELECT id, numero_fogo, marca, modelo, medida, tipo_pneu, condicao, vida_recap,
           custo, nota_fiscal, sulco_inicial_mm, observacoes
    FROM pneus
    WHERE filial_id = ? AND ativo = 1 AND status_pneu IN ('estoque', 'recapagem')
    ORDER BY numero_fogo NULLS LAST, id DESC
  `).all(filialId);

  let custoEstoque = 0;
  for (const p of estoque) {
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
      pneus_descarte: descarte.length,
      sulco_ok: totOk,
      sulco_monitorar: totAlerta,
      sulco_critico: totCritico,
      sem_medicao: totSemDado,
      acao_trocar: totTroca,
      acao_recap: totRecap,
      acao_monitorar: totMonitorar,
      acao_rodizio: totRodizio,
      medicoes_semana: medicoesSemana,
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
    },
    frota,
    estoque: estoque.map((p) => ({
      fogo: p.numero_fogo || `ID ${p.id}`,
      marca: p.marca,
      modelo: p.modelo,
      medida: p.medida,
      padrao: labelTipoPneu(p.tipo_pneu),
      vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
      custo: p.custo,
      nota_fiscal: p.nota_fiscal,
      status: p.status_pneu,
    })),
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
    doc.addPage();
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

function measureWrap(doc, text, width, fontSize = 8, bold = false) {
  const raw = asciiSafe(text || '');
  if (!raw) return 0;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
  return doc.heightOfString(raw, { width, lineGap: 1.2 });
}

function paintWrap(doc, text, x, y, width, fontSize, color, bold = false) {
  const raw = asciiSafe(text || '');
  if (!raw) return 0;
  const savedBottom = doc.page.margins.bottom;
  const savedY = doc.y;
  doc.page.margins.bottom = 0;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(color);
  const h = doc.heightOfString(raw, { width, lineGap: 1.2 });
  doc.text(raw, x, y, { width, lineGap: 1.2 });
  doc.page.margins.bottom = savedBottom;
  doc.y = savedY;
  return h;
}

/** Bloco padrão do relatório: título + nome do diagnóstico + texto completo. */
function partesDiagnostico(item) {
  return {
    titulo: 'Diagnóstico',
    nome: item?.diagnostico || '—',
    desc: item?.diagnostico_desc || '',
  };
}

function measureDiagnosticoBloco(doc, item, width) {
  const { titulo, nome, desc } = partesDiagnostico(item);
  let h = measureWrap(doc, titulo, width, 7.5, true);
  h += 1 + measureWrap(doc, nome, width, 8.5, true);
  if (desc) h += 1.5 + measureWrap(doc, desc, width, 8);
  return h;
}

function paintDiagnosticoBloco(doc, item, x, y, width, accent) {
  const { titulo, nome, desc } = partesDiagnostico(item);
  let cy = y;
  cy += paintWrap(doc, titulo, x, cy, width, 7.5, accent || COLORS.ink, true);
  cy += 1;
  cy += paintWrap(doc, nome, x, cy, width, 8.5, COLORS.ink, true);
  if (desc) {
    cy += 1.5;
    cy += paintWrap(doc, desc, x, cy, width, 8, COLORS.ink);
  }
  return cy - y;
}

/**
 * Cartão de prioridade: diagnóstico completo + o que o gerente deve fazer.
 */
function drawPriorityCards(doc, pager, items, { emptyText, accent }) {
  if (!items.length) {
    mutedLine(doc, pager, emptyText);
    return;
  }

  const x0 = doc.page.margins.left;
  const w = contentWidth(doc);
  const pad = 8;
  const innerW = w - pad * 2 - 4;
  const savedBottom = doc.page.margins.bottom;

  for (const item of items) {
    const sulcos = `${item.sulcos?.ext ?? '-'} / ${item.sulcos?.cent ?? '-'} / ${item.sulcos?.int ?? '-'} / ${item.sulcos?.aux ?? '-'}`;
    const header = [
      item.placa || item.apelido || '-',
      item.posicao_label || item.posicao,
      `Fogo ${labelFogoPdf(item.fogo)}`,
      mm(item.menor_sulco),
    ].join('  |  ');
    const meta = [
      item.marca,
      item.modelo,
      item.padrao,
      item.vida,
      `4 pontos: ${sulcos}`,
      item.data_medicao ? `medido ${formatBr(item.data_medicao)}` : null,
    ].filter(Boolean).join('  ·  ');
    const fazer = item.o_que_fazer || item.motivo || '';

    const hMeta = measureWrap(doc, meta, innerW, 6.5);
    const hDiag = measureDiagnosticoBloco(doc, item, innerW);
    const hFazerLabel = measureWrap(doc, 'O que fazer', innerW, 7.5, true);
    const hFazer = measureWrap(doc, fazer, innerW, 8);
    const h = 8 + 16 + hMeta + 4 + hDiag + 4 + hFazerLabel + 1 + hFazer + 8;

    pager.ensureSpace(h + 8);
    const y0 = doc.y;
    const st = statusColor(item.status_label || item.acao);

    doc.roundedRect(x0, y0, w, h, 3).fill(COLORS.white);
    doc.save();
    doc.lineWidth(0.7).strokeColor(COLORS.line).roundedRect(x0, y0, w, h, 3).stroke();
    doc.restore();
    doc.rect(x0, y0, 4, h).fill(accent || st.fg);

    doc.page.margins.bottom = 0;
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8.5)
      .text(fitWidth(doc, header, innerW * 0.62, 8.5, true), x0 + pad + 4, y0 + 6, {
        width: innerW * 0.62,
        lineBreak: false,
      });
    const badge = `${item.status_label || '-'}  ·  ${item.acao || '-'}`;
    doc.fillColor(st.fg).font('Helvetica-Bold').fontSize(7.5)
      .text(fitWidth(doc, badge, innerW * 0.36, 7.5, true), x0 + pad + 4, y0 + 6, {
        width: innerW,
        align: 'right',
        lineBreak: false,
      });
    doc.page.margins.bottom = savedBottom;

    let y = y0 + 20;
    y += paintWrap(doc, meta, x0 + pad + 4, y, innerW, 6.5, COLORS.muted);
    y += 4;
    y += paintDiagnosticoBloco(doc, item, x0 + pad + 4, y, innerW, accent || st.fg);
    y += 4;
    y += paintWrap(doc, 'O que fazer', x0 + pad + 4, y, innerW, 7.5, accent || st.fg, true);
    y += 1;
    y += paintWrap(doc, fazer, x0 + pad + 4, y, innerW, 8, COLORS.ink);

    doc.y = Math.max(y, y0 + h) + 6;
  }
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
    { key: 'pos', label: 'Pos.', w: 0.08 },
    { key: 'fogo', label: 'Fogo', w: 0.13 },
    { key: 'padrao', label: 'Padrao', w: 0.13 },
    { key: 'vida', label: 'Vida', w: 0.10 },
    { key: 'sulcos', label: 'Ext/Cent/Int/Aux', w: 0.24 },
    { key: 'menor', label: 'Menor', w: 0.09, bold: true },
    { key: 'status', label: 'Status', w: 0.12, colorize: true },
    { key: 'acao', label: 'Acao', w: 0.11, colorize: true },
  ], v.pneus.map((p) => ({
    pos: p.posicao,
    fogo: labelFogoPdf(p.fogo),
    padrao: labelPadraoPdf(p.padrao),
    vida: p.vida,
    sulcos: `${p.sulcos.ext ?? '-'} / ${p.sulcos.cent ?? '-'} / ${p.sulcos.int ?? '-'} / ${p.sulcos.aux ?? '-'}`,
    menor: p.menor_sulco != null ? `${p.menor_sulco}` : '-',
    status: p.status_label,
    acao: p.acao,
  })));

  drawPneuDiagnosticos(doc, pager, v.pneus);
}

function drawPneuDiagnosticos(doc, pager, pneus) {
  if (!pneus?.length) return;

  const x0 = doc.page.margins.left;
  const w = contentWidth(doc);
  const pad = 7;
  const innerW = w - pad * 2 - 4;

  for (const p of pneus) {
    const ident = [
      p.posicao_label || p.posicao,
      `Fogo ${labelFogoPdf(p.fogo)}`,
      mm(p.menor_sulco),
    ].join('  |  ');
    const hIdent = measureWrap(doc, ident, innerW, 8, true);
    const hDiag = measureDiagnosticoBloco(doc, p, innerW);
    const h = pad + hIdent + 4 + hDiag + pad;

    pager.ensureSpace(h + 4);
    const y0 = doc.y;
    const st = statusColor(p.status_label);

    doc.roundedRect(x0, y0, w, h, 2).fill(COLORS.white);
    doc.save();
    doc.lineWidth(0.5).strokeColor(COLORS.line).roundedRect(x0, y0, w, h, 2).stroke();
    doc.restore();
    doc.rect(x0, y0, 3.5, h).fill(st.fg);

    let y = y0 + pad;
    y += paintWrap(doc, ident, x0 + pad + 4, y, innerW, 8, COLORS.ink, true);
    y += 4;
    y += paintDiagnosticoBloco(doc, p, x0 + pad + 4, y, innerW, st.fg);
    doc.y = Math.max(y, y0 + h) + 4;
  }
  softGap(doc, 4);
}

/**
 * Gera Buffer PDF a partir dos dados montados.
 */
export function gerarPdfRelatorioSemanal(dados) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 36, right: 36 },
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

    const pager = createPager(doc);
    const r = dados.resumo;
    const x0 = doc.page.margins.left;
    const w = contentWidth(doc);
    const savedBottom = doc.page.margins.bottom;

    // ── Cabecalho ──────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 72).fill(COLORS.brand);
    doc.page.margins.bottom = 0;
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(16)
      .text('Relatorio semanal gerencial', x0, 16, { width: w, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#99f6e4')
      .text('Controle de desgaste de pneus - apoio a decisao do gerente', x0, 38, {
        width: w,
        lineBreak: false,
      });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.white)
      .text(
        fitWidth(doc, `${dados.filial.nome}  (${dados.filial.codigo})`, w * 0.55, 9, true),
        x0,
        54,
        { width: w * 0.55, lineBreak: false }
      );
    doc.font('Helvetica').fontSize(9)
      .text(`Semana ${dados.periodo.label}`, x0, 54, { width: w, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
    doc.y = 84;

    doc.page.margins.bottom = 0;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5);
    const meta = [
      `Gerado em ${formatarDataHoraBrasil(dados.gerado_em)}`,
      dados.gerado_por ? `por ${dados.gerado_por}` : null,
      `Limites: critico <= ${dados.limites.critico_mm} mm | monitorar <= ${dados.limites.monitorar_ate_mm} mm | prazo recap ${dados.limites.prazo_recap_dias} d`,
    ].filter(Boolean).join('   |   ');
    doc.text(asciiSafe(meta), x0, doc.y, { width: w, lineBreak: false });
    doc.page.margins.bottom = savedBottom;
    doc.y = 98;

    // ── 1. Resumo ──────────────────────────────────────
    sectionTitle(doc, pager, '1', 'Resumo executivo');
    drawKpiGrid(doc, pager, [
      { label: 'VEICULOS', value: r.veiculos, accent: COLORS.brand, bg: COLORS.brandSoft },
      { label: 'PNEUS MONTADOS', value: r.pneus_montados, accent: COLORS.ink, bg: COLORS.softAlt },
      { label: 'ESTOQUE', value: r.pneus_estoque, accent: COLORS.ink, bg: COLORS.softAlt },
      { label: 'DESCARTE', value: r.pneus_descarte, accent: COLORS.muted, bg: COLORS.soft },
      { label: 'OK', value: r.sulco_ok, accent: COLORS.ok, bg: COLORS.okBg },
      { label: 'MONITORAR', value: r.sulco_monitorar, accent: COLORS.alerta, bg: COLORS.alertaBg },
      { label: 'CRITICO', value: r.sulco_critico, accent: COLORS.critico, bg: COLORS.criticoBg },
      { label: 'SEM MEDICAO', value: r.sem_medicao, accent: COLORS.muted, bg: COLORS.softAlt },
      { label: 'TROCAR', value: r.acao_trocar, accent: COLORS.critico, bg: COLORS.criticoBg },
      { label: 'RECAP', value: r.acao_recap, accent: COLORS.alerta, bg: COLORS.alertaBg },
      { label: 'RODIZIO', value: r.acao_rodizio, accent: COLORS.brand, bg: COLORS.brandSoft },
      { label: 'MEDICOES NA SEMANA', value: r.medicoes_semana, accent: COLORS.brand, bg: COLORS.brandSoft },
    ]);

    drawKpiGrid(doc, pager, [
      { label: 'ATRASADOS (>=7 DIAS)', value: r.veiculos_atrasados_medicao, accent: COLORS.alerta, bg: COLORS.alertaBg },
      { label: 'DESCARTE PENDENTE', value: r.descarte_aguardando, accent: COLORS.critico, bg: COLORS.criticoBg },
      { label: 'CUSTO MONTADO', value: formatMoney(r.custo_montado), accent: COLORS.ink, bg: COLORS.softAlt },
      { label: 'CUSTO ESTOQUE', value: formatMoney(r.custo_estoque), accent: COLORS.ink, bg: COLORS.softAlt },
    ]);

    // ── 2. Prioridades ─────────────────────────────────
    sectionTitle(doc, pager, '2', 'Prioridades da semana - diagnostico e o que fazer');
    mutedLine(
      doc,
      pager,
      'Pneus criticos e em monitoramento: diagnostico do perfil (4 pontos) e a acao que o gerente deve tomar.'
    );

    subTitle(doc, pager, `Trocar / critico (${dados.prioridades.troca.length})`, COLORS.critico);
    drawPriorityCards(doc, pager, dados.prioridades.troca, {
      emptyText: 'Nenhum pneu critico / troca no momento.',
      accent: COLORS.critico,
    });

    subTitle(doc, pager, `Monitorar / recap (${dados.prioridades.monitorar.length})`, COLORS.alerta);
    drawPriorityCards(doc, pager, dados.prioridades.monitorar, {
      emptyText: 'Nenhum pneu em monitorar / recap.',
      accent: COLORS.alerta,
    });

    subTitle(doc, pager, `Rodizio (${dados.prioridades.rodizio.length})`, COLORS.brand);
    drawPriorityCards(doc, pager, dados.prioridades.rodizio, {
      emptyText: 'Nenhum rodizio sugerido.',
      accent: COLORS.brand,
    });

    subTitle(doc, pager, `Descarte aguardando destino (${dados.prioridades.descarte_pendente.length})`, COLORS.critico);
    drawTable(doc, pager, [
      { key: 'fogo', label: 'Fogo', w: 0.15 },
      { key: 'marca', label: 'Marca / modelo', w: 0.45 },
      { key: 'tratamento', label: 'Tratamento', w: 0.40, colorize: true },
    ], dados.prioridades.descarte_pendente.map((p) => ({
      fogo: labelFogoPdf(p.fogo),
      marca: [p.marca, p.modelo].filter(Boolean).join(' ') || '-',
      tratamento: p.tratamento,
    })), { emptyText: 'Nenhum descarte pendente de tratamento.' });

    // ── 3. Frota ───────────────────────────────────────
    sectionTitle(doc, pager, '3', 'Frota - veiculo a veiculo');
    const comPneus = (dados.frota || []).filter((v) => v.pneus?.length);
    const semPneus = (dados.frota || []).filter((v) => !v.pneus?.length);

    if (!dados.frota?.length) {
      mutedLine(doc, pager, 'Nenhum veiculo ativo nesta unidade.');
    } else {
      if (semPneus.length) {
        subTitle(doc, pager, `Veiculos sem pneus montados (${semPneus.length})`, COLORS.muted);
        drawTable(doc, pager, [
          { key: 'placa', label: 'Placa', w: 0.22 },
          { key: 'apelido', label: 'Apelido', w: 0.28 },
          { key: 'tipo', label: 'Tipo', w: 0.30 },
          { key: 'km', label: 'KM', w: 0.20, align: 'right' },
        ], semPneus.map((v) => ({
          placa: v.placa,
          apelido: v.apelido || '-',
          tipo: v.tipo || '-',
          km: formatNum(v.km_atual),
        })));
      }

      if (comPneus.length) {
        subTitle(doc, pager, `Veiculos com pneus (${comPneus.length})`, COLORS.brand);
        comPneus.forEach((v) => drawVehicleBlock(doc, pager, v));
      }
    }

    // ── 4. Estoque ─────────────────────────────────────
    sectionTitle(doc, pager, '4', 'Estoque');
    drawTable(doc, pager, [
      { key: 'fogo', label: 'Fogo', w: 0.12 },
      { key: 'desc', label: 'Marca / modelo / medida', w: 0.34 },
      { key: 'padrao', label: 'Padrao', w: 0.14 },
      { key: 'vida', label: 'Vida', w: 0.12 },
      { key: 'custo', label: 'Custo', w: 0.14, align: 'right' },
      { key: 'nf', label: 'NF', w: 0.14 },
    ], dados.estoque.map((p) => ({
      fogo: labelFogoPdf(p.fogo),
      desc: [p.marca, p.modelo, p.medida].filter(Boolean).join(' ') || '-',
      padrao: labelPadraoPdf(p.padrao),
      vida: p.vida,
      custo: formatMoney(p.custo),
      nf: p.nota_fiscal || '-',
    })), { emptyText: 'Nenhum pneu em estoque.' });

    // ── 5. Descarte ────────────────────────────────────
    sectionTitle(doc, pager, '5', 'Descarte');
    drawTable(doc, pager, [
      { key: 'fogo', label: 'Fogo', w: 0.10 },
      { key: 'desc', label: 'Marca / modelo', w: 0.22 },
      { key: 'padrao', label: 'Padrao', w: 0.12 },
      { key: 'vida', label: 'Vida', w: 0.10 },
      { key: 'trat', label: 'Tratamento', w: 0.22, colorize: true },
      { key: 'em', label: 'Data', w: 0.10 },
      { key: 'obs', label: 'Obs.', w: 0.14 },
    ], dados.descarte.map((p) => ({
      fogo: labelFogoPdf(p.fogo),
      desc: [p.marca, p.modelo].filter(Boolean).join(' ') || '-',
      padrao: labelPadraoPdf(p.padrao),
      vida: p.vida,
      trat: p.tratamento,
      em: formatBr(p.tratamento_em),
      obs: p.obs || '-',
    })), { emptyText: 'Nenhum pneu no estoque de descarte.' });

    pager.ensureSpace(24);
    const endY = doc.y;
    doc.roundedRect(x0, endY, w, 20, 3).fill(COLORS.softAlt);
    doc.page.margins.bottom = 0;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
      .text(
        'Documento gerado pelo PneuSistemma para apoio a decisao do gerente da unidade.',
        x0 + 8,
        endY + 6,
        { width: w - 16, lineBreak: false }
      );
    doc.page.margins.bottom = savedBottom;
    doc.y = endY + 22;

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
