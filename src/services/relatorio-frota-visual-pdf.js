/**
 * Páginas visuais do relatório — mesmo desenho do Preview-Frota-Visual.pdf
 * (caminhão vista de cima, centralizado no card + log + ações/diagnósticos).
 */
const MM = 2.834645669;

const C = {
  fundo: '#f4f6f5',
  branco: '#ffffff',
  verde: '#145223',
  texto: '#1a1a1a',
  mudo: '#5f6b66',
  linha: '#d5ddd7',
  ok: '#16a34a',
  alerta: '#d97706',
  critico: '#dc2626',
  cinza: '#94a3b8',
  critBg: '#fdecea',
  alertaBg: '#fff8e1',
  okBg: '#e8f5e9',
  card: '#ffffff',
  chassis: '#c5d0c8',
};

const PNEU_W = 15;
const PNEU_H = 20;

/** Vista de cima truck 10: (codigo, dx, dy) — dy cresce da frente para trás */
const LAYOUT_10 = [
  ['1E', 28, 22], ['1D', 78, 22],
  ['2EE', 16, 52], ['2EI', 36, 52], ['2DI', 70, 52], ['2DE', 90, 52],
  ['3EE', 16, 82], ['3EI', 36, 82], ['3DI', 70, 82], ['3DE', 90, 82],
];

const LAYOUT_BOX = (() => {
  const xs = LAYOUT_10.map(([, dx]) => dx);
  const ys = LAYOUT_10.map(([, , dy]) => dy);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    minX,
    minY,
    w: Math.max(...xs) + PNEU_W - minX,
    h: Math.max(...ys) + PNEU_H - minY,
  };
})();

const POS_ALIAS = {
  DE: '1E', DD: '1D',
  E2EE: '2EE', E2EI: '2EI', E2DI: '2DI', E2DE: '2DE',
  E3EE: '3EE', E3EI: '3EI', E3DI: '3DI', E3DE: '3DE',
  TEE: '2EE', TEI: '2EI', TDI: '2DI', TDE: '2DE',
  '2E': '2EE', '2D': '2DE',
  '3E': '3EE', '3D': '3DE',
};

function rrect(doc, x, y, w, h, r, fill, stroke) {
  if (fill) {
    doc.roundedRect(x, y, w, h, r).fill(fill);
  }
  if (stroke) {
    doc.lineWidth(0.6).strokeColor(stroke).roundedRect(x, y, w, h, r).stroke();
  }
}

function fillStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('crit')) return C.critico;
  if (s.includes('alerta') || s.includes('monitor')) return C.alerta;
  if (s === 'ok') return C.ok;
  return C.cinza;
}

function bgStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('crit')) return C.critBg;
  if (s.includes('alerta') || s.includes('monitor')) return C.alertaBg;
  if (s === 'ok') return C.okBg;
  return C.card;
}

function labelStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('crit')) return 'Critico';
  if (s.includes('alerta') || s.includes('monitor')) return 'Alerta';
  if (s === 'ok') return 'OK';
  return 'Sem medicao';
}

function normPos(pos) {
  const p = String(pos || '').toUpperCase();
  return POS_ALIAS[p] || p;
}

function pneusPorPos(pneus = []) {
  const map = new Map();
  for (const p of pneus) {
    map.set(normPos(p.posicao), p);
  }
  return map;
}

/** Desenha uma linha só. Nunca passa `width` ao PDFKit — isso parte a célula em páginas. */
function txt(doc, str, x, y, opts = {}) {
  if (y > doc.page.height - 6) return;
  const savedY = doc.y;
  const savedB = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  let shown = String(str ?? '').replace(/\s+/g, ' ').trim();
  const maxW = opts.width;
  if (maxW) {
    if (doc.widthOfString(shown) > maxW) {
      while (shown.length > 1 && doc.widthOfString(`${shown}…`) > maxW) shown = shown.slice(0, -1);
      shown = `${shown}…`;
    }
  }
  let drawX = x;
  if (maxW && opts.align === 'right') drawX = x + maxW - doc.widthOfString(shown);
  else if (maxW && opts.align === 'center') drawX = x + (maxW - doc.widthOfString(shown)) / 2;
  doc.text(shown, drawX, y, { lineBreak: false });
  doc.page.margins.bottom = savedB;
  doc.y = savedY;
}

