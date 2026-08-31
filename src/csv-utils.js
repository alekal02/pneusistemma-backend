/**
 * Utilitários CSV (separador ; ou ,) para importação de frota.
 */

const HEADER_ALIASES = {
  n_de_fogo: 'numero_fogo',
  n_fogo: 'numero_fogo',
  nr_fogo: 'numero_fogo',
  no_de_fogo: 'numero_fogo',
  no_fogo: 'numero_fogo',
  fogo: 'numero_fogo',
  padrao: 'tipo_pneu',
  tipo_do_pneu: 'tipo_pneu',
  tipo_do_veiculo: 'tipo_veiculo',
};

function detectSeparator(text) {
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') break;
    if (ch === ',') commas += 1;
    if (ch === ';') semis += 1;
  }
  return semis >= commas ? ';' : ',';
}

function parseCsvRows(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell.trim());
    cell = '';
  };
  const pushRow = () => {
    if (row.some((c) => String(c || '').trim())) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === sep) {
      pushCell();
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && next === '\n') i += 1;
      pushCell();
      pushRow();
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    pushCell();
    pushRow();
  }
  return rows;
}

export function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { headers: [], rows: [] };

  const start = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  const sep = detectSeparator(start);
  const table = parseCsvRows(raw, sep).filter((r) => {
    const first = String(r[0] || '').trim();
    return first && !first.startsWith('#');
  });
  if (!table.length) return { headers: [], rows: [], separator: sep };

  const headers = table[0].map((h) => {
    const key = normalizeHeader(h);
    return HEADER_ALIASES[key] || key;
  });
  const rows = table.slice(1).map((cells, idx) => {
    const obj = { __linha: idx + 2 };
    headers.forEach((h, i) => {
      if (!h) return;
      obj[h] = cells[i] ?? '';
    });
    return obj;
  }).filter((r) => Object.keys(r).some((k) => k !== '__linha' && String(r[k] || '').trim()));

  return { headers, rows, separator: sep };
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Aceita 16,5 · 1.850,00 · 1850.00 */
export function parseNumeroBr(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function toCsv(headers, rows, { separator = ';' } = {}) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    if (s.includes('"') || s.includes(separator) || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    headers.join(separator),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(separator)),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export const VEICULO_TEMPLATE_HEADERS = [
  'placa',
  'apelido',
  'tipo',
  'layout_pneus',
  'marca',
  'modelo',
  'ano',
  'km_atual',
  'hr_atual',
  'observacoes',
];

export const VEICULO_TEMPLATE_ROWS = [
  {
    placa: 'ABC1D23',
    apelido: 'Compactador 01',
    tipo: 'Truck / Tração',
    layout_pneus: 'truck_10',
    marca: '',
    modelo: '',
    ano: '2020',
    km_atual: '10000',
    hr_atual: '200',
    observacoes: '',
  },
  {
    placa: 'DEF2G45',
    apelido: 'Toco Oficina',
    tipo: 'Toco / Mini',
    layout_pneus: 'toco_6',
    marca: '',
    modelo: '',
    ano: '2018',
    km_atual: '5000',
    hr_atual: '100',
    observacoes: '',
  },
];

export const PNEU_TEMPLATE_HEADERS = [
  'numero_fogo',
  'tipo_pneu',
  'condicao',
  'vida_recap',
  'marca',
  'modelo',
  'medida',
  'dot',
  'sulco_inicial_mm',
  'custo',
  'nota_fiscal',
  'observacoes',
];

export const PNEU_TEMPLATE_ROWS = [
  {
    numero_fogo: 'F-1001',
    tipo_pneu: 'direcional',
    condicao: 'novo',
    vida_recap: '0',
    marca: 'Michelin',
    modelo: 'X Multi D',
    medida: '275/80R22.5',
    dot: '1224',
    sulco_inicial_mm: '16',
    custo: '1850.00',
    nota_fiscal: 'NF-12345',
    observacoes: '',
  },
  {
    numero_fogo: 'F-2002',
    tipo_pneu: 'misto',
    condicao: 'recapado',
    vida_recap: '1',
    marca: 'Goodyear',
    modelo: 'KMax',
    medida: '275/80R22.5',
    dot: '',
    sulco_inicial_mm: '14',
    custo: '920.00',
    nota_fiscal: 'NF-12346',
    observacoes: '',
  },
  {
    numero_fogo: 'F-3003',
    tipo_pneu: 'borrachudo',
    condicao: 'novo',
    vida_recap: '0',
    marca: 'Pirelli',
    modelo: 'FG01',
    medida: '275/80R22.5',
    dot: '',
    sulco_inicial_mm: '18',
    custo: '2100.00',
    nota_fiscal: 'NF-12347',
    observacoes: 'Tração',
  },
];

export function mapLayoutId(raw, tipo) {
  const v = String(raw || '').trim().toLowerCase();
  const aliases = {
    truck_10: 'truck_10',
    truck10: 'truck_10',
    '10': 'truck_10',
    '2+4+4': 'truck_10',
    truck_8: 'truck_8',
    truck8: 'truck_8',
    '8': 'truck_8',
    '2+4+2': 'truck_8',
    truck_8_b: 'truck_8_b',
    truck8b: 'truck_8_b',
    '8b': 'truck_8_b',
    '2+2+4': 'truck_8_b',
    toco_6: 'toco_6',
    toco: 'toco_6',
    mini: 'toco_6',
    '6': 'toco_6',
    truck_6x2: 'truck_8',
    '6x2': 'truck_8',
    truck6x2: 'truck_8',
    truck_6x4: 'truck_10',
    '6x4': 'truck_10',
    truck6x4: 'truck_10',
  };
  if (v && aliases[v]) return aliases[v];
  if (v && aliases[v.replace(/\s+/g, '')]) return aliases[v.replace(/\s+/g, '')];

  const t = String(tipo || '').toLowerCase();
  if (t.includes('toco') || t.includes('mini')) return 'toco_6';
  return 'truck_10';
}

export function mapTipoPneu(raw) {
  const v = String(raw || '').trim().toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (v.startsWith('dir')) return 'direcional';
  if (v.startsWith('borr') || v.includes('borracha')) return 'borrachudo';
  if (v.startsWith('mis') || v === 'tracao' || v.includes('tracao')) return 'misto';
  if (v === 'direcional' || v === 'misto' || v === 'borrachudo') return v;
  return 'misto';
}

export function mapCondicao(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v.startsWith('rec')) return 'recapado';
  return 'novo';
}

