/**
 * Páginas visuais do relatório.
 * O diagrama de cada veículo usa o layout do catálogo (layout_pneus).
 * Layout personalizado, vazio ou desconhecido desenha só os pneus montados.
 */
import { LAYOUTS_PNEU, ordenarPosicoes } from '../pneus-layouts.js';
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

const PNEU_H = 16;
const GAP_X = 3;
const GAP_Y = 4;

/**
 * Eixo e lado a partir do código, sem trocar um eixo simples por duplo.
 * ordem 0 = externo; ordem 1 = interno.
 */
function classificarPosicao(codigo) {
  const c = String(codigo || '').trim().toUpperCase();
  if (!c) return null;
  if (c === 'ESTEPE') return { eixo: 90, lado: 'C', ordem: 0 };
  if (c === 'D') return { eixo: 1, lado: 'C', ordem: 0 };
  if (c === 'T') return { eixo: 2, lado: 'C', ordem: 0 };
  const legado = {
    DE: { eixo: 1, lado: 'E', ordem: 0 },
    DD: { eixo: 1, lado: 'D', ordem: 0 },
    TE: { eixo: 2, lado: 'E', ordem: 0 },
    TD: { eixo: 2, lado: 'D', ordem: 0 },
    TEE: { eixo: 2, lado: 'E', ordem: 0 },
    TEI: { eixo: 2, lado: 'E', ordem: 1 },
    TDI: { eixo: 2, lado: 'D', ordem: 1 },
    TDE: { eixo: 2, lado: 'D', ordem: 0 },
  };
  if (legado[c]) return legado[c];
  const m = c.match(/^(?:E|S|G)?(\d)(EE|EI|DE|DI|E|D)$/);
  if (!m) return null;
  const sufixo = {
    EE: { lado: 'E', ordem: 0 },
    EI: { lado: 'E', ordem: 1 },
    E: { lado: 'E', ordem: 0 },
    DI: { lado: 'D', ordem: 1 },
    DE: { lado: 'D', ordem: 0 },
    D: { lado: 'D', ordem: 0 },
  }[m[2]];
  if (!sufixo) return null;
  return { eixo: Number(m[1]), ...sufixo };
}

/**
 * Posições do diagrama: catálogo do layout, ou só pneus montados.
 */
export function posicoesDiagramaVeiculo(veiculo = {}) {
  const id = String(veiculo.layout || veiculo.layout_pneus || '').trim();
  const catalogo = LAYOUTS_PNEU[id];
  if (catalogo?.posicoes?.length) return [...catalogo.posicoes];

  const vistos = new Set();
  const montadas = [];
  for (const pneu of veiculo.pneus || []) {
    const codigo = String(pneu.posicao || '').trim().toUpperCase();
    if (!codigo || vistos.has(codigo)) continue;
    vistos.add(codigo);
    montadas.push(codigo);
  }
  return ordenarPosicoes(montadas);
}

function larguraPneu(codigos) {
  const maior = codigos.reduce((acc, codigo) => Math.max(acc, String(codigo).length), 1);
  return Math.min(28, Math.max(16, maior * 3.15 + 3));
}

/**
 * Caixas do diagrama em pontos lógicos, já ajustadas à área do card.
 * Não inclui posição que não esteja na lista recebida.
 */
