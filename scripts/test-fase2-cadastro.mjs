/**
 * Fase 2 — cadastro dinâmico pelo catálogo (sem banco).
 * node scripts/test-fase2-cadastro.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metaTiposEquipamento, resolverTipoEquipamento } from '../src/equipamento-tipos.js';
import { layoutPadraoPorTipo } from '../src/pneus-layouts.js';
import { textoMenu } from '../src/services/whatsapp-menu.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));

function camposVisiveis(tipo) {
  const u = resolverTipoEquipamento(tipo)?.unidade_uso;
  if (u === 'km') return { km: true, hr: false };
  if (u === 'horas') return { km: false, hr: true };
  return { km: true, hr: true };
}

function rotuloCadastro(tipo) {
  const cat = resolverTipoEquipamento(tipo);
  return cat?.familia === 'rodoviario' ? 'Caminhão' : 'Equipamento';
}

const meta = metaTiposEquipamento();
assert.ok(meta.tipos_equipamento?.length >= 8);
for (const t of meta.tipos_equipamento) {
  assert.ok(t.codigo && t.label && t.unidade_uso && t.layout_padrao && t.familia);
  assert.equal(layoutPadraoPorTipo(t.codigo), t.layout_padrao);
  assert.equal(layoutPadraoPorTipo(t.label), t.layout_padrao);
}

for (const codigo of ['compactador', 'truck_tracao', 'toco_mini', 'utilitario']) {
  const v = camposVisiveis(codigo);
  assert.equal(v.km, true, codigo);
  assert.equal(v.hr, false, codigo);
  assert.equal(rotuloCadastro(codigo), 'Caminhão', codigo);
}
for (const codigo of ['trator', 'mini_carregadeira', 'giro_zero']) {
  const v = camposVisiveis(codigo);
  assert.equal(v.km, false, codigo);
  assert.equal(v.hr, true, codigo);
  assert.equal(rotuloCadastro(codigo), 'Equipamento', codigo);
}

assert.equal(resolverTipoEquipamento('Toco / Mini')?.codigo, 'toco_mini');
assert.equal(camposVisiveis('Toco / Mini').km, true);
assert.equal(resolverTipoEquipamento('mini'), null);
assert.deepEqual(camposVisiveis('Tipo antigo sem catálogo'), { km: true, hr: true });
assert.equal(rotuloCadastro('Tipo antigo sem catálogo'), 'Equipamento');

const menu = textoMenu();
assert.ok(menu.includes('Cadastrar equipamento (link)'));
assert.equal(menu.includes('Cadastrar caminhão'), false);

const menuSrc = fs.readFileSync(path.join(aqui, '../src/services/whatsapp-menu.js'), 'utf8');
assert.ok(menuSrc.includes('escolha o tipo'));
assert.equal(menuSrc.includes('placa, tipo e KM'), false);

const app = fs.readFileSync(path.join(aqui, '../../frontend/src/app.js'), 'utf8');
assert.ok(app.includes('unidade_uso'));
assert.equal(app.includes("if (tipo === 'Toco / Mini')"), false);
assert.equal(app.includes("if (tipo === 'Compactador')"), false);
assert.ok(app.includes('tipos_equipamento'));

const html = fs.readFileSync(path.join(aqui, '../../frontend/index.html'), 'utf8');
assert.ok(html.includes('id="v-tipo-opcoes"'));
assert.ok(html.includes('id="ar-v-tipo-opcoes"'));
assert.equal(html.includes('<option value="Toco / Mini">'), false);

console.log('fase2 cadastro ok', meta.tipos_equipamento.map((t) => `${t.codigo}:${t.unidade_uso}`).join(' '));