function drawPneu(doc, x, y, cor, label, mmTxt) {
  rrect(doc, x, y, PNEU_W, PNEU_H, 3, cor, cor === C.ok ? '#14532d' : null);
  doc.fillColor(C.branco).font('Helvetica-Bold').fontSize(5);
  txt(doc, label, x, y + 3.2, { width: PNEU_W, align: 'center' });
  doc.fontSize(4.8);
  txt(doc, mmTxt, x, y + 11.2, { width: PNEU_W, align: 'center' });
}

/** Card no estilo do preview: desenho centralizado, texto só na faixa de baixo. */
function drawCardCaminhao(doc, x, y, w, h, veiculo) {
  const footer = 16 * MM;
  const fundo = bgStatus(veiculo.status_sulco || veiculo.status_label);
  rrect(doc, x, y, w, h, 8, fundo, C.linha);

  doc.strokeColor(C.linha).lineWidth(0.5)
    .moveTo(x + 8, y + h - footer).lineTo(x + w - 8, y + h - footer).stroke();

  const apelido = String(veiculo.apelido || '').trim();
  const placa = String(veiculo.placa || '').trim();
  const nome = apelido || placa || '-';
  const secundario = [
    apelido && placa ? placa : null,
    veiculo.tipo || null,
  ].filter(Boolean).join(' · ');
  const quando = veiculo.ultima_medicao
    ? String(veiculo.ultima_medicao).slice(0, 10).split('-').reverse().join('/')
    : 'Sem medicao';
  const sulco = veiculo.menor_sulco != null ? `${veiculo.menor_sulco} mm` : '-';
  const status = labelStatus(veiculo.status_sulco || veiculo.status_label);

  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(9);
  txt(doc, nome, x + 8, y + h - footer + 3, { width: w * 0.62 });
  doc.fillColor(C.mudo).font('Helvetica').fontSize(6.5);
  txt(doc, secundario || quando, x + 8, y + h - footer + 15, { width: w * 0.62 });
  doc.fontSize(6);
  txt(doc, secundario ? quando : '', x + 8, y + h - footer + 25, { width: w * 0.62 });
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(8);
  txt(doc, sulco, x + 8, y + h - 22, { width: w - 16, align: 'right' });
  doc.fillColor(fillStatus(status)).font('Helvetica-Bold').fontSize(7.5);
  txt(doc, status, x + 8, y + h - 12, { width: w - 16, align: 'right' });

  const frenteH = 11;
  doc.fillColor(C.mudo).font('Helvetica').fontSize(6);
  txt(doc, 'FRENTE', x, y + 5, { width: w, align: 'center' });

  const areaTop = y + frenteH + 2;
  const areaBot = y + h - footer - 4;
  const areaH = areaBot - areaTop;
  const pad = 8;
  const ox = x + (w - LAYOUT_BOX.w) / 2 - LAYOUT_BOX.minX;
  const oy = areaTop + (areaH - LAYOUT_BOX.h) / 2 - LAYOUT_BOX.minY;

  doc.lineWidth(1.1).strokeColor(C.chassis)
    .roundedRect(
      ox + LAYOUT_BOX.minX - pad,
      oy + LAYOUT_BOX.minY - pad,
      LAYOUT_BOX.w + pad * 2,
      LAYOUT_BOX.h + pad * 2,
      10,
    ).stroke();

  const byPos = pneusPorPos(veiculo.pneus);
  for (const [codigo, dx, dy] of LAYOUT_10) {
    const p = byPos.get(codigo);
    const cor = p ? fillStatus(p.status_sulco || p.status_label) : C.cinza;
    const mmTxt = p?.menor_sulco != null ? String(p.menor_sulco) : '-';
    const label = codigo.length > 2 ? codigo.slice(-2) : codigo;
    drawPneu(doc, ox + dx, oy + dy, cor, label, mmTxt);
  }
}

