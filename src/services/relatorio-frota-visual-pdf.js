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

function txt(doc, str, x, y, opts = {}) {
  if (y > doc.page.height) return;
  const savedY = doc.y;
  const savedB = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.text(String(str ?? ''), x, y, { lineBreak: false, ...opts });
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

  const placa = veiculo.placa || veiculo.apelido || '-';
  const quando = veiculo.ultima_medicao
    ? String(veiculo.ultima_medicao).slice(0, 10).split('-').reverse().join('/')
    : 'Sem medicao';
  const sulco = veiculo.menor_sulco != null ? `${veiculo.menor_sulco} mm` : '-';
  const status = labelStatus(veiculo.status_sulco || veiculo.status_label);

  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(10);
  txt(doc, placa, x + 8, y + h - footer + 3);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(6.5);
  txt(doc, quando, x + 8, y + h - footer + 15);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(8);
  txt(doc, sulco, x + 8, y + h - 12);
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
  cabecalho(
    doc,
    W,
    primeira
      ? 'Frota visual: caminhoes lado a lado + quando mediu'
      : 'Frota visual — proximos caminhoes',
    `${filial}${periodo ? `  ·  Semana ${periodo}` : ''}  ·  cores = sulco  ·  uma data por caminhao`,
  );

  let y = 40 * MM;
  if (primeira) {
    const r = dados.resumo || {};
    const kpis = [
      [r.veiculos ?? veiculos.length, 'Veiculos', C.verde],
      [r.sulco_ok ?? 0, 'OK', C.ok],
      [r.sulco_monitorar ?? 0, 'Monitorar', C.alerta],
      [r.sulco_critico ?? 0, 'Critico / acao', C.critico],
      [r.acao_trocar ?? 0, 'Acao necessaria', C.critico],
    ];
    const kw = (W - 2 * margin - 16) / 5;
    kpis.forEach((k, i) => {
      drawKpi(doc, margin + i * (kw + 4), y, kw, 18 * MM, k[0], k[1], k[2]);
    });
    y += 22 * MM;
    const uso = r.indicadores_uso || {};
    const km = uso.km || {};
    const horas = uso.horas || {};
    const mediaTxt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));
    doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
    txt(
      doc,
      `KM: media ${mediaTxt(km.media)} (${km.veiculos || 0} veiculos, OK ${km.ok || 0} · Monitorar ${km.monitorar || 0} · Critico ${km.critico || 0})`
      + `   |   HORAS: media ${mediaTxt(horas.media)} (${horas.veiculos || 0} veiculos, OK ${horas.ok || 0} · Monitorar ${horas.monitorar || 0} · Critico ${horas.critico || 0})`,
      margin,
      y,
      { width: W - 2 * margin },
    );
    y += 8 * MM;
  }

  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11);
  txt(doc, primeira ? 'Caminhoes da unidade' : 'Mais caminhoes', margin, y);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  txt(doc, 'Vermelho = acao agora  ·  log = data da ultima medicao', margin + 52 * MM, y);

  y += 6 * MM;
  const cw = 62 * MM;
  const ch = 72 * MM;
  const gap = 5 * MM;
  const areaW = 3 * (cw + gap);
  const n = Math.min(veiculos.length, 3);
  const startX = n > 0
    ? margin + (areaW - n * cw - Math.max(0, n - 1) * gap) / 2
    : margin;

  if (!veiculos.length) {
    rrect(doc, margin, y, areaW - gap, ch, 8, C.card, C.linha);
    doc.fillColor(C.mudo).font('Helvetica').fontSize(9);
    txt(doc, 'Nenhum veiculo com pneu montado nesta unidade.', margin, y + ch / 2 - 6, {
      width: areaW - gap, align: 'center',
    });
  } else {
    veiculos.slice(0, 3).forEach((v, i) => {
      drawCardCaminhao(doc, startX + i * (cw + gap), y, cw, ch, v);
    });
  }

  const lx = margin + 3 * (cw + gap);
  const lw = W - margin - lx;
  rrect(doc, lx, y, lw, ch, 8, C.card, C.linha);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(10);
  txt(doc, 'Quando mediu', lx + 8, y + 8);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  txt(doc, 'Uma data por caminhao desta pagina', lx + 8, y + 22);

  const linhas = (logs || []).slice(0, 3);
  let yy = y + 38;
  if (!linhas.length) {
    doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
    txt(doc, 'Sem medicao nestes caminhoes.', lx + 8, yy);
  } else {
    linhas.forEach((ln) => {
      drawLogLinha(doc, lx + 6, yy, lw - 12, ln);
      yy += 32;
    });
  }

  if (primeira) {
    const fy = H - 42 * MM;
    rrect(doc, margin, fy, W - 2 * margin, 28 * MM, 8, C.card, C.linha);
    doc.fillColor(C.verde).font('Helvetica-Bold').fontSize(9);
    txt(doc, 'Como decidir neste relatorio', margin + 8, fy + 6);
    doc.fillColor(C.texto).font('Helvetica').fontSize(8);
    txt(doc, '1. Vermelho na grade = troca/recap agora.', margin + 8, fy + 18);
    txt(doc, '2. O log a direita mostra a data da ultima medicao de cada caminhao.', margin + 8, fy + 30);
    txt(doc, '3. Proxima pagina: acoes a executar e diagnosticos de desgaste.', margin + 8, fy + 42);
  }

  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  txt(doc, `Pneusistemma  ·  ${pagina}/${totalPaginas}`, W - margin - 120, H - 12, {
    width: 120, align: 'right',
  });
}

