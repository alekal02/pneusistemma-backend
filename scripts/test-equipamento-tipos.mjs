/**
 * Fase 1 — catálogo de tipos e o bug "mini" → Toco.
 * Sem banco: node scripts/test-equipamento-tipos.mjs
 */
import assert from 'node:assert/strict';
import {
  EQUIPAMENTO_TIPOS,
  camposTipoVeiculo,
  layoutPadraoDoCatalogo,
  metaTiposEquipamento,
  resolverTipoEquipamento,
} from '../src/equipamento-tipos.js';
import { layoutPadraoPorTipo } from '../src/pneus-layouts.js';
import { mapLayoutId } from '../src/csv-utils.js';
import { normalizarTipoVeiculo } from '../src/fix-encoding.js';
import { ensureReturningId } from '../src/pg-sql.js';

const codigos = EQUIPAMENTO_TIPOS.map((t) => t.codigo);
for (const codigo of [
  'compactador',
  'mini_carregadeira',
  'trator',
  'giro_zero',
  'truck_tracao',
  'toco_mini',
  'utilitario',
  'outros',
]) {
  assert.ok(codigos.includes(codigo), `catálogo sem ${codigo}`);
}

assert.equal(resolverTipoEquipamento('mini'), null);
assert.notEqual(layoutPadraoPorTipo('mini'), 'toco_6');
assert.notEqual(layoutPadraoDoCatalogo('mini'), 'toco_6');

assert.equal(resolverTipoEquipamento('Mini carregadeira')?.codigo, 'mini_carregadeira');
assert.equal(resolverTipoEquipamento('mini_carregadeira')?.codigo, 'mini_carregadeira');
assert.equal(resolverTipoEquipamento('skid steer')?.codigo, 'mini_carregadeira');
assert.equal(layoutPadraoPorTipo('Mini carregadeira'), 'skid_4');
assert.notEqual(layoutPadraoPorTipo('Mini carregadeira'), 'toco_6');

assert.equal(resolverTipoEquipamento('Toco / Mini')?.codigo, 'toco_mini');
assert.equal(resolverTipoEquipamento('toco')?.codigo, 'toco_mini');
assert.equal(layoutPadraoPorTipo('Toco / Mini'), 'toco_6');
assert.equal(layoutPadraoPorTipo('toco'), 'toco_6');

assert.equal(layoutPadraoPorTipo('Compactador'), 'compactador');
assert.equal(layoutPadraoPorTipo('Caminhão Compactador'), 'compactador');
assert.equal(layoutPadraoPorTipo('Trator'), 'trator_4');
assert.equal(layoutPadraoPorTipo('Giro zero'), 'giro_4');
assert.equal(layoutPadraoPorTipo('Truck / Tração'), 'truck_10');
assert.equal(resolverTipoEquipamento('giro zero')?.codigo, 'giro_zero');

const meta = metaTiposEquipamento();
assert.ok(meta.tipos.includes('Mini carregadeira'));
assert.ok(meta.tipos.includes('Giro zero'));
assert.equal(meta.layout_padrao_por_tipo['Toco / Mini'], 'toco_6');
assert.equal(meta.layout_padrao_por_tipo['Mini carregadeira'], 'skid_4');
assert.ok(meta.tipos_equipamento.every((t) => t.codigo && t.layouts_permitidos?.length));

const compactador = camposTipoVeiculo('compactador');
assert.equal(compactador.tipo, 'Compactador');
assert.equal(compactador.tipo_codigo, 'compactador');

const legado = camposTipoVeiculo('Caminhão Basculante');
assert.equal(legado.tipo, 'Caminhão Basculante');
assert.equal(legado.tipo_codigo, null);

assert.equal(normalizarTipoVeiculo('Truck / Tracao'), 'Truck / Tração');
assert.equal(normalizarTipoVeiculo('mini carregadeira'), 'Mini carregadeira');
assert.equal(normalizarTipoVeiculo('Toco / Mini'), 'Toco / Mini');
assert.equal(normalizarTipoVeiculo('mini'), 'mini');

assert.equal(mapLayoutId('', 'Mini carregadeira'), 'skid_4');
assert.equal(mapLayoutId('', 'Toco / Mini'), 'toco_6');
assert.equal(mapLayoutId('', 'Trator'), 'trator_4');
assert.equal(mapLayoutId('', 'Giro zero'), 'giro_4');
assert.notEqual(mapLayoutId('', 'mini'), 'toco_6');
assert.equal(mapLayoutId('mini', 'Truck / Tração'), 'toco_6');
assert.equal(mapLayoutId('mini', 'Mini carregadeira'), 'skid_4');
assert.equal(mapLayoutId('trator', 'Truck / Tração'), 'trator_4');

const seedSql = ensureReturningId(
  "INSERT INTO equipamento_tipos (codigo) VALUES ('compactador') ON CONFLICT (codigo) DO UPDATE SET label = EXCLUDED.label",
);
assert.equal(seedSql.includes('RETURNING'), false);

console.log('test-equipamento-tipos: ok');
