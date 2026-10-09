/**
 * Diagramas do PDF seguem o layout do veículo.
 * Sem banco: node scripts/test-diagrama-pdf.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { LAYOUTS_PNEU } from '../src/pneus-layouts.js';
import {
  desenharPaginaFrota,
  geometriaDiagrama,
  posicoesDiagramaVeiculo,
  rotuloSulcoSlot,
} from '../src/services/relatorio-frota-visual-pdf.js';

const MM = 2.834645669;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfPath = path.join(root, 'tmp', 'diagrama-layouts-teste.pdf');

function sobrepoe(a, b) {
  const folga = 0.4;
  return a.x < b.x + b.w - folga
    && a.x + a.w > b.x + folga
    && a.y < b.y + b.h - folga
    && a.y + a.h > b.y + folga;
}

function assertSemSobreposicao(slots, nome) {
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      assert.equal(
        sobrepoe(slots[i], slots[j]),
        false,
        `${nome}: ${slots[i].codigo} sobrepoe ${slots[j].codigo}`,
      );
    }
  }
}

function assertCabeNoCard(posicoes, nome) {
  const pageW = 841.89;
  const margin = 12 * MM;
  const gap = 4 * MM;
  const cw = (pageW - 2 * margin - gap * 2) / 3;
  const ch = 68 * MM;
  const footer = 16 * MM;
  const areaH = ch - 11 - 2 - footer - 4;
  const pad = 5;
  const areaW = cw - 16 - pad * 2;
  const geo = geometriaDiagrama(posicoes, areaW, areaH - pad * 2);
  assert.equal(geo.slots.length, posicoes.length, nome);
  assert.ok(geo.w * geo.scale <= areaW + 0.6, `${nome} largo demais`);
  assert.ok(geo.h * geo.scale <= areaH - pad * 2 + 0.6, `${nome} alto demais`);
  assertSemSobreposicao(geo.slots, nome);
  assert.deepEqual(geo.slots.map((s) => s.codigo).sort(), [...posicoes].sort(), nome);
  return geo;
}

function pneu(posicao, menor, status) {
  return { posicao, menor_sulco: menor, status_sulco: status };
}

const truck10 = posicoesDiagramaVeiculo({ layout: 'truck_10', pneus: [] });
assert.deepEqual(truck10, LAYOUTS_PNEU.truck_10.posicoes);
assert.equal(truck10.length, 10);
assert.ok(!truck10.includes('2E'));
assertCabeNoCard(truck10, 'truck_10');

const truck8 = posicoesDiagramaVeiculo({ layout: 'truck_8' });
assert.deepEqual(truck8, LAYOUTS_PNEU.truck_8.posicoes);
assert.equal(truck8.length, 8);
assert.ok(!truck8.includes('3EE') && !truck8.includes('3DE'));
assertCabeNoCard(truck8, 'truck_8');

const utilitario = posicoesDiagramaVeiculo({ layout: 'utilitario_4', tipo: 'Truck / Tração' });
assert.deepEqual(utilitario, ['DD', 'DE', 'TD', 'TE']);
assertCabeNoCard(utilitario, 'utilitario_4');

const skid = posicoesDiagramaVeiculo({ layout: 'skid_4' });
assert.deepEqual(skid, ['S1E', 'S1D', 'S2E', 'S2D']);
assertCabeNoCard(skid, 'skid_4');

const moto = posicoesDiagramaVeiculo({ layout: 'moto_2' });
assert.deepEqual(moto, ['D', 'T']);
assertCabeNoCard(moto, 'moto_2');

const personalizado = posicoesDiagramaVeiculo({
  layout: 'personalizado',
  pneus: [pneu('2D', 9, 'ok'), pneu('2E', 5, 'alerta')],
});
assert.deepEqual(personalizado, ['2E', '2D']);
assert.ok(!personalizado.includes('2EE') && !personalizado.includes('2DE'));
assertCabeNoCard(personalizado, 'personalizado');

const desconhecido = posicoesDiagramaVeiculo({
  layout: '',
  pneus: [pneu('TE', 4, 'alerta'), pneu('DE', 0, 'critico')],
});
assert.deepEqual(desconhecido, ['DE', 'TE']);

const bob = {
  id: 'bob0476',
  apelido: 'BOB CAT',
  placa: 'BOB0476',
  tipo: 'Truck / Tração',
  layout: 'utilitario_4',
  ultima_medicao: '2026-10-09',
  menor_sulco: 0,
  status_sulco: 'critico',
  status_label: 'Critico',
  total_pneus: 3,
  pneus: [
    pneu('DE', 0, 'critico'),
    pneu('DD', null, 'sem_dado'),
    pneu('TE', 11, 'ok'),
  ],
};
const posBob = posicoesDiagramaVeiculo(bob);
assert.deepEqual(posBob, ['DD', 'DE', 'TD', 'TE']);
assert.equal(posBob.includes('1E') || posBob.includes('2EE'), false);
assert.deepEqual(rotuloSulcoSlot(bob.pneus[0]), { tipo: 'medido', mm: 0 });
assert.deepEqual(rotuloSulcoSlot(bob.pneus[1]), { tipo: 'sem_medicao', mm: null });
assert.deepEqual(rotuloSulcoSlot(null), { tipo: 'vazio', mm: null });
assertCabeNoCard(posBob, 'BOB0476');

const geoSimples = geometriaDiagrama(['2E', '2D'], 200, 120);
assert.deepEqual(geoSimples.slots.map((s) => s.codigo), ['2E', '2D']);
assert.ok(!geoSimples.slots.some((s) => s.codigo === '2EE' || s.codigo === '2DE'));

function veiculo(parcial) {
  return {
    ultima_medicao: '2026-10-09',
    menor_sulco: 8,
    status_sulco: 'alerta',
    status_label: 'Alerta',
    pneus: (parcial.posicoes || []).map((codigo) => pneu(codigo, 8, 'alerta')),
    ...parcial,
  };
}

const frota = [
  veiculo({
    apelido: 'Truck 10',
    placa: 'TRK10',
    tipo: 'Truck / Tração',
    layout: 'truck_10',
    posicoes: truck10,
    pneus: truck10.map((codigo, i) => (
      i === truck10.length - 1
        ? null
        : pneu(codigo, i === 0 ? 0 : 9, i === 0 ? 'critico' : 'ok')
    )).filter(Boolean),
    menor_sulco: 0,
    status_sulco: 'critico',
    status_label: 'Critico',
  }),
  veiculo({
    apelido: 'Truck 8',
    placa: 'TRK8',
    tipo: 'Truck / Tração',
    layout: 'truck_8',
    posicoes: truck8,
  }),
  veiculo({
    apelido: 'Utilitario',
    placa: 'UTI4',
    tipo: 'Utilitário / Varredeira',
    layout: 'utilitario_4',
    posicoes: utilitario,
    pneus: [
      pneu('DD', 7, 'alerta'),
      pneu('DE', null, 'sem_dado'),
      pneu('TD', 14, 'ok'),
    ],
  }),
  veiculo({
    apelido: 'Mini',
    placa: 'SKD4',
    tipo: 'Mini carregadeira',
    layout: 'skid_4',
    posicoes: skid,
  }),
  veiculo({
    apelido: 'Moto',
    placa: 'MOTO2',
    tipo: 'Outros',
    layout: 'moto_2',
    posicoes: moto,
  }),
  veiculo({
    apelido: 'Personalizado',
    placa: 'PERS',
    tipo: 'Outros',
    layout: 'personalizado',
    pneus: [pneu('2E', 5, 'alerta'), pneu('2D', 9, 'ok')],
    menor_sulco: 5,
  }),
  bob,
];

const dados = {
  titulo: 'Teste de diagramas',
  filtro_label: 'Layouts',
  filial: { nome: 'Unidade teste' },
  periodo: { label: '09/10/2026' },
  frota,
};

const doc = new PDFDocument({
  size: 'A4',
  layout: 'landscape',
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
  autoFirstPage: true,
});
const chunks = [];
doc.on('data', (c) => chunks.push(c));
const gravado = new Promise((resolve, reject) => {
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});
desenharPaginaFrota(doc, dados, frota.slice(0, 6), [], 1, 2);
doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
desenharPaginaFrota(doc, dados, frota.slice(6), [], 2, 2);
doc.end();
const buffer = await gravado;
fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
fs.writeFileSync(pdfPath, buffer);
assert.ok(buffer.slice(0, 5).toString() === '%PDF-');

function trechosPdf(buf) {
  const cru = buf.toString('latin1');
  const trechos = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m = re.exec(cru);
  while (m) {
    let bloco = m[1];
    try {
      bloco = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      /* stream já em claro */
    }
    const shows = /\[(.*?)\]\s*TJ|\((?:\\.|[^)\\])*\)\s*Tj/g;
    let s = shows.exec(bloco);
    while (s) {
      if (s[1] != null) {
        let frase = '';
        const pedacos = /<([0-9A-Fa-f]+)>|\((?:\\.|[^)\\])*\)/g;
        let p = pedacos.exec(s[1]);
        while (p) {
          if (p[1]) {
            if (p[1].length % 2 === 0) frase += Buffer.from(p[1], 'hex').toString('latin1');
          } else {
            frase += p[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
          }
          p = pedacos.exec(s[1]);
        }
        if (frase) trechos.push(frase);
      } else {
        trechos.push(s[0].replace(/\)\s*Tj$/, '').slice(1).replace(/\\([()\\])/g, '$1'));
      }
      s = shows.exec(bloco);
    }
    m = re.exec(cru);
  }
  return trechos;
}

const trechos = trechosPdf(buffer);
const texto = trechos.join('\n');
for (const codigo of ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3EE', '3EI', '3DI', '3DE', 'S1E', 'S1D', 'S2E', 'S2D', '2E', '2D', 'DE', 'DD', 'TE', 'TD']) {
  assert.ok(trechos.includes(codigo), `PDF sem o codigo completo ${codigo}`);
}
assert.equal(trechos.includes('EE') || trechos.includes('EI') || trechos.includes('DI'), false);
assert.ok(texto.includes('BOB CAT'));
assert.ok(texto.includes('BOB0476'));
assert.ok(texto.includes('0 mm'));
assert.ok(texto.includes('09/10/2026'));
assert.ok(texto.includes('1/2') && texto.includes('2/2'));

console.log(`ok diagramas ${pdfPath}`);
