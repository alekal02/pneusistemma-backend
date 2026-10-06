/**
 * Fase 3 — layouts skid_4 e giro_4, diagrama e layout no cadastro.
 * Sem banco: node scripts/test-fase3-layouts.mjs
 */
import assert from 'node:assert/strict';
import { resolverTipoEquipamento } from '../src/equipamento-tipos.js';
import {
  LAYOUTS_PNEU,
  PAPEL_POSICAO,
  POSICOES_PNEU,
  getLayout,
  layoutNaEdicao,
  layoutPadraoPorTipo,
  layoutParaNovoVeiculo,
  papelPosicao,
} from '../src/pneus-layouts.js';
import { mapLayoutId } from '../src/csv-utils.js';
import { svgMiniCaminhao } from '../../frontend/src/truck-diagram.js';

const skid = getLayout('skid_4');
const giro = getLayout('giro_4');

assert.equal(skid.id, 'skid_4');
assert.equal(giro.id, 'giro_4');
assert.equal(skid.diagrama, 'quad');
assert.equal(giro.diagrama, 'generico');
assert.deepEqual(skid.posicoes, ['S1E', 'S1D', 'S2E', 'S2D']);
assert.deepEqual(giro.posicoes, ['G1E', 'G1D', 'G2E', 'G2D']);
assert.equal(skid.posicoes.length, 4);
assert.equal(giro.posicoes.length, 4);

for (const codigo of [...skid.posicoes, ...giro.posicoes]) {
  assert.ok(POSICOES_PNEU[codigo], `posição sem rótulo: ${codigo}`);
}

const papeisSkid = new Set(skid.posicoes.map((p) => papelPosicao(p)));
assert.deepEqual([...papeisSkid], ['rodado']);
assert.equal(giro.posicoes.filter((p) => PAPEL_POSICAO[p] === 'direcional').length, 2);
assert.equal(giro.posicoes.filter((p) => PAPEL_POSICAO[p] === 'tracao').length, 2);

assert.equal(layoutPadraoPorTipo('Mini carregadeira'), 'skid_4');
assert.equal(layoutPadraoPorTipo('Giro zero'), 'giro_4');
assert.notEqual(layoutPadraoPorTipo('Mini carregadeira'), 'utilitario_4');
assert.notEqual(layoutPadraoPorTipo('Giro zero'), 'utilitario_4');
assert.equal(layoutPadraoPorTipo('Trator'), 'trator_4');
assert.equal(layoutPadraoPorTipo('Truck / Tração'), 'truck_10');
assert.equal(layoutPadraoPorTipo('Toco / Mini'), 'toco_6');
assert.equal(layoutPadraoPorTipo('Compactador'), 'compactador');
assert.equal(layoutPadraoPorTipo('Utilitário / Varredeira'), 'utilitario_4');

assert.deepEqual(resolverTipoEquipamento('mini_carregadeira').layouts_permitidos, ['skid_4']);
assert.deepEqual(resolverTipoEquipamento('giro_zero').layouts_permitidos, ['giro_4']);
assert.deepEqual(resolverTipoEquipamento('trator').layouts_permitidos, ['trator_4']);
assert.ok(!resolverTipoEquipamento('mini_carregadeira').layouts_permitidos.includes('utilitario_4'));
assert.ok(!resolverTipoEquipamento('giro_zero').layouts_permitidos.includes('utilitario_4'));

assert.equal(layoutParaNovoVeiculo('Mini carregadeira', null), 'skid_4');
assert.equal(layoutParaNovoVeiculo('Mini carregadeira', ''), 'skid_4');
assert.equal(layoutParaNovoVeiculo('Mini carregadeira', 'utilitario_4'), 'skid_4');
assert.equal(layoutParaNovoVeiculo('Mini carregadeira', 'trator_4'), 'skid_4');
assert.equal(layoutParaNovoVeiculo('Giro zero', 'utilitario_4'), 'giro_4');
assert.equal(layoutParaNovoVeiculo('Giro zero', 'giro_4'), 'giro_4');
assert.equal(layoutParaNovoVeiculo('Trator', null), 'trator_4');
assert.equal(layoutParaNovoVeiculo('Truck / Tração', null), 'truck_10');
assert.equal(layoutParaNovoVeiculo('Truck / Tração', 'truck_8'), 'truck_8');
assert.equal(layoutParaNovoVeiculo('Toco / Mini', 'toco_6'), 'toco_6');
assert.equal(
  layoutParaNovoVeiculo('Mini carregadeira', 'personalizado', { posicoesCustom: ['S1E'] }),
  'personalizado',
);

assert.equal(layoutNaEdicao('utilitario_4', undefined), 'utilitario_4');
assert.equal(layoutNaEdicao('utilitario_4', null), 'utilitario_4');
assert.equal(layoutNaEdicao('utilitario_4', ''), 'utilitario_4');
assert.equal(layoutNaEdicao('truck_10', 'toco_6'), 'toco_6');
assert.equal(getLayout('utilitario_4').id, 'utilitario_4');
assert.equal(getLayout('trator_4').posicoes.join(','), '1E,1D,2E,2D');
assert.equal(LAYOUTS_PNEU.truck_10.posicoes.length, 10);

assert.equal(mapLayoutId('utilitario', 'Mini carregadeira'), 'skid_4');
assert.equal(mapLayoutId('utilitario', 'Giro zero'), 'giro_4');
assert.equal(mapLayoutId('mini', 'Toco / Mini'), 'toco_6');
assert.equal(mapLayoutId('trator', 'Trator'), 'trator_4');
assert.equal(mapLayoutId('', 'Truck / Tração'), 'truck_10');
assert.equal(mapLayoutId('skid_4', 'Utilitário / Varredeira'), 'skid_4');

const svgSkid = svgMiniCaminhao({ layoutId: 'skid_4', posicoes: skid.posicoes });
const svgGiro = svgMiniCaminhao({ layoutId: 'giro_4', posicoes: giro.posicoes });
const svgTrator = svgMiniCaminhao({ layoutId: 'trator_4', posicoes: ['1E', '1D', '2E', '2D'] });
const svgTruck = svgMiniCaminhao({ layoutId: 'truck_10', posicoes: LAYOUTS_PNEU.truck_10.posicoes });
const svgUtil = svgMiniCaminhao({ layoutId: 'utilitario_4', posicoes: ['DD', 'DE', 'TD', 'TE'] });

assert.match(svgSkid, /data-diagrama="quad"/);
assert.match(svgSkid, /diagram-quad/);
assert.match(svgSkid, /Mini carregadeira/);
assert.match(svgGiro, /data-diagrama="generico"/);
assert.match(svgGiro, /diagram-generico/);
assert.match(svgGiro, /Giro zero/);
assert.doesNotMatch(svgTrator, /data-diagrama=/);
assert.doesNotMatch(svgTruck, /diagram-quad|diagram-generico/);
assert.doesNotMatch(svgUtil, /diagram-quad|diagram-generico/);
assert.match(svgSkid, /short|DE/);
assert.ok(svgSkid.includes('>DE<') && svgSkid.includes('>TD<'));
assert.ok(svgGiro.includes('>DE<') && svgGiro.includes('>TE<'));

console.log('test-fase3-layouts: ok');