function drawItemDecisao(doc, x, y, w, h, item, tipo) {
  const titulo = tipo === 'acao'
    ? (item.acao || item.acao_label || item.status_label || '-')
    : (item.diagnostico || item.diagnostico_label || '-');
  const fundo = bgStatus(item.status_sulco || item.status_label || item.acao);
  const cor = fillStatus(item.status_sulco || item.status_label || item.acao);
  rrect(doc, x, y, w, h, 5, fundo, null);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(9);
  txt(doc, item.placa || item.apelido || '-', x + 8, y + 6);
  doc.fontSize(8);
  txt(doc, item.menor_sulco != null ? `${item.menor_sulco} mm` : '-', x + 8, y + 6, {
    width: w - 16, align: 'right',
  });
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7.5);
  txt(doc, item.posicao || '-', x + 8, y + 18);
  doc.fillColor(cor).font('Helvetica-Bold').fontSize(8);
  txt(doc, String(titulo).slice(0, 28), x + 8, y + 18, { width: w - 16, align: 'right' });
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  const motivo = String(item.motivo || item.diagnostico_desc || item.diagnostico || '').slice(0, 90);
  txt(doc, motivo, x + 8, y + 34, { width: w - 16 });
}

const ACOES_POR_PAGINA = 5;

function listarAcoesRelatorio(dados) {
  return unicosPorPosicao([
    ...(dados.prioridades?.troca || []),
    ...(dados.prioridades?.monitorar || []),
    ...(dados.prioridades?.rodizio || []),
  ]);
}

function listarDiagnosticosRelatorio(dados) {
  return unicosPorPosicao(dados.diagnosticos || []);
}

/**
 * Uma página de ações + diagnósticos (5 por coluna). Quem chama pagina o restante.
 */
export function desenharPaginaAcoes(doc, dados, loteAcoes, loteDiags, totalAcoes, totalDiags, indice = 0, totalLotes = 1) {
  const W = doc.page.width;
  const H = doc.page.height;
  const margin = 12 * MM;
  doc.rect(0, 0, W, H).fill(C.fundo);
  const pagTxt = totalLotes > 1 ? `  ·  ${indice + 1}/${totalLotes}` : '';
  cabecalho(
    doc,
    W,
    `Acoes e diagnosticos — lista completa${pagTxt}`,
    'Todas as acoes e todos os diagnosticos da unidade  ·  5 por pagina',
  );

  const y0 = 40 * MM;
  const colW = (W - 2 * margin - 6 * MM) / 2;
  const gap = 6 * MM;
  const boxH = H - y0 - 16 * MM;

  rrect(doc, margin, y0, colW, boxH, 8, C.card, C.linha);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(12);
  txt(doc, 'Acoes', margin + 10, y0 + 10);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  txt(doc, `${totalAcoes} pendentes`, margin + 10, y0 + 10, { width: colW - 20, align: 'right' });
  doc.fontSize(7.5);
  txt(doc, 'Trocar, recapar, mudar posicao ou acompanhar', margin + 10, y0 + 26);

  const ih = 22 * MM;
  let yy = y0 + 42;
  if (!loteAcoes.length) {
    doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
    txt(doc, totalAcoes ? 'Continuacao nas outras paginas.' : 'Nenhuma acao pendente.', margin + 10, yy);
  } else {
    loteAcoes.forEach((a) => {
      drawItemDecisao(doc, margin + 8, yy, colW - 16, ih, a, 'acao');
      yy += ih + 3 * MM;
    });
  }

  const dx = margin + colW + gap;
  rrect(doc, dx, y0, colW, boxH, 8, C.card, C.linha);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(12);
  txt(doc, 'Diagnosticos', dx + 10, y0 + 10);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  txt(doc, `${totalDiags} irregularidades`, dx + 10, y0 + 10, { width: colW - 20, align: 'right' });
  doc.fontSize(7.5);
  txt(doc, 'Causa do desgaste: calibragem, perfil ou critico', dx + 10, y0 + 26);

  yy = y0 + 42;
  if (!loteDiags.length) {
    doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
    txt(doc, totalDiags ? 'Continuacao nas outras paginas.' : 'Nenhum diagnostico irregular.', dx + 10, yy);
  } else {
    loteDiags.forEach((d) => {
      drawItemDecisao(doc, dx + 8, yy, colW - 16, ih, d, 'diag');
      yy += ih + 3 * MM;
    });
  }

  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  txt(doc, 'Pneusistemma  ·  acoes e diagnosticos', W - margin - 180, H - 12, {
    width: 180, align: 'right',
  });
}

