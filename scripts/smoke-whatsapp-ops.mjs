import { initDatabase, closePool } from '../src/database.js';
import * as ops from '../src/services/whatsapp-ops.js';

await initDatabase();
const filialId = 1;

const placa = `TST${Date.now().toString().slice(-5)}`;
const v = await ops.criarVeiculo(filialId, {
  placa,
  apelido: 'Smoke',
  tipo: 'Truck / Tração',
  km_atual: 1000,
});
console.log('veiculo', v);

const fogo = `F${Date.now().toString().slice(-6)}`;
const p = await ops.criarPneuEstoque(filialId, {
  numero_fogo: fogo,
  marca: 'Teste',
  modelo: 'Smoke',
  tipo_pneu: 'misto',
  condicao: 'novo',
  sulco_inicial_mm: 14,
});
console.log('pneu', { id: p.id, fogo: p.numero_fogo });

const livres = await ops.posicoesLivres(v.id);
console.log('livres', livres.slice(0, 3));

const m = await ops.montarPneu({
  filialId,
  pneuId: p.id,
  veiculoId: v.id,
  posicao: livres[0],
});
console.log('montado', m);

const d = await ops.desmontarPneu({ filialId, pneuId: p.id });
console.log('desmontado', d);

const r = await ops.registrarRecap({ filialId, pneuId: p.id });
console.log('recap', r);

const p2 = await ops.criarPneuEstoque(filialId, {
  numero_fogo: `D${Date.now().toString().slice(-6)}`,
  modelo: 'Desc',
  tipo_pneu: 'misto',
  condicao: 'novo',
});
const des = await ops.registrarDescarte({ filialId, pneuId: p2.id, motivo: 'smoke' });
console.log('descarte', des);

await closePool();
console.log('OPS OK');
