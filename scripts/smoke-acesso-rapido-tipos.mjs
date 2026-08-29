import { initDatabase, closePool, getDb } from '../src/database.js';
import { gerarTokenAcessoRapido, validarTokenAcessoRapido } from '../src/services/acesso-rapido.js';
import { textoMenu } from '../src/services/whatsapp-menu.js';
import { devolverRecapAoEstoque } from '../src/services/whatsapp-ops.js';

await initDatabase();
const db = getDb();
const cols = await db.prepare(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'tokens_acesso_rapido' ORDER BY 1
`).all();
console.log('cols', cols.map((c) => c.column_name || c.COLUMN_NAME));

const t1 = await gerarTokenAcessoRapido({ tipo: 'cadastrar_veiculo', filialId: 1, whatsappOrigem: '55' });
const t2 = await gerarTokenAcessoRapido({ tipo: 'cadastrar_pneu', filialId: 1 });
const v = await db.prepare('SELECT id FROM veiculos WHERE filial_id = 1 LIMIT 1').get();
const t3 = await gerarTokenAcessoRapido({ tipo: 'troca', veiculoId: v.id, filialId: 1 });
const t4 = await gerarTokenAcessoRapido({ tipo: 'medir', veiculoId: v.id, filialId: 1 });
console.log('veiculo link', t1.link.includes('/acesso-rapido/veiculo'), t1.tipo);
console.log('pneu link', t2.link.includes('/acesso-rapido/pneu'), t2.tipo);
console.log('troca link', t3.link.includes('/acesso-rapido/troca'), t3.tipo);
console.log('medir link', t4.link.includes('veiculo-acesso-rapido'), t4.tipo);
console.log('valid', (await validarTokenAcessoRapido(t1.token, ['cadastrar_veiculo']))?.tipo);
console.log('menu ok', textoMenu().includes('Cadastrar caminhão (link)'));
console.log('devolverRecap fn', typeof devolverRecapAoEstoque);
await closePool();
console.log('OK');
