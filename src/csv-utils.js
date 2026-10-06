import { codigoTipoEquipamento, layoutPadraoDoCatalogo } from './equipamento-tipos.js';

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

  const headers = splitLine(usable[0]).map((h) => aliasHeader(normalizeHeader(h)));
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

const HEADER_ALIASES = {
  n_de_fogo: 'numero_fogo',
  no_de_fogo: 'numero_fogo',
  n_fogo: 'numero_fogo',
  fogo: 'numero_fogo',
  placa_do_veiculo: 'placa',
  placa_veiculo: 'placa',
  placa_caminhao: 'placa',
  caminhao: 'placa',
  veiculo: 'placa',
  posicao_pneu: 'posicao',
  posicao_do_pneu: 'posicao',
  slot: 'posicao',
};

function aliasHeader(h) {
  return HEADER_ALIASES[h] || h;
}

export function parseNumeroBr(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    return Number(s.replace(/\./g, '').replace(',', '.'));
  }
  if (s.includes(',')) return Number(s.replace(',', '.'));
  return Number(s);
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
  'placa',
  'posicao',
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
    placa: 'ABC1D23',
    posicao: '1E',
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
    observacoes: 'Já monta no caminhão se a placa existir',
  },
  {
    numero_fogo: 'F-2002',
    placa: 'ABC1D23',
    posicao: '1D',
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
    numero_fogo: 'F-3003',
    placa: '',
    posicao: '',
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
    observacoes: 'Sem placa = estoque',
  },
];

export function mapLayoutId(raw, tipo) {
  const codigo = codigoTipoEquipamento(tipo);
  if (codigo === 'mini_carregadeira') return 'skid_4';
  if (codigo === 'giro_zero') return 'giro_4';

  const v = String(raw || '').trim().toLowerCase();
  // "mini" na coluna de layout da planilha antiga = Toco. Mini carregadeira já saiu acima.
  const aliases = {
    truck_10: 'truck_10',
    truck10: 'truck_10',
    '10': 'truck_10',
    '2+4+4': 'truck_10',
    '6x4': 'truck_10',
    truck_6x4: 'truck_10',
    truck_8: 'truck_8',
    truck8: 'truck_8',
    '8': 'truck_8',
    '2+4+2': 'truck_8',
    '6x2': 'truck_8',
    truck_6x2: 'truck_8',
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
    skid_4: 'skid_4',
    giro_4: 'giro_4',
  };
  if (v && aliases[v]) return aliases[v];
  if (v && aliases[v.replace(/\s+/g, '')]) return aliases[v.replace(/\s+/g, '')];

  return layoutPadraoDoCatalogo(tipo);
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

const POSICAO_ALIAS = {
  '2D1': '2DI',
  ES: 'ESTEPE',
  EST: 'ESTEPE',
  STEPE: 'ESTEPE',
};

/** 1D/1E (truck) ↔ DD/DE (compactador / legado). */
const POSICAO_EQUIV = {
  '1E': 'DE',
  DE: '1E',
  '1D': 'DD',
  DD: '1D',
  '2EE': 'E2EE',
  E2EE: '2EE',
  '2EI': 'E2EI',
  E2EI: '2EI',
  '2DI': 'E2DI',
  E2DI: '2DI',
  '2DE': 'E2DE',
  E2DE: '2DE',
  '3EE': 'E3EE',
  E3EE: '3EE',
  '3EI': 'E3EI',
  E3EI: '3EI',
  '3DI': 'E3DI',
  E3DI: '3DI',
  '3DE': 'E3DE',
  E3DE: '3DE',
  '2E': 'TE',
  TE: '2E',
  '2D': 'TD',
  TD: '2D',
  '3E': 'TEE',
  '3D': 'TDE',
};

export function mapPosicaoPneu(raw) {
  const v = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!v) return '';
  return POSICAO_ALIAS[v] || v;
}

export function placaDaLinha(raw) {
  return String(
    raw?.placa
    || raw?.placa_veiculo
    || raw?.placa_do_veiculo
    || raw?.veiculo
    || raw?.caminhao
    || ''
  ).trim().toUpperCase();
}

/** Encaixa a posição no layout do veículo (aceita 1E ou DE, conforme o caminhão). */
export function encaixarPosicaoNoLayout(raw, posicoesLayout = []) {
  const p = mapPosicaoPneu(raw);
  if (!p) return '';
  const set = Array.isArray(posicoesLayout) ? posicoesLayout : [];
  if (set.includes(p)) return p;
  const alt = POSICAO_EQUIV[p];
  if (alt && set.includes(alt)) return alt;
  return null;
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