export function geometriaDiagrama(posicoes, areaW, areaH) {
  const lista = [];
  const vistos = new Set();
  for (const codigo of posicoes || []) {
    const c = String(codigo || '').trim().toUpperCase();
    if (!c || vistos.has(c)) continue;
    vistos.add(c);
    lista.push(c);
  }
  if (!lista.length || !(areaW > 0) || !(areaH > 0)) {
    return { slots: [], minX: 0, minY: 0, w: 0, h: 0, scale: 1 };
  }

  const conhecidas = [];
  const desconhecidas = [];
  for (const codigo of lista) {
    const info = classificarPosicao(codigo);
    if (!info) desconhecidas.push(codigo);
    else conhecidas.push({ codigo, ...info });
  }

  const eixos = [...new Set(conhecidas.map((p) => p.eixo))].sort((a, b) => a - b);
  let maxE = 0;
  let maxD = 0;
  for (const eixo of eixos) {
    const doEixo = conhecidas.filter((p) => p.eixo === eixo);
    maxE = Math.max(maxE, doEixo.filter((p) => p.lado === 'E').length);
    maxD = Math.max(maxD, doEixo.filter((p) => p.lado === 'D').length);
  }
  const colunas = Math.max(1, maxE + maxD);

  function indiceX(item, nLado) {
    if (item.lado === 'C') return (colunas - 1) / 2;
    if (item.lado === 'E') {
      if (nLado <= 1 && maxE > 1) return (maxE - 1) / 2;
      if (nLado <= 1) return 0;
      return item.ordem === 0 ? 0 : Math.min(item.ordem, maxE - 1);
    }
    const base = maxE;
    if (nLado <= 1 && maxD > 1) return base + (maxD - 1) / 2;
    if (nLado <= 1) return base;
    if (item.ordem === 0) return base + maxD - 1;
    return base + Math.max(0, maxD - 1 - item.ordem);
  }

  const grades = [];
  for (const eixo of eixos) {
    const doEixo = conhecidas.filter((p) => p.eixo === eixo);
    const nE = doEixo.filter((p) => p.lado === 'E').length;
    const nD = doEixo.filter((p) => p.lado === 'D').length;
    const row = eixos.indexOf(eixo);
    for (const item of doEixo) {
      const nLado = item.lado === 'E' ? nE : item.lado === 'D' ? nD : 1;
      grades.push({ codigo: item.codigo, col: indiceX(item, nLado), row });
    }
  }
  desconhecidas.forEach((codigo, i) => {
    grades.push({
      codigo,
      col: i % 2,
      row: eixos.length + Math.floor(i / 2),
    });
  });

  const tw = larguraPneu(grades.map((g) => g.codigo));
  const th = PNEU_H;
  const placed = grades.map((g) => ({
    codigo: g.codigo,
    x: g.col * (tw + GAP_X),
    y: g.row * (th + GAP_Y),
    w: tw,
    h: th,
  }));
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  const maxX = Math.max(...placed.map((p) => p.x + p.w));
  const maxY = Math.max(...placed.map((p) => p.y + p.h));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const scale = Math.min(areaW / bw, areaH / bh, 1.35);
  return { slots: placed, minX, minY, w: bw, h: bh, scale };
}

/** vazio | sem_medicao | medido. Zero milímetro continua medido. */
export function rotuloSulcoSlot(pneu) {
  if (!pneu) return { tipo: 'vazio', mm: null };
  if (pneu.menor_sulco == null || pneu.menor_sulco === '') return { tipo: 'sem_medicao', mm: null };
  const mm = Number(pneu.menor_sulco);
  return { tipo: 'medido', mm: Number.isFinite(mm) ? mm : null };
}

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