function temOperacaoExtra(dados) {
  const r = dados.resumo || {};
  return Boolean(
    (r.pneus_estoque || dados.estoque_resumo?.total || (dados.estoque || []).length)
    || (r.pneus_em_recapagem || (dados.em_recapagem || []).length)
    || (dados.historico || []).length
    || (r.pneus_descarte || (dados.descarte || []).length)
  );
}

function drawLinhaOp(doc, x, y, w, cols) {
  let cx = x;
  cols.forEach((col) => {
    doc.fillColor(col.cor || C.texto).font(col.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    txt(doc, col.txt, cx, y, { width: col.w, align: col.align || 'left' });
    cx += col.w;
  });
}

const MAX_LINHAS_LISTA = 8;

function drawBlocoLista(doc, x, y, w, titulo, hint, linhas, colunas) {
  const todas = linhas || [];
  const visiveis = todas.slice(0, MAX_LINHAS_LISTA);
  const extra = Math.max(0, todas.length - visiveis.length);
  const hintFinal = extra ? `${hint}  ·  +${extra} omitidos` : hint;
  const h = 22 + visiveis.length * 16 + 12;
  rrect(doc, x, y, w, h, 8, C.card, C.linha);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11);
  txt(doc, titulo, x + 10, y + 8);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7.5);
  txt(doc, hintFinal, x + 10, y + 8, { width: w - 20, align: 'right' });
  let yy = y + 26;
  visiveis.forEach((ln, i) => {
    if (yy + 16 > doc.page.height - 16) return;
    if (i % 2 === 0) rrect(doc, x + 6, yy - 2, w - 12, 15, 3, '#f8faf8', null);
    drawLinhaOp(doc, x + 10, yy, w - 20, colunas(ln));
    yy += 16;
  });
  return h + 8;
}

