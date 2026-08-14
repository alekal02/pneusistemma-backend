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
} from '../pneus-layouts.js';

function pad2(n) {
  return String(n).padStart(2, '0');
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
      pneus: pneusDetalhe,
    });
  }

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

function clip(text, max = 40) {
  const s = String(text ?? '—');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, need = 60) {
  if (doc.y + need > pageBottom(doc)) doc.addPage();
}

function drawFooter(doc, dados) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - 34;
    doc.save();
    doc.strokeColor(COLORS.line).lineWidth(0.6)
      .moveTo(doc.page.margins.left, y - 8)
      .lineTo(doc.page.width - doc.page.margins.right, y - 8)
      .stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted);
    doc.text(
      `PneuSistemma · ${dados.filial.codigo} · ${dados.periodo.label}`,
      doc.page.margins.left,
      y,
      { width: contentWidth(doc) * 0.7, lineBreak: false }
    );
    doc.text(
      `Pág. ${i + 1} / ${pages.count}`,
      doc.page.margins.left,
      y,
      { width: contentWidth(doc), align: 'right', lineBreak: false }
    );
    doc.restore();
  }
}

function sectionTitle(doc, number, title) {
  ensureSpace(doc, 40);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = contentWidth(doc);
  doc.roundedRect(x, y, w, 24, 4).fill(COLORS.brand);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(11)
    .text(`${number}.  ${title}`, x + 12, y + 6, { width: w - 24, lineBreak: false });
  doc.y = y + 32;
}

function subTitle(doc, title, accent = COLORS.brand) {
  ensureSpace(doc, 28);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.rect(x, y + 2, 3, 12).fill(accent);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10)
    .text(title, x + 10, y, { width: contentWidth(doc) - 10 });
  doc.y = y + 18;
}

function mutedLine(doc, text) {
  ensureSpace(doc, 14);
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted)
    .text(text, { width: contentWidth(doc) });
  doc.moveDown(0.2);
}

function drawKpiGrid(doc, items) {
  const cols = 4;
  const gap = 8;
  const w = contentWidth(doc);
  const cardW = (w - gap * (cols - 1)) / cols;
  const cardH = 46;
  const startX = doc.page.margins.left;
  ensureSpace(doc, cardH + 8);
  let x = startX;
  let y = doc.y;

  items.forEach((item, idx) => {
    if (idx > 0 && idx % cols === 0) {
      const nextY = y + cardH + gap;
      if (nextY + cardH > pageBottom(doc)) {
        doc.addPage();
        x = startX;
        y = doc.y;
      } else {
        y = nextY;
        x = startX;
      }
    }
    doc.roundedRect(x, y, cardW, cardH, 5).fill(item.bg || COLORS.soft);
    doc.roundedRect(x, y, 4, cardH, 2).fill(item.accent || COLORS.brand);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
      .text(item.label, x + 12, y + 8, { width: cardW - 18, lineBreak: false });
    doc.fillColor(item.accent || COLORS.ink).font('Helvetica-Bold').fontSize(13)
      .text(String(item.value), x + 12, y + 22, { width: cardW - 18, lineBreak: false });
    x += cardW + gap;
  });
  doc.y = y + cardH + 12;
}

