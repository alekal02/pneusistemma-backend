/**
 * Teste pós-deploy da frota completa e do menu 8.
 * Somente leitura: não chama initDatabase, não grava banco e não envia WhatsApp.
 * Uso após publicar: node scripts/pos-deploy-frota-menu.mjs
 * Com leitura HTTP opcional: POS_DEPLOY_HEALTH=1 node scripts/pos-deploy-frota-menu.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { textoMenu } from '../src/services/whatsapp-menu.js';
import { linhasTabelaFrota, veiculosComDiagrama } from '../src/services/relatorio-frota-visual-pdf.js';
import { resolverFiltroRelatorio, veiculoNoFiltro } from '../src/services/relatorio-semanal-pdf.js';

const urlBanco = String(process.env.DATABASE_URL || '');
if (/neon\.tech|render\.com|pneusistemma-backend/i.test(urlBanco) && process.env.POS_DEPLOY_HEALTH !== '1') {
  console.error('Este teste não usa o banco de produção. Remova DATABASE_URL deste processo.');
  process.exit(2);
}

const menu = textoMenu();
assert.match(menu, /8️⃣ Relatório da frota \(PDF por tipo\)/);
const menuSrc = fs.readFileSync(new URL('../src/services/whatsapp-menu.js', import.meta.url), 'utf8');
assert.match(menuSrc, /case '8':\s*await pedirTipoRelatorio\(ctx\);/);

const frota = [
  { placa: 'COM0001', apelido: 'Com pneu', tipo: 'Truck', pneus: [{ id: 1 }], menor_sulco: 10, status_label: 'OK' },
  { placa: 'SEM0001', apelido: 'Sem pneu', tipo: 'Truckado', pneus: [], menor_sulco: null, status_label: 'OK' },
];
const linhas = linhasTabelaFrota(frota);
assert.equal(linhas.length, 2);
assert.equal(linhas[1].placa, 'SEM0001');
assert.equal(linhas[1].status, 'Sem pneu montado');
assert.equal(veiculosComDiagrama(frota).length, 1);

const todos = resolverFiltroRelatorio('todos');
assert.equal(veiculoNoFiltro({ tipo: 'Truckado', tipo_codigo: null }, todos), true);
assert.equal(veiculoNoFiltro({ tipo: 'Mini', tipo_codigo: null }, todos), true);

const app = fs.readFileSync(new URL('../../frontend/src/app.js', import.meta.url), 'utf8');
const relatorios = fs.readFileSync(new URL('../src/routes/relatorios.js', import.meta.url), 'utf8');
assert.match(app, /relatorios\/unidade\/semanal\.pdf/);
assert.match(app, /qs\.set\('tipo', tipo\)/);
assert.match(relatorios, /tipo: req\.query\.tipo/);
assert.match(relatorios, /montarRelatorioDiretoria\(req\.query\.tipo\)/);

if (process.env.POS_DEPLOY_HEALTH === '1') {
  const base = 'https://pneusistemma-backend.onrender.com/api/health';
  const resp = await fetch(base, { method: 'GET' });
  const body = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(body.status, 'ok');
  console.log('health leitura', body.commit || 'sem commit');
}

console.log('pos-deploy frota e menu 8 ok');