function moneyBr(v) {
  if (v == null || Number.isNaN(Number(v))) return '-';
  return `R$ ${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
}

function drawResumoEstoque(doc, x, y, w, dados) {
  const r = dados.estoque_resumo || {};
  const n = Number(dados.resumo?.pneus_estoque ?? r.total ?? 0);
  if (!n) return 0;
  const padroes = Object.entries(r.por_padrao || {})
    .sort((a, b) => b[1] - a[1])
    .map(([nome, qtd]) => `${nome}: ${qtd}`)
    .join('  |  ');
  const h = 58;
  rrect(doc, x, y, w, h, 8, C.card, C.linha);
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(11);
  txt(doc, 'Estoque — resumo (lista completa na aba Pneus)', x + 10, y + 8);
  doc.fillColor(C.mudo).font('Helvetica').fontSize(7.5);
  txt(doc, `${n} pneu(s) parados`, x + 10, y + 8, { width: w - 20, align: 'right' });
  doc.fillColor(C.texto).font('Helvetica').fontSize(8.5);
  txt(
    doc,
    `${n} no estoque  ·  ${r.novos ?? 0} novos  ·  ${r.recapados ?? 0} recapados  ·  custo ${moneyBr(dados.resumo?.custo_estoque)}`,
    x + 10,
    y + 26,
    { width: w - 20 },
  );
  doc.fillColor(C.mudo).font('Helvetica').fontSize(8);
  const sulcoLinha = `${r.criticos ?? 0} sulco critico  ·  ${r.alerta ?? 0} em alerta  ·  ${r.sem_medicao ?? 0} sem medicao`;
  txt(doc, padroes ? `${sulcoLinha}  ·  ${padroes}` : sulcoLinha, x + 10, y + 42, { width: w - 20 });
  return h + 8;
}

/**
 * Só o que ainda não entrou nas páginas visuais: estoque, recap, movimentação, descarte.
 * Medições, ações e diagnósticos ficam de fora — já foram enviados acima.
 */
export function desenharPaginaOperacao(doc, dados) {
  if (!temOperacaoExtra(dados)) return false;
  const W = doc.page.width;
  const H = doc.page.height;
  const margin = 12 * MM;
  doc.rect(0, 0, W, H).fill(C.fundo);
  cabecalho(
    doc,
    W,
    'Operacao da semana — o que ainda nao apareceu',
    'Estoque em resumo (sem listar milhares de pneus), recap, movimentacao e descarte.',
  );

  let y = 40 * MM;
  const full = W - 2 * margin;

  if ((dados.em_recapagem || []).length) {
    const nRecap = dados.resumo?.pneus_em_recapagem || dados.em_recapagem.length;
    y += drawBlocoLista(doc, margin, y, full, 'Em recapagem', `${nRecap} pneu(s)`, dados.em_recapagem, (p) => [
      { txt: p.fogo || '-', w: 90, bold: true },
      { txt: [p.marca, p.modelo].filter(Boolean).join(' ') || '-', w: 180 },
      { txt: p.vida || '-', w: 80 },
      { txt: p.sulco != null ? `${p.sulco} mm` : '-', w: 70, bold: true },
      { txt: p.placa_origem || '-', w: 90 },
    ]);
  }

  y += drawResumoEstoque(doc, margin, y, full, dados);
  if ((dados.estoque || []).length) {
    const nEstoque = dados.resumo?.pneus_estoque || dados.estoque_resumo?.total || dados.estoque.length;
    y += drawBlocoLista(
      doc,
      margin,
      y,
      full,
      'Menor sulco no estoque — prioridade de montagem',
      `${dados.estoque.length} de ${nEstoque}`,
      dados.estoque,
      (p) => [
        { txt: p.fogo || '-', w: 90, bold: true },
        { txt: [p.marca, p.modelo, p.medida].filter(Boolean).join(' ') || '-', w: 200 },
        { txt: p.padrao || '-', w: 90 },
        { txt: p.vida || '-', w: 70 },
        { txt: p.sulco != null ? `${p.sulco} mm` : '-', w: 70, bold: true },
      ],
    );
  }

  if ((dados.historico || []).length && y < H - 80) {
    y += drawBlocoLista(doc, margin, y, full, 'Movimentacoes da semana', `${dados.historico.length} evento(s)`, dados.historico.slice(0, 12), (h) => [
      { txt: h.data ? String(h.data).slice(0, 10).split('-').reverse().join('/') : '-', w: 70 },
      { txt: h.tipo_label || h.tipo || '-', w: 110, bold: true },
      { txt: h.fogo || '-', w: 80 },
      { txt: h.placa || '-', w: 80 },
      { txt: h.posicao || '-', w: 50 },
      { txt: String(h.detalhes || '-').slice(0, 40), w: 220, cor: C.mudo },
    ]);
  }

  if ((dados.descarte || []).length && y < H - 80) {
    const nDesc = dados.resumo?.pneus_descarte || dados.descarte.length;
    y += drawBlocoLista(doc, margin, y, full, 'Descarte', `${nDesc} pneu(s)`, dados.descarte, (p) => [
      { txt: p.fogo || '-', w: 90, bold: true },
      { txt: [p.marca, p.modelo].filter(Boolean).join(' ') || '-', w: 180 },
      { txt: p.tratamento || '-', w: 160 },
      { txt: p.obs || '-', w: 180, cor: C.mudo },
    ]);
  }

  doc.fillColor(C.mudo).font('Helvetica').fontSize(7);
  txt(doc, 'Pneusistemma  ·  operacao da semana', W - margin - 180, H - 12, {
    width: 180, align: 'right',
  });
  return true;
}

export function desenharRelatorioVisual(doc, dados) {
  const veiculos = (dados.frota || []).filter((v) => v.pneus?.length);
  const grupos = chunk(veiculos, 3);
  const acoes = listarAcoesRelatorio(dados);
  const diags = listarDiagnosticosRelatorio(dados);
  const acoesPag = chunk(acoes, ACOES_POR_PAGINA);
  const diagsPag = chunk(diags, ACOES_POR_PAGINA);
  const nAcoesPag = Math.max(acoesPag.length, diagsPag.length, 1);
  const extraOp = temOperacaoExtra(dados) ? 1 : 0;
  const total = grupos.length + nAcoesPag + extraOp;
  const novaPagina = () => {
    doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  };

  grupos.forEach((grupo, i) => {
    if (i > 0) novaPagina();
    desenharPaginaFrota(doc, dados, grupo, grupo.map(logDoCaminhao), i + 1, total);
  });
  for (let i = 0; i < nAcoesPag; i += 1) {
    novaPagina();
    desenharPaginaAcoes(
      doc,
      dados,
      acoesPag[i] || [],
      diagsPag[i] || [],
      acoes.length,
      diags.length,
      i,
      nAcoesPag,
    );
  }
  if (temOperacaoExtra(dados)) {
    novaPagina();
    desenharPaginaOperacao(doc, dados);
  }
}