function drawTable(doc, columns, rows, { emptyText = 'Sem registros.' } = {}) {
  const x0 = doc.page.margins.left;
  const totalW = contentWidth(doc);
  const colWs = columns.map((c) => totalW * c.w);
  const rowH = 16;
  const headerH = 18;

  const drawHeader = () => {
    ensureSpace(doc, headerH + rowH);
    let x = x0;
    const y = doc.y;
    doc.rect(x0, y, totalW, headerH).fill(COLORS.ink);
    columns.forEach((col, i) => {
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(7.5)
        .text(col.label, x + 4, y + 5, { width: colWs[i] - 8, lineBreak: false });
      x += colWs[i];
    });
    doc.y = y + headerH;
  };

  drawHeader();

  if (!rows.length) {
    ensureSpace(doc, 22);
    doc.rect(x0, doc.y, totalW, 20).fill(COLORS.soft);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(emptyText, x0 + 8, doc.y + 6, { width: totalW - 16, lineBreak: false });
    doc.y += 28;
    return;
  }

  rows.forEach((row, ri) => {
    if (doc.y + rowH > pageBottom(doc)) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    const bg = ri % 2 === 0 ? COLORS.white : COLORS.soft;
    doc.rect(x0, y, totalW, rowH).fill(bg);
    let x = x0;
    columns.forEach((col, i) => {
      const raw = row[col.key];
      const val = clip(raw == null || raw === '' ? '—' : raw, col.max || 36);
      const color = col.colorize ? statusColor(val).fg : COLORS.ink;
      doc.fillColor(color)
        .font(col.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(7.5)
        .text(val, x + 4, y + 4, {
          width: colWs[i] - 8,
          align: col.align || 'left',
          lineBreak: false,
        });
      x += colWs[i];
    });
    doc.y = y + rowH;
  });
  doc.moveDown(0.55);
}

function drawVehicleBlock(doc, v) {
  const need = 54 + Math.max(1, v.pneus.length) * 16 + 24;
  ensureSpace(doc, Math.min(need, 120));
  const x0 = doc.page.margins.left;
  const w = contentWidth(doc);
  const st = statusColor(v.atrasado_semana ? 'atrasado' : v.status_label);
  const headH = 34;
  const y0 = doc.y;

  doc.roundedRect(x0, y0, w, headH, 4).fill(COLORS.softAlt);
  doc.rect(x0, y0, 5, headH).fill(st.fg);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10)
    .text(`${v.placa}${v.apelido ? `  ·  ${v.apelido}` : ''}`, x0 + 14, y0 + 6, {
      width: w * 0.55,
      lineBreak: false,
    });
  doc.fillColor(st.fg).font('Helvetica-Bold').fontSize(8)
    .text(v.atrasado_semana ? `${v.status_label} · ATRASADO` : v.status_label, x0 + 14, y0 + 6, {
      width: w - 28,
      align: 'right',
      lineBreak: false,
    });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
    .text([
      v.tipo || null,
      [v.marca, v.modelo].filter(Boolean).join(' ') || null,
      `KM ${formatNum(v.km_atual)}`,
      v.hr_atual != null ? `HR ${formatNum(v.hr_atual)}` : null,
      `${v.total_pneus} pneus`,
      `Últ. medição ${formatBr(v.ultima_medicao)}`,
    ].filter(Boolean).join('   ·   '), x0 + 14, y0 + 19, { width: w - 28, lineBreak: false });

  doc.y = y0 + headH + 4;

  if (!v.pneus.length) {
    mutedLine(doc, 'Sem pneus montados neste veículo.');
    doc.moveDown(0.3);
    return;
  }

  drawTable(doc, [
    { key: 'pos', label: 'Pos.', w: 0.07 },
    { key: 'fogo', label: 'Fogo', w: 0.09 },
    { key: 'padrao', label: 'Padrão', w: 0.12 },
    { key: 'vida', label: 'Vida', w: 0.09 },
    { key: 'sulcos', label: 'Ext / Cent / Int / Aux', w: 0.22 },
    { key: 'menor', label: 'Menor', w: 0.08, bold: true },
    { key: 'status', label: 'Status', w: 0.10, colorize: true },
    { key: 'acao', label: 'Ação', w: 0.12, colorize: true },
    { key: 'diag', label: 'Diagnóstico', w: 0.11 },
  ], v.pneus.map((p) => ({
    pos: p.posicao,
    fogo: p.fogo,
    padrao: p.padrao,
    vida: p.vida,
    sulcos: `${p.sulcos.ext ?? '—'} / ${p.sulcos.cent ?? '—'} / ${p.sulcos.int ?? '—'} / ${p.sulcos.aux ?? '—'}`,
    menor: p.menor_sulco != null ? `${p.menor_sulco}` : '—',
    status: p.status_label,
    acao: p.acao,
    diag: p.diagnostico,
  })));
}