function drawKpi(doc, x, y, w, h, valor, label, barra) {
  rrect(doc, x, y, w, h, 7, C.card, C.linha);
  doc.rect(x, y, 4, h).fill(barra);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(16);
  txt(doc, String(valor ?? 0), x + 12, y + 8);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7.5);
  txt(doc, label, x + 12, y + h - 14);
}

function dataCurta(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  if (s.length < 10) return '—';
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}

function logDoCaminhao(veiculo) {
  return {
    data: veiculo.ultima_medicao,
    hora: dataCurta(veiculo.ultima_medicao),
    placa: veiculo.apelido || veiculo.placa || '-',
    menor_sulco: veiculo.menor_sulco,
    status: veiculo.status_sulco || veiculo.status_label,
  };
}

function chaveItem(item) {
  return `${item.veiculo_id || item.placa || item.apelido || ''}|${item.posicao || ''}`;
}

function unicosPorPosicao(lista) {
  const seen = new Set();
  const out = [];
  for (const item of lista || []) {
    const key = chaveItem(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function drawLogLinha(doc, x, y, w, item) {
  const fundo = bgStatus(item.status || item.status_sulco);
  rrect(doc, x, y, w, 28, 3, fundo, null);
  const data = item.hora || dataCurta(item.data);
  const placa = item.placa || '-';
  const sulco = item.menor_sulco != null ? `${item.menor_sulco} mm` : (item.sulco || '-');
  const st = labelStatus(item.status || item.status_sulco);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7.5);
  txt(doc, data, x + 6, y + 6);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(8.5);
  txt(doc, placa, x + 44, y + 6);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(8);
  txt(doc, sulco, x + 6, y + 16);
  doc.fillColor(fillStatus(st)).font('Helvetica-Bold').fontSize(8);
  txt(doc, st, x + 6, y + 16, { width: w - 12, align: 'right' });
}

function cabecalho(doc, W, titulo, sub) {
  rrect(doc, 0, 0, W, 28 * MM, 0, C.verde, null);
  doc.fillColor(C.branco).font('Helvetica-Bold').fontSize(9);
  txt(doc, 'PNEUSISTEMMA', W / 2 - 80, 8, { width: 160, align: 'center' });
  doc.fontSize(16);
  txt(doc, titulo, 24, 20, { width: W - 48, align: 'center' });
  doc.font('Helvetica').fontSize(9);
  txt(doc, sub, 24, 42, { width: W - 48, align: 'center' });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out.length ? out : [[]];
}

/**
 * Página 1+ da frota: KPIs + 3 caminhões centralizados + log.
 */
export function desenharPaginaFrota(doc, dados, veiculos, logs, pagina, totalPaginas) {
  const W = doc.page.width;
  const H = doc.page.height;
  const margin = 12 * MM;
  const primeira = pagina === 1;
  doc.rect(0, 0, W, H).fill(C.fundo);

  const filial = dados.filial?.nome || 'Unidade';
  const periodo = dados.periodo?.label || '';
  const tipoTitulo = dados.filtro_label || 'Todos os equipamentos';
  cabecalho(
    doc,
    W,
    dados.titulo || `Relatorio semanal — ${tipoTitulo}`,
    `${filial}${periodo ? `  ·  Semana ${periodo}` : ''}  ·  ${tipoTitulo}`,
  );

  let y = 40 * MM;

  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11);
  txt(doc, primeira ? 'Caminhoes da unidade' : 'Mais caminhoes', margin, y);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  txt(doc, 'Vermelho = acao agora  ·  data da medicao no card', margin + 52 * MM, y);

  y += 6 * MM;
  const cols = 3;
  const rows = 2;
  const gap = 4 * MM;
  const cw = (W - 2 * margin - gap * (cols - 1)) / cols;
  const ch = 68 * MM;

  if (!veiculos.length) {
    rrect(doc, margin, y, cw, ch, 8, C.card, C.linha);
    doc.fillColor(C.mudo).font('Helvetica').fontSize(9);
    txt(doc, 'Nenhum veiculo com pneu montado nesta unidade.', margin, y + ch / 2 - 6, {
      width: cw, align: 'center',
    });
  } else {
    veiculos.slice(0, cols * rows).forEach((v, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      drawCardCaminhao(doc, margin + col * (cw + gap), y + row * (ch + gap), cw, ch, v);
    });
  }

  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  txt(doc, `Pneusistemma  ·  ${pagina}/${totalPaginas}`, W - margin - 120, H - 12, {
    width: 120, align: 'right',
  });
}

function statusChave(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('crit')) return 'critico';
  if (s.includes('alerta') || s.includes('monitor') || s.includes('aten')) return 'alerta';
  if (s === 'ok') return 'ok';
  if (s.includes('sem')) return 'sem_dado';
  return 'sem_dado';
}

