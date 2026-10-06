/**
 * Fase 6 — dashboard, painel e relatórios leem o motor de alertas.
 * Sem banco: node scripts/test-fase6-painel.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  avaliarPneuPainel,
  bucketKpi,
  contarAcaoLegada,
  indicadoresUso,
  mediaUso,
  novoAcumulador,
  acumularAlerta,
  unidadeUsoVeiculo,
  veiculoCombinaTipo,
} from '../src/services/indicadores-frota.js';

const limites = {
  sulco_critico_mm: 3,
  sulco_alerta_mm: 6,
  sulco_recap_mm: 3,
  sulco_novo_mm: 14,
  max_recaps: 6,
  prazo_recap_dias: 15,
  diagnostico_tolerancia_mm: 1,
  rodizio_desvio_mm: 4,
  rodizio_similaridade_mm: 2.5,
  perfil: 'caminhao',
};

function pneu(tipo, sulcos, extra = {}) {
  return {
    tipo,
    layout_pneus: extra.layout || null,
    vida_recap: 0,
    posicao: extra.posicao || '1E',
    km_atual: extra.km_atual,
    hr_atual: extra.hr_atual,
    ...sulcos,
  };
}

const okTruck = avaliarPneuPainel(pneu('Truck / Tração', {
  sulco_externo: 12, sulco_central: 12, sulco_interno: 12, sulco_auxiliar: 12,
}), { limites });
assert.equal(bucketKpi(okTruck), 'ok');
assert.equal(okTruck.acao.codigo, 'ok');
assert.equal(unidadeUsoVeiculo('Truck / Tração'), 'km');

const alertaTruck = avaliarPneuPainel(pneu('Toco / Mini', {
  sulco_externo: 5, sulco_central: 5, sulco_interno: 5, sulco_auxiliar: 5,
}, { layout: 'toco_6' }), { limites });
assert.equal(bucketKpi(alertaTruck), 'monitorar');
assert.equal(contarAcaoLegada(alertaTruck.acao.codigo), 'monitorar');

const criticoTruck = avaliarPneuPainel(pneu('Compactador', {
  sulco_externo: 2, sulco_central: 2, sulco_interno: 2, sulco_auxiliar: 2,
}, { layout: 'compactador' }), { limites });
assert.equal(bucketKpi(criticoTruck), 'critico');
assert.equal(contarAcaoLegada(criticoTruck.acao.codigo), 'troca');

const trator = avaliarPneuPainel(pneu('Trator', {
  sulco_externo: 4, sulco_central: 4, sulco_interno: 4, sulco_auxiliar: 4,
}, { layout: 'trator_4', hr_atual: 80 }), { limites: { ...limites, perfil: 'trator' } });
assert.equal(unidadeUsoVeiculo('Trator', 'trator_4'), 'horas');
assert.equal(bucketKpi(trator), 'monitorar');

const corte = avaliarPneuPainel(pneu('Mini carregadeira', {
  sulco_mm: 12,
  inspecao_danos: { itens: ['corte'] },
}, { layout: 'skid_4' }), { limites });
assert.equal(bucketKpi(corte), 'critico');
assert.equal(contarAcaoLegada(corte.acao.codigo), 'troca');

const uso = mediaUso([
  { tipo: 'Truck / Tração', km_atual: 10000, hr_atual: 999 },
  { tipo: 'Trator', layout_pneus: 'trator_4', km_atual: 50000, hr_atual: 100 },
  { tipo: 'Mini carregadeira', layout_pneus: 'skid_4', km_atual: 1, hr_atual: 300 },
  { tipo: 'Caminhao legado', km_atual: 4000, hr_atual: 50 },
]);
assert.equal(uso.km.veiculos, 2);
assert.equal(uso.km.media, 7000);
assert.equal(uso.horas.veiculos, 2);
assert.equal(uso.horas.media, 200);
assert.notEqual(uso.km.media, uso.horas.media);

const accKm = novoAcumulador();
const accHoras = novoAcumulador();
acumularAlerta(accKm, okTruck);
acumularAlerta(accHoras, trator);
const ind = indicadoresUso([
  { tipo: 'Truck / Tração', km_atual: 10000, hr_atual: 999 },
  { tipo: 'Trator', hr_atual: 100, km_atual: 50000 },
], accKm, accHoras);
assert.equal(ind.km.ok, 1);
assert.equal(ind.km.monitorar, 0);
assert.equal(ind.horas.monitorar, 1);
assert.equal(ind.horas.ok, 0);
assert.equal(ind.km.media, 10000);
assert.equal(ind.horas.media, 100);

assert.equal(veiculoCombinaTipo('Truck / Tração', 'truck_tracao'), true);
assert.equal(veiculoCombinaTipo('Toco / Mini', 'truck_tracao'), false);
assert.equal(veiculoCombinaTipo('Trator', ''), true);
assert.equal(veiculoCombinaTipo('Caminhao legado', null), true);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontes = [
  'src/routes/dashboard.js',
  'src/routes/filiais.js',
  'src/routes/relatorios.js',
  'src/services/relatorio-semanal-pdf.js',
];
for (const rel of fontes) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.equal(src.includes('sugerirAcao'), false, `${rel} ainda chama sugerirAcao`);
  assert.equal(src.includes('avaliarPneuPainel'), true, `${rel} não usa o motor`);
}

console.log('fase 6 ok');
