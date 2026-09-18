import {
  parseCsv,
  toCsv,
  parseNumeroBr,
  VEICULO_TEMPLATE_HEADERS,
  VEICULO_TEMPLATE_ROWS,
  PNEU_TEMPLATE_HEADERS,
  PNEU_TEMPLATE_ROWS,
  FROTA_TEMPLATE_HEADERS,
  FROTA_TEMPLATE_ROWS,
  mapLayoutId,
  mapTipoPneu,
  mapCondicao,
  mapStatusPneu,
  mapPosicaoPneu,
  placaDaLinha,
  encaixarPosicaoNoLayout,
} from '../src/csv-utils.js';

let fail = 0;
function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  if (!ok) fail += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` | ${extra}` : ''}`);
}

const vCsv = toCsv(VEICULO_TEMPLATE_HEADERS, VEICULO_TEMPLATE_ROWS);
check('BOM UTF-8', vCsv.charCodeAt(0) === 0xFEFF);
const vParsed = parseCsv(vCsv);
check('roundtrip veículos', vParsed.rows.length === 2 && vParsed.rows[0].placa === 'ABC1D23');

const pParsed = parseCsv(toCsv(PNEU_TEMPLATE_HEADERS, PNEU_TEMPLATE_ROWS));
check('roundtrip pneus', pParsed.rows.length === 3 && mapTipoPneu(pParsed.rows[0].tipo_pneu) === 'direcional');
check('planilha pneus tem placa e posicao', PNEU_TEMPLATE_HEADERS.includes('placa') && PNEU_TEMPLATE_HEADERS.includes('posicao'));
check('exemplo monta no caminhão', pParsed.rows[0].placa === 'ABC1D23' && pParsed.rows[0].posicao === '1E');
check('exemplo sem placa vai ao estoque', !String(pParsed.rows[2].placa || '').trim());
check('condicao recapado', mapCondicao('recapado') === 'recapado');

const fParsed = parseCsv(toCsv(FROTA_TEMPLATE_HEADERS, FROTA_TEMPLATE_ROWS));
check('roundtrip frota', fParsed.rows.length === 4);
check('frota modelo persistido no CSV', fParsed.rows[0].modelo === 'X Multi D');
check(
  'status montado/estoque',
  mapStatusPneu(fParsed.rows[0].status, { placa: 'X', posicao: '1E' }) === 'montado'
    && mapStatusPneu(fParsed.rows[3].status) === 'estoque',
);

const comma = parseCsv('placa,apelido,tipo\nXYZ1A23,Teste,Toco / Mini\n');
check('CSV vírgula', comma.separator === ',' && comma.rows[0].placa === 'XYZ1A23');

const fogo = parseCsv('Nº de fogo;tipo_pneu\nF-1;misto\n');
check('alias Nº de fogo → numero_fogo', fogo.headers[0] === 'numero_fogo' && fogo.rows[0].numero_fogo === 'F-1');

check('número 16,5', parseNumeroBr('16,5') === 16.5);
check('número 1.850,00', parseNumeroBr('1.850,00') === 1850);
check('número 1850.00', parseNumeroBr('1850.00') === 1850);

check('layout 6x2 → truck_8', mapLayoutId('truck_6x2') === 'truck_8');
check('layout 6x4 → truck_10', mapLayoutId('6x4') === 'truck_10');
check('layout toco', mapLayoutId('toco', 'Toco / Mini') === 'toco_6');

const quoted = toCsv(['placa', 'obs'], [{ placa: 'ABC', obs: 'a;b "x"' }]);
const quotedP = parseCsv(quoted);
check('campo com ; e aspas', quotedP.rows[0].obs === 'a;b "x"', JSON.stringify(quotedP.rows[0]?.obs));

check('alias placa do veículo → placa', parseCsv('placa do veículo;posicao\nABC1D23;1E\n').rows[0].placa === 'ABC1D23');
check('posição 2D1 → 2DI', mapPosicaoPneu('2D1') === '2DI');
check('1E no compactador vira DE', encaixarPosicaoNoLayout('1E', ['DD', 'DE', 'E2DE']) === 'DE');
check('1E no truck permanece 1E', encaixarPosicaoNoLayout('1E', ['1E', '1D', '2EE']) === '1E');
check('placaDaLinha aceita veiculo', placaDaLinha({ veiculo: 'abc1d23' }) === 'ABC1D23');

console.log('\nFalhas:', fail);
process.exit(fail ? 1 : 0);