function pneusPorPos(pneus = []) {
  const map = new Map();
  for (const p of pneus) {
    const codigo = String(p.posicao || '').trim().toUpperCase();
    if (codigo) map.set(codigo, p);
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

function fonteQueCabe(doc, texto, largura, inicio) {
  let size = inicio;
  doc.font('Helvetica-Bold').fontSize(size);
  while (size > 3.2 && doc.widthOfString(texto) > largura - 1.2) {
    size = Math.round((size - 0.2) * 10) / 10;
    doc.fontSize(size);
  }
  return size;
}

function drawPneu(doc, x, y, w, h, aparencia, label) {
  rrect(doc, x, y, w, h, 3, aparencia.fill, aparencia.stroke);
  const rotulo = String(label);
  const tamRotulo = fonteQueCabe(doc, rotulo, w, Math.min(6, h * 0.34));
  doc.fillColor(aparencia.texto).font('Helvetica-Bold').fontSize(tamRotulo);
  const yRotulo = aparencia.mm == null ? y + (h - tamRotulo) / 2 - 0.4 : y + h * 0.16;
  txt(doc, rotulo, x, yRotulo, { width: w, align: 'center' });
  if (aparencia.mm != null) {
    const mmTxt = String(aparencia.mm);
    const tamMm = fonteQueCabe(doc, mmTxt, w, Math.min(5.5, h * 0.3));
    doc.fillColor(aparencia.texto).font('Helvetica-Bold').fontSize(tamMm);
    txt(doc, mmTxt, x, y + h * 0.52, { width: w, align: 'center' });
  }
}

function aparenciaSlot(pneu) {
  const rotulo = rotuloSulcoSlot(pneu);
  if (rotulo.tipo === 'vazio') {
    return { fill: '#f1f5f9', stroke: '#94a3b8', texto: '#475569', mm: null };
  }
  if (rotulo.tipo === 'sem_medicao') {
    return { fill: C.cinza, stroke: null, texto: C.branco, mm: '-' };
  }
  const cor = fillStatus(pneu.status_sulco || pneu.status_label);
  return {
    fill: cor,
    stroke: cor === C.ok ? '#14532d' : null,
    texto: C.branco,
    mm: String(rotulo.mm),
  };
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
  const areaH = Math.max(8, areaBot - areaTop);
  const pad = 5;
  const geo = geometriaDiagrama(
    posicoesDiagramaVeiculo(veiculo),
    Math.max(20, w - 16 - pad * 2),
    Math.max(12, areaH - pad * 2),
  );
  if (!geo.slots.length) return;

  const scale = geo.scale;
  const boxW = geo.w * scale;
  const boxH = geo.h * scale;
  const ox = x + (w - boxW) / 2 - geo.minX * scale;
  const oy = areaTop + (areaH - boxH) / 2 - geo.minY * scale;

  doc.lineWidth(1.1).strokeColor(C.chassis)
    .roundedRect(
      ox + geo.minX * scale - pad,
      oy + geo.minY * scale - pad,
      boxW + pad * 2,
      boxH + pad * 2,
      8,
    ).stroke();

  const byPos = pneusPorPos(veiculo.pneus);
  for (const slot of geo.slots) {
    const pneu = byPos.get(slot.codigo);
    drawPneu(
      doc,
      ox + slot.x * scale,
      oy + slot.y * scale,
      slot.w * scale,
      slot.h * scale,
      aparenciaSlot(pneu),
      slot.codigo,
    );
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
  txt(doc, 'Proxima pagina: tabela da frota cadastrada, inclusive sem pneu montado. Depois, o diagrama de quem tem pneu.', margin, y, { width: W - 2 * margin });

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

/** Diagrama só quando há pneu montado para desenhar. A tabela lista a frota inteira. */
export function veiculosComDiagrama(frota) {
  return (frota || []).filter((v) => (v.pneus || []).length > 0);
}

export function linhasTabelaFrota(frota) {
  return (frota || []).map((v) => {
    const n = (v.pneus || []).length;
    return {
      placa: v.placa || '-',
      apelido: v.apelido || '-',
      tipo: v.tipo || '-',
      pneus: String(n),
      sulco: v.menor_sulco != null ? `${v.menor_sulco} mm` : '-',
      status: n ? (v.status_label || '-') : 'Sem pneu montado',
    };
  });
}

function desenharTabelaFrota(doc, dados) {
  const frota = dados.frota || [];
  const sub = `${dados.filtro_label || 'Todos'}  ·  ${frota.length} veiculo(s), inclusive sem pneu montado`;
  novaPagina(doc);
  const y = abrirPagina(doc, 'Frota cadastrada', sub);
  desenharTabela(doc, {
    pageTitle: 'Frota cadastrada',
    pageSub: sub,
    y,
    section: `Frota cadastrada (${frota.length})`,
    empty: 'Nenhum veiculo nesta selecao.',
    columns: [
      { key: 'placa', label: 'Placa', w: 0.16, bold: true },
      { key: 'apelido', label: 'Apelido', w: 0.18 },
      { key: 'tipo', label: 'Tipo', w: 0.24 },
      { key: 'pneus', label: 'Montados', w: 0.12 },
      { key: 'sulco', label: 'Menor sulco', w: 0.14 },
      { key: 'status', label: 'Status', w: 0.16 },
    ],
    rows: linhasTabelaFrota(frota),
  });
}

export function desenharRelatorioVisual(doc, dados) {
  const veiculos = veiculosComDiagrama(dados.frota);
  const grupos = chunk(veiculos, 6);
  const totalFrota = Math.max(grupos.length, 1);

  desenharPaginaResumo(doc, dados);
  desenharTabelaFrota(doc, dados);

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