/**
 * Gera Buffer PDF a partir dos dados montados.
 */
export function gerarPdfRelatorioSemanal(dados) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 42, bottom: 48, left: 36, right: 36 },
      bufferPages: true,
      info: {
        Title: dados.titulo,
        Author: 'PneuSistemma',
        Subject: `Unidade ${dados.filial.nome} — ${dados.periodo.label}`,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const r = dados.resumo;
    const x0 = doc.page.margins.left;
    const w = contentWidth(doc);

    // ── Cabeçalho ──────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 78).fill(COLORS.brand);
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18)
      .text('Relatório semanal gerencial', x0, 18, { width: w });
    doc.font('Helvetica').fontSize(9).fillColor('#99f6e4')
      .text('Controle de desgaste de pneus — apoio à decisão do gerente da unidade', x0, 42, { width: w });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.white)
      .text(`${dados.filial.nome}  (${dados.filial.codigo})`, x0, 58, { width: w * 0.55, lineBreak: false });
    doc.font('Helvetica').fontSize(9)
      .text(`Semana ${dados.periodo.label}`, x0, 58, { width: w, align: 'right', lineBreak: false });

    doc.y = 92;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8);
    const meta = [
      `Gerado em ${new Date(dados.gerado_em).toLocaleString('pt-BR')}`,
      dados.gerado_por ? `por ${dados.gerado_por}` : null,
      dados.filial.contrato ? `Contrato: ${dados.filial.contrato}` : null,
      `Limites: crítico ≤ ${dados.limites.critico_mm} mm · monitorar ≤ ${dados.limites.monitorar_ate_mm} mm · prazo recap ${dados.limites.prazo_recap_dias} d`,
    ].filter(Boolean).join('   ·   ');
    doc.text(meta, x0, doc.y, { width: w });
    doc.moveDown(0.8);

    // ── 1. Resumo ──────────────────────────────────────
    sectionTitle(doc, '1', 'Resumo executivo');
    drawKpiGrid(doc, [
      { label: 'VEÍCULOS', value: r.veiculos, accent: COLORS.brand, bg: COLORS.brandSoft },
      { label: 'PNEUS MONTADOS', value: r.pneus_montados, accent: COLORS.ink, bg: COLORS.softAlt },
      { label: 'ESTOQUE', value: r.pneus_estoque, accent: COLORS.ink, bg: COLORS.softAlt },
      { label: 'DESCARTE', value: r.pneus_descarte, accent: COLORS.muted, bg: COLORS.soft },
      { label: 'OK', value: r.sulco_ok, accent: COLORS.ok, bg: COLORS.okBg },
      { label: 'MONITORAR', value: r.sulco_monitorar, accent: COLORS.alerta, bg: COLORS.alertaBg },
      { label: 'CRÍTICO', value: r.sulco_critico, accent: COLORS.critico, bg: COLORS.criticoBg },
      { label: 'SEM MEDIÇÃO', value: r.sem_medicao, accent: COLORS.muted, bg: COLORS.softAlt },
      { label: 'TROCAR', value: r.acao_trocar, accent: COLORS.critico, bg: COLORS.criticoBg },
      { label: 'RECAP', value: r.acao_recap, accent: COLORS.alerta, bg: COLORS.alertaBg },
      { label: 'RODÍZIO', value: r.acao_rodizio, accent: COLORS.brand, bg: COLORS.brandSoft },
      { label: 'MEDIÇÕES NA SEMANA', value: r.medicoes_semana, accent: COLORS.brand, bg: COLORS.brandSoft },
    ]);

    drawKpiGrid(doc, [
      { label: 'ATRASADOS (≥7 DIAS)', value: r.veiculos_atrasados_medicao, accent: COLORS.alerta, bg: COLORS.alertaBg },
      { label: 'DESCARTE PENDENTE', value: r.descarte_aguardando, accent: COLORS.critico, bg: COLORS.criticoBg },
      { label: 'CUSTO MONTADO', value: formatMoney(r.custo_montado), accent: COLORS.ink, bg: COLORS.softAlt },
      { label: 'CUSTO ESTOQUE', value: formatMoney(r.custo_estoque), accent: COLORS.ink, bg: COLORS.softAlt },
    ]);

    // ── 2. Prioridades ─────────────────────────────────
    sectionTitle(doc, '2', 'Prioridades da semana — decisão');

    subTitle(doc, `Trocar / crítico (${dados.prioridades.troca.length})`, COLORS.critico);
    drawTable(doc, [
      { key: 'veiculo', label: 'Veículo', w: 0.16 },
      { key: 'pos', label: 'Pos.', w: 0.08 },
      { key: 'fogo', label: 'Fogo', w: 0.10 },
      { key: 'menor', label: 'Sulco', w: 0.10, bold: true },
      { key: 'status', label: 'Status', w: 0.12, colorize: true },
      { key: 'acao', label: 'Ação', w: 0.14, colorize: true },
      { key: 'diag', label: 'Diagnóstico', w: 0.30 },
    ], dados.prioridades.troca.map((i) => ({
      veiculo: i.placa || i.apelido || '—',
      pos: i.posicao,
      fogo: i.fogo,
      menor: mm(i.menor_sulco),
      status: i.status_label,
      acao: i.acao,
      diag: i.diagnostico,
    })), { emptyText: 'Nenhum pneu crítico / troca no momento.' });

    subTitle(doc, `Monitorar / recap (${dados.prioridades.monitorar.length})`, COLORS.alerta);
    drawTable(doc, [
      { key: 'veiculo', label: 'Veículo', w: 0.16 },
      { key: 'pos', label: 'Pos.', w: 0.08 },
      { key: 'fogo', label: 'Fogo', w: 0.10 },
      { key: 'menor', label: 'Sulco', w: 0.10, bold: true },
      { key: 'status', label: 'Status', w: 0.12, colorize: true },
      { key: 'acao', label: 'Ação', w: 0.14, colorize: true },
      { key: 'diag', label: 'Diagnóstico', w: 0.30 },
    ], dados.prioridades.monitorar.map((i) => ({
      veiculo: i.placa || i.apelido || '—',
      pos: i.posicao,
      fogo: i.fogo,
      menor: mm(i.menor_sulco),
      status: i.status_label,
      acao: i.acao,
      diag: i.diagnostico,
    })), { emptyText: 'Nenhum pneu em monitorar / recap.' });

    subTitle(doc, `Rodízio (${dados.prioridades.rodizio.length})`, COLORS.brand);
    drawTable(doc, [
      { key: 'veiculo', label: 'Veículo', w: 0.16 },
      { key: 'pos', label: 'Pos.', w: 0.08 },
      { key: 'fogo', label: 'Fogo', w: 0.10 },
      { key: 'menor', label: 'Sulco', w: 0.10, bold: true },
      { key: 'status', label: 'Status', w: 0.12, colorize: true },
      { key: 'acao', label: 'Ação', w: 0.14, colorize: true },
      { key: 'diag', label: 'Diagnóstico', w: 0.30 },
    ], dados.prioridades.rodizio.map((i) => ({
      veiculo: i.placa || i.apelido || '—',
      pos: i.posicao,
      fogo: i.fogo,
      menor: mm(i.menor_sulco),
      status: i.status_label,
      acao: i.acao,
      diag: i.diagnostico,
    })), { emptyText: 'Nenhum rodízio sugerido.' });

    subTitle(doc, `Descarte aguardando destino (${dados.prioridades.descarte_pendente.length})`, COLORS.critico);
    drawTable(doc, [
      { key: 'fogo', label: 'Fogo', w: 0.15 },
      { key: 'marca', label: 'Marca / modelo', w: 0.45 },
      { key: 'tratamento', label: 'Tratamento', w: 0.40, colorize: true },
    ], dados.prioridades.descarte_pendente.map((p) => ({
      fogo: p.fogo,
      marca: [p.marca, p.modelo].filter(Boolean).join(' ') || '—',
      tratamento: p.tratamento,
    })), { emptyText: 'Nenhum descarte pendente de tratamento.' });

    // ── 3. Frota ───────────────────────────────────────
    sectionTitle(doc, '3', 'Frota — veículo a veículo');
    if (!dados.frota.length) mutedLine(doc, 'Nenhum veículo ativo nesta unidade.');
    else dados.frota.forEach((v) => drawVehicleBlock(doc, v));

    // ── 4. Estoque ─────────────────────────────────────
    sectionTitle(doc, '4', 'Estoque');
    drawTable(doc, [
      { key: 'fogo', label: 'Fogo', w: 0.12 },
      { key: 'desc', label: 'Marca / modelo / medida', w: 0.34 },
      { key: 'padrao', label: 'Padrão', w: 0.14 },
      { key: 'vida', label: 'Vida', w: 0.12 },
      { key: 'custo', label: 'Custo', w: 0.14, align: 'right' },
      { key: 'nf', label: 'NF', w: 0.14 },
    ], dados.estoque.map((p) => ({
      fogo: p.fogo,
      desc: [p.marca, p.modelo, p.medida].filter(Boolean).join(' ') || '—',
      padrao: p.padrao,
      vida: p.vida,
      custo: formatMoney(p.custo),
      nf: p.nota_fiscal || '—',
    })), { emptyText: 'Nenhum pneu em estoque.' });

    // ── 5. Descarte ────────────────────────────────────
    sectionTitle(doc, '5', 'Descarte');
    drawTable(doc, [
      { key: 'fogo', label: 'Fogo', w: 0.10 },
      { key: 'desc', label: 'Marca / modelo', w: 0.22 },
      { key: 'padrao', label: 'Padrão', w: 0.12 },
      { key: 'vida', label: 'Vida', w: 0.10 },
      { key: 'trat', label: 'Tratamento', w: 0.22, colorize: true },
      { key: 'em', label: 'Data', w: 0.10 },
      { key: 'obs', label: 'Obs.', w: 0.14 },
    ], dados.descarte.map((p) => ({
      fogo: p.fogo,
      desc: [p.marca, p.modelo].filter(Boolean).join(' ') || '—',
      padrao: p.padrao,
      vida: p.vida,
      trat: p.tratamento,
      em: formatBr(p.tratamento_em),
      obs: p.obs || '—',
    })), { emptyText: 'Nenhum pneu no estoque de descarte.' });

    ensureSpace(doc, 30);
    doc.roundedRect(x0, doc.y, w, 22, 4).fill(COLORS.softAlt);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text('Documento gerado pelo PneuSistemma para apoio à decisão do gerente da unidade.', x0 + 10, doc.y + 7, {
        width: w - 20,
        lineBreak: false,
      });

    drawFooter(doc, dados);
    doc.end();
  });
}

export async function gerarRelatorioSemanalPdfBuffer(filialId, opts = {}) {
  const dados = await montarDadosRelatorioSemanal(filialId, opts);
  const buffer = await gerarPdfRelatorioSemanal(dados);
  const nome = `relatorio-semanal-${dados.filial.codigo || filialId}-${dados.periodo.inicio}.pdf`
    .replace(/[^\w.\-]+/g, '_');
  return { buffer, filename: nome, dados };
}