/** Planilha única: frota (veículos + pneus montados + estoque) */
export const FROTA_TEMPLATE_HEADERS = [
  'status',
  'placa',
  'apelido',
  'tipo_veiculo',
  'layout_pneus',
  'km_atual',
  'hr_atual',
  'posicao',
  'numero_fogo',
  'tipo_pneu',
  'condicao',
  'vida_recap',
  'marca',
  'modelo',
  'medida',
  'dot',
  'sulco_inicial_mm',
  'observacoes',
];

export const FROTA_TEMPLATE_ROWS = [
  {
    status: 'montado',
    placa: 'ABC1D23',
    apelido: 'Compactador 01',
    tipo_veiculo: 'Truck / Tração',
    layout_pneus: 'truck_10',
    km_atual: '10000',
    hr_atual: '200',
    posicao: '1E',
    numero_fogo: 'F-1001',
    tipo_pneu: 'direcional',
    condicao: 'novo',
    vida_recap: '0',
    marca: 'Michelin',
    modelo: 'X Multi D',
    medida: '275/80R22.5',
    dot: '1224',
    sulco_inicial_mm: '16',
    observacoes: 'Já em uso no caminhão',
  },
  {
    status: 'montado',
    placa: 'ABC1D23',
    apelido: 'Compactador 01',
    tipo_veiculo: 'Truck / Tração',
    layout_pneus: 'truck_10',
    km_atual: '10000',
    hr_atual: '200',
    posicao: '1D',
    numero_fogo: 'F-1002',
    tipo_pneu: 'direcional',
    condicao: 'novo',
    vida_recap: '0',
    marca: 'Michelin',
    modelo: 'X Multi D',
    medida: '275/80R22.5',
    dot: '1224',
    sulco_inicial_mm: '15',
    observacoes: '',
  },
  {
    status: 'montado',
    placa: 'ABC1D23',
    apelido: 'Compactador 01',
    tipo_veiculo: 'Truck / Tração',
    layout_pneus: 'truck_10',
    km_atual: '10000',
    hr_atual: '200',
    posicao: '2EE',
    numero_fogo: 'F-2001',
    tipo_pneu: 'misto',
    condicao: 'recapado',
    vida_recap: '1',
    marca: 'Goodyear',
    modelo: 'KMax',
    medida: '275/80R22.5',
    dot: '',
    sulco_inicial_mm: '14',
    observacoes: '',
  },
  {
    status: 'estoque',
    placa: '',
    apelido: '',
    tipo_veiculo: '',
    layout_pneus: '',
    km_atual: '',
    hr_atual: '',
    posicao: '',
    numero_fogo: 'F-9001',
    tipo_pneu: 'borrachudo',
    condicao: 'novo',
    vida_recap: '0',
    marca: 'Pirelli',
    modelo: 'FG01',
    medida: '275/80R22.5',
    dot: '0325',
    sulco_inicial_mm: '17',
    observacoes: 'Pneu parado no estoque',
  },
];

export function mapStatusPneu(raw, { placa, posicao } = {}) {
  const v = String(raw || '').trim().toLowerCase();
  if (v.startsWith('mont') || v === 'uso' || v === 'em_uso') return 'montado';
  if (v.startsWith('est') || v === 'parado') return 'estoque';
  if (placa && posicao) return 'montado';
  return 'estoque';
}

