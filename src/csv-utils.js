/**
 * Utilitários CSV (separador ; ou ,) para importação de frota.
 */

export function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { headers: [], rows: [] };

  const firstLine = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  const sep = firstLine.includes(';') && !firstLine.split(';')[0].includes(',')
    ? ';'
    : (firstLine.includes(';') && firstLine.indexOf(';') < (firstLine.indexOf(',') === -1 ? 999 : firstLine.indexOf(','))
      ? ';'
      : ',');

  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if ((ch === '\n' || (ch === '\r' && next === '\n')) && !inQuotes) {
      if (ch === '\r') i++;
      lines.push(current);
      current = '';
      continue;
    }
    if (ch === '\r' && !inQuotes) {
      lines.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length) lines.push(current);

  const splitLine = (line) => {
    const cells = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"') {
        if (q && next === '"') {
          cell += '"';
          i++;
        } else q = !q;
        continue;
      }
      if (ch === sep && !q) {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  };

  const usable = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!usable.length) return { headers: [], rows: [], separator: sep };

  const headers = splitLine(usable[0]).map((h) => normalizeHeader(h));
  const rows = usable.slice(1).map((line, idx) => {
    const cells = splitLine(line);
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
    compactador: 'compactador',
    utilitario_4: 'utilitario_4',
    utilitario: 'utilitario_4',
    varredeira: 'utilitario_4',
    trator_4: 'trator_4',
    trator: 'trator_4',
  };
  if (v && aliases[v]) return aliases[v];
  if (v && aliases[v.replace(/\s+/g, '')]) return aliases[v.replace(/\s+/g, '')];

  const t = String(tipo || '').toLowerCase();
  if (t.includes('trator')) return 'trator_4';
  if (t.includes('compactador')) return 'compactador';
  if (t.includes('utilit') || t.includes('varred')) return 'utilitario_4';
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