function rotuloStatus(chave) {
  if (chave === 'critico') return 'Critico';
  if (chave === 'alerta') return 'Atencao';
  if (chave === 'ok') return 'OK';
  return 'Sem medicao';
}

function acaoResumida(chave) {
  if (chave === 'critico') return 'Sulco critico. Trocar o pneu.';
  if (chave === 'alerta') return 'Desgaste em atencao. Acompanhar.';
  if (chave === 'ok') return 'Dentro do limite.';
  return 'Sem medicao. Medir nesta semana.';
}

function corStatus(chave) {
  if (chave === 'critico') return C.critico;
  if (chave === 'alerta') return C.alerta;
  if (chave === 'ok') return C.ok;
  return C.cinza;
}

/** Só exceção: crítico, atenção e sem medição. OK não entra pneu a pneu. */
function linhasDecisao(dados) {
  const rank = { critico: 0, alerta: 1, sem_dado: 2 };
  const map = new Map();
  for (const v of dados.frota || []) {
    for (const p of v.pneus || []) {
      const chave = statusChave(p.status_sulco || p.status_label);
      if (chave === 'ok') continue;
      const apelido = String(v.apelido || '').trim();
      const placa = String(v.placa || '').trim();
      const nome = apelido || placa || '-';
      const key = `${v.id || placa}|${chave}`;
      if (!map.has(key)) {
        map.set(key, {
          nome,
          detalhe: [apelido && placa ? placa : null, v.tipo || null].filter(Boolean).join(' · '),
          pos: [],
          menor: null,
          chave,
        });
      }
      const g = map.get(key);
      if (p.posicao) g.pos.push(p.posicao);
      if (p.menor_sulco != null) {
        g.menor = g.menor == null ? Number(p.menor_sulco) : Math.min(g.menor, Number(p.menor_sulco));
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => (rank[a.chave] - rank[b.chave]) || a.nome.localeCompare(b.nome, 'pt'))
    .map((g) => ({
      veiculo: [g.nome, g.detalhe].filter(Boolean),
      posicao: g.pos.join(' '),
      medicao: g.menor != null ? `${g.menor} mm` : '—',
      status: rotuloStatus(g.chave),
      acao: acaoResumida(g.chave),
      chave: g.chave,
    }));
}

function novaPagina(doc) {
  doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
}

function abrirPagina(doc, titulo, sub) {
  const W = doc.page.width;
  const H = doc.page.height;
  doc.rect(0, 0, W, H).fill(C.fundo);
  cabecalho(doc, W, titulo, sub);
  return 34 * MM;
}

/**
 * Tabela de altura fixa. A linha inteira cabe na página ou vai para a próxima.
 * Célula nunca recebe width no PDFKit.
 */
function desenharTabela(doc, ctx) {
  const margin = 12 * MM;
  const H = doc.page.height;
  const tableW = doc.page.width - 2 * margin;
  const colWs = ctx.columns.map((c) => tableW * c.w);
  const headH = 16;
  const rowH = ctx.rowH || 14;
  const bottom = 18;
  let y = ctx.y;

  const paintSection = (cont) => {
    if (!ctx.section) return;
    doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(10);
    txt(doc, cont ? `${ctx.section} (cont.)` : ctx.section, margin, y, { width: tableW });
    y += 14;
  };

  const paintHead = () => {
    let x = margin;
    doc.rect(margin, y, tableW, headH).fill(C.verde);
    ctx.columns.forEach((c, i) => {
      doc.fillColor(C.branco).font('Helvetica-Bold').fontSize(7);
      txt(doc, c.label, x + 3, y + 4, { width: colWs[i] - 6 });
      x += colWs[i];
    });
    y += headH;
  };

  const quebra = () => {
    novaPagina(doc);
    y = abrirPagina(doc, ctx.pageTitle, ctx.pageSub);
    paintSection(true);
    paintHead();
  };

  const precisa = 14 + headH + rowH;
  if (y + precisa > H - bottom) quebra();
  else {
    paintSection(false);
    paintHead();
  }

  if (!ctx.rows.length) {
    doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
    txt(doc, ctx.empty || 'Sem registros.', margin + 4, y + 3, { width: tableW - 8 });
    return y + rowH + 8;
  }

  ctx.rows.forEach((row, i) => {
    if (y + rowH > H - bottom) quebra();
    if (i % 2 === 0) doc.rect(margin, y, tableW, rowH).fill('#f7faf8');
    let x = margin;
    ctx.columns.forEach((c, ci) => {
      const bruto = row[c.key];
      const lines = (Array.isArray(bruto) ? bruto : [bruto]).filter((ln) => ln != null && ln !== '').slice(0, 2);
      const color = typeof c.color === 'function' ? c.color(row) : (c.color || C.texto);
      lines.forEach((ln, li) => {
        doc.fillColor(li === 0 ? color : C.mudo).font(li === 0 && c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(li === 0 ? (c.size || 7.5) : 6.5);
        txt(doc, ln, x + 3, y + 3 + li * 10, { width: colWs[ci] - 6 });
      });
      if (!lines.length) {
        doc.fillColor(C.mudo).font('Helvetica').fontSize(7.5);
        txt(doc, '-', x + 3, y + 4, { width: colWs[ci] - 6 });
      }
      x += colWs[ci];
    });
    y += rowH;
  });
  return y + 10;
}

function colunasDecisao() {
  return [
    { key: 'veiculo', label: 'Veiculo', w: 0.24, bold: true, size: 8 },
    { key: 'posicao', label: 'Posicao', w: 0.22, size: 7 },
    { key: 'medicao', label: 'Medicao', w: 0.12, bold: true },
    { key: 'status', label: 'Status', w: 0.12, bold: true, color: (row) => corStatus(row.chave) },
    { key: 'acao', label: 'Acao', w: 0.30, size: 7 },
  ];
}

function txtUso(row) {
  const partes = [];
  if (row.km != null) partes.push(`${row.km} km`);
  if (row.horas != null) partes.push(`${row.horas} h`);
  return partes.join(' / ') || '-';
}

function txtRend(row) {
  if (row.rendimento == null) return '-';
  return `${row.rendimento} ${row.rendimento_unidade || ''}`.trim();
}

function desenharEvolucaoDesgaste(doc, dados) {
  const bloco = dados.evolucao_desgaste;
  const linhas = bloco?.linhas || [];
  if (!linhas.length) return;
  const res = bloco.resumo || {};
  const partes = [`${res.ciclos || linhas.length} ciclos com desgaste medido`];
  if (res.mediana_km_mm != null) partes.push(`mediana ${res.mediana_km_mm} km/mm`);
  if (res.mediana_h_mm != null) partes.push(`mediana ${res.mediana_h_mm} h/mm`);
  if (res.omitidos) partes.push(`${res.omitidos} fora desta pagina`);
  const sub = partes.join('  ·  ');
  novaPagina(doc);
  const y = abrirPagina(doc, 'EVOLUÇÃO DO DESGASTE', sub);
  desenharTabela(doc, {
    y,
    pageTitle: 'EVOLUÇÃO DO DESGASTE',
    pageSub: sub,
    section: 'Por ciclo da banda. Periodo em estoque nao entra no KM/horas.',
    rowH: 14,
    columns: [
      { key: 'pneu', label: 'PNEU', w: 0.11, bold: true },
      { key: 'veiculo', label: 'VEICULO/APELIDO', w: 0.18 },
      { key: 'posicao', label: 'POSICAO', w: 0.08 },
      { key: 'ciclo', label: 'CICLO', w: 0.09, bold: true },
      { key: 'inicial', label: 'INICIAL', w: 0.09 },
      { key: 'atual', label: 'ATUAL', w: 0.09 },
      { key: 'consumido', label: 'CONSUMIDO', w: 0.10 },
      { key: 'uso', label: 'KM/HORAS', w: 0.14 },
      { key: 'rendimento', label: 'RENDIMENTO', w: 0.12, bold: true },
    ],
    rows: linhas.map((l) => ({
      pneu: l.fogo || '-',
      veiculo: l.veiculo || '-',
      posicao: l.posicao || '-',
      ciclo: l.ciclo || '-',
      inicial: l.inicial != null ? `${l.inicial}` : '-',
      atual: l.atual != null ? `${l.atual}` : '-',
      consumido: l.consumido != null ? `${l.consumido}` : '-',
      uso: txtUso(l),
      rendimento: txtRend(l),
    })),
  });
}

function desenharDecisao(doc, dados) {
  const rows = linhasDecisao(dados);
  if (!rows.length) return false;
  const titulo = dados.titulo || 'Relatorio semanal';
  const sub = `${dados.filtro_label || 'Todos'}  ·  somente critico, atencao e sem medicao, agrupados por veiculo`;
  novaPagina(doc);
  const y = abrirPagina(doc, titulo, sub);
  desenharTabela(doc, {
    y,
    pageTitle: titulo,
    pageSub: sub,
    section: `Acoes e diagnosticos (${rows.length})`,
    columns: colunasDecisao(),
    rows,
    rowH: 24,
    empty: 'Nenhuma medicao nesta selecao.',
  });
  return true;
}

function agregarEstoque(dados) {
  const r = dados.estoque_resumo || {};
  const lista = dados.estoque || [];
  const total = Number(r.total ?? lista.length) || 0;
  if (r.total != null || r.por_padrao) {
    const critico = Number(r.criticos) || 0;
    const alerta = Number(r.alerta) || 0;
    const sem = Number(r.sem_medicao) || 0;
    return {
      total,
      critico,
      alerta,
      sem,
      ok: Math.max(0, total - critico - alerta - sem),
      tipos: Object.entries(r.por_padrao || {}).sort((a, b) => b[1] - a[1]),
    };
  }
  let critico = 0;
  let alerta = 0;
  let ok = 0;
  let sem = 0;
  const tipos = new Map();
  for (const p of lista) {
    const tipo = String(p.padrao || p.vida || 'Outros');
    tipos.set(tipo, (tipos.get(tipo) || 0) + 1);
    if (p.sulco == null) sem += 1;
    else if (Number(p.sulco) < 3) critico += 1;
    else if (Number(p.sulco) <= 8) alerta += 1;
    else ok += 1;
  }
  return {
    total: lista.length,
    critico,
    alerta,
    sem,
    ok,
    tipos: [...tipos.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function desenharPaginaResumo(doc, dados) {
  const W = doc.page.width;
  const H = doc.page.height;
  const margin = 12 * MM;
  doc.rect(0, 0, W, H).fill(C.fundo);
  const filial = dados.filial?.nome || 'Unidade';
  const periodo = dados.periodo?.label || '';
  const tipoTitulo = dados.filtro_label || 'Todos os equipamentos';
  cabecalho(
    doc,
    W,
    dados.titulo || `Relatorio semanal - ${tipoTitulo}`,
    `${filial}${periodo ? `  ·  Semana ${periodo}` : ''}  ·  ${tipoTitulo}`,
  );

  let y = 36 * MM;
  const r = dados.resumo || {};
  const kpis = [
    [r.veiculos ?? (dados.frota || []).length, 'Veiculos', C.verde],
    [r.sulco_ok ?? 0, 'OK', C.ok],
    [r.sulco_monitorar ?? 0, 'Atencao', C.alerta],
    [r.sulco_critico ?? 0, 'Critico', C.critico],
    [r.acao_trocar ?? 0, 'Acao agora', C.critico],
  ];
  const kw = (W - 2 * margin - 16) / 5;
  kpis.forEach((k, i) => {
    drawKpi(doc, margin + i * (kw + 4), y, kw, 18 * MM, k[0], k[1], k[2]);
  });
  y += 22 * MM;

  const uso = r.indicadores_uso || {};
  const mediaTxt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));
  const modo = dados.unidade_relatorio || 'misto';
  const blocos = [];
  if (modo !== 'horas') {
    const km = uso.km || {};
    blocos.push(`KM: media ${mediaTxt(km.media)} (${km.veiculos || 0} veiculos, OK ${km.ok || 0} · Atencao ${km.monitorar || 0} · Critico ${km.critico || 0})`);
  }
  if (modo !== 'km') {
    const horas = uso.horas || {};
    blocos.push(`HORAS: media ${mediaTxt(horas.media)} (${horas.veiculos || 0} veiculos, OK ${horas.ok || 0} · Atencao ${horas.monitorar || 0} · Critico ${horas.critico || 0})`);
  }
  blocos.forEach((linha) => {
    doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
    txt(doc, linha, margin, y, { width: W - 2 * margin });
    y += 12;
  });
  y += 6;

  const ok = Number(r.sulco_ok) || 0;
  const atencao = Number(r.sulco_monitorar) || 0;
  const critico = Number(r.sulco_critico) || 0;
  const sem = Number(r.sem_medicao) || 0;
  const soma = ok + atencao + critico + sem || 1;
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11);
  txt(doc, 'Distribuicao por status', margin, y);
  y += 16;
  const faixas = [
    ['Critico', critico, C.critico],
    ['Atencao', atencao, C.alerta],
    ['OK', ok, C.ok],
    ['Sem medicao', sem, C.cinza],
  ];
  const barMax = W - 2 * margin - 160;
  faixas.forEach(([nome, qtd, cor]) => {
    doc.fillColor(C.texto).font('Helvetica').fontSize(8);
    txt(doc, `${nome}`, margin, y, { width: 80 });
    txt(doc, String(qtd), margin + 84, y, { width: 36 });
    const bw = Math.max(2, Math.round((qtd / soma) * barMax));
    doc.rect(margin + 130, y - 1, bw, 10).fill(cor);
    y += 16;
  });
  y += 8;

  const est = agregarEstoque(dados);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11);
  txt(doc, `Estoque — resumo (${est.total})`, margin, y);
  y += 14;
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  txt(
    doc,
    `Critico ${est.critico}  ·  Atencao ${est.alerta}  ·  OK ${est.ok}  ·  Sem medicao ${est.sem}`,
    margin,
    y,
    { width: W - 2 * margin },
  );
  y += 14;
  const tipos = est.tipos.slice(0, 8);
  if (tipos.length) {
    const extraTipos = est.tipos.length - tipos.length;
    const linhaTipos = tipos.map(([nome, qtd]) => `${nome}: ${qtd}`).join('   ');
    txt(doc, extraTipos ? `${linhaTipos}   +${extraTipos} tipos` : linhaTipos, margin, y, { width: W - 2 * margin });
    y += 16;
  }

  const nRecap = (dados.em_recapagem || []).length || Number(r.pneus_em_recapagem) || 0;
  const nDesc = (dados.descarte || []).length || Number(r.pneus_descarte) || 0;
  const nMov = (dados.historico || []).length || Number(r.movimentacoes_semana) || 0;
  doc.fillColor(C.texto).font('Helvetica').fontSize(8);
  txt(doc, `Recapagem: ${nRecap}   ·   Descarte: ${nDesc}   ·   Movimentos na semana: ${nMov}`, margin, y, { width: W - 2 * margin });
  y += 18;
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  txt(doc, 'Proxima pagina: frota visual. Depois, so pneus que pedem acao (critico e atencao).', margin, y, { width: W - 2 * margin });

  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  txt(doc, 'Pneusistemma  ·  resumo', W - margin - 120, H - 12, { width: 120, align: 'right' });
}

function itensRelevantes(lista, limite = 8) {
  return [...(lista || [])]
    .sort((a, b) => {
      const sa = a.sulco == null ? 999 : Number(a.sulco);
      const sb = b.sulco == null ? 999 : Number(b.sulco);
      return sa - sb;
    })
    .slice(0, limite);
}

export function desenharRelatorioVisual(doc, dados) {
  const veiculos = (dados.frota || []).filter((v) => v.pneus?.length);
  const grupos = chunk(veiculos, 6);
  const totalFrota = Math.max(grupos.length, 1);

  desenharPaginaResumo(doc, dados);

  if (!grupos.length) {
    novaPagina(doc);
    desenharPaginaFrota(doc, dados, [], [], 1, 1);
  } else {
    grupos.forEach((grupo, i) => {
      novaPagina(doc);
      desenharPaginaFrota(doc, dados, grupo, grupo.map(logDoCaminhao), i + 1, totalFrota);
    });
  }

  desenharDecisao(doc, dados);
  desenharEvolucaoDesgaste(doc, dados);

  const recap = itensRelevantes(dados.em_recapagem);
  const descarte = itensRelevantes(dados.descarte);
  const historico = (dados.historico || []).slice(0, 8);
  const temOps = (dados.em_recapagem || []).length || (dados.descarte || []).length || historico.length;
  if (!temOps) return;

  const sub = `${dados.filtro_label || 'Todos'}  ·  resumo e itens relevantes da semana`;
  novaPagina(doc);
  let y = abrirPagina(doc, 'Recapagem, descarte e movimentos', sub);
  const ctxBase = { pageTitle: 'Recapagem, descarte e movimentos', pageSub: sub };
  const nRecap = (dados.em_recapagem || []).length;
  const nDesc = (dados.descarte || []).length;

  if (nRecap) {
    y = desenharTabela(doc, {
      ...ctxBase,
      y,
      section: nRecap > recap.length ? `Recapagem — ${recap.length} de ${nRecap} (menor sulco)` : `Recapagem (${nRecap})`,
      columns: [
        { key: 'fogo', label: 'Fogo', w: 0.16, bold: true },
        { key: 'peca', label: 'Pneu', w: 0.34 },
        { key: 'vida', label: 'Vida', w: 0.16 },
        { key: 'sulco', label: 'Sulco', w: 0.14, bold: true },
        { key: 'origem', label: 'Origem', w: 0.20 },
      ],
      rows: recap.map((p) => ({
        fogo: p.fogo || '-',
        peca: [p.marca, p.modelo].filter(Boolean).join(' ') || '-',
        vida: p.vida || '-',
        sulco: p.sulco != null ? `${p.sulco} mm` : '-',
        origem: p.placa_origem || '-',
      })),
    });
  }

  if (historico.length) {
    y = desenharTabela(doc, {
      ...ctxBase,
      y,
      section: (dados.historico || []).length > historico.length
        ? `Movimentos da semana — ${historico.length} de ${(dados.historico || []).length}`
        : `Movimentos da semana (${historico.length})`,
      columns: [
        { key: 'data', label: 'Data', w: 0.12 },
        { key: 'tipo', label: 'Movimento', w: 0.22, bold: true },
        { key: 'fogo', label: 'Fogo', w: 0.16 },
        { key: 'placa', label: 'Placa', w: 0.16 },
        { key: 'posicao', label: 'Posicao', w: 0.12 },
        { key: 'detalhe', label: 'Detalhe', w: 0.22 },
      ],
      rows: historico.map((h) => ({
        data: h.data ? String(h.data).slice(0, 10).split('-').reverse().join('/') : '-',
        tipo: h.tipo_label || h.tipo || '-',
        fogo: h.fogo || '-',
        placa: h.placa || '-',
        posicao: h.posicao || '-',
        detalhe: String(h.detalhes || '-').replace(/\s+/g, ' '),
      })),
    });
  }

  if (nDesc) {
    desenharTabela(doc, {
      ...ctxBase,
      y,
      section: nDesc > descarte.length ? `Descarte — ${descarte.length} de ${nDesc}` : `Descarte (${nDesc})`,
      columns: [
        { key: 'fogo', label: 'Fogo', w: 0.16, bold: true },
        { key: 'peca', label: 'Pneu', w: 0.34 },
        { key: 'trat', label: 'Tratamento', w: 0.24 },
        { key: 'obs', label: 'Obs', w: 0.26 },
      ],
      rows: descarte.map((p) => ({
        fogo: p.fogo || '-',
        peca: [p.marca, p.modelo].filter(Boolean).join(' ') || '-',
        trat: p.tratamento || '-',
        obs: p.obs || '-',
      })),
    });
  }
}
