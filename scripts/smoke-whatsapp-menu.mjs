import { initDatabase, getDb, closePool } from '../src/database.js';
import { salvarSessao, obterSessao, limparSessao } from '../src/services/whatsapp-sessao.js';
import { textoMenu } from '../src/services/whatsapp-menu.js';
import * as ops from '../src/services/whatsapp-ops.js';

await initDatabase();
const db = getDb();

const t = await db.prepare(`SELECT to_regclass('public.whatsapp_sessoes') AS nome`).get();
console.log('tabela:', t);

await salvarSessao({
  filialId: 1,
  telefone: '5511999999999',
  chatJid: 'test@g.us',
  fluxo: 'medir',
  passo: 'placa',
  dados: { ok: true },
});
const s = await obterSessao(1, '5511999999999', 'test@g.us');
console.log('sessao:', { fluxo: s?.fluxo, passo: s?.passo, dados: s?.dados });
await limparSessao(1, '5511999999999', 'test@g.us');

console.log('menu_linhas:', textoMenu().split('\n').length);

const frota = await ops.listarFrota(1);
console.log('frota_count:', frota.length);

await closePool();
console.log('OK');
