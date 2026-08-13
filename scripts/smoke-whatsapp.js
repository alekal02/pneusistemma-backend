import { initDatabase, getDb, closePool } from '../src/database.js';
import { gerarTokenAcessoRapido, validarTokenAcessoRapido, montarDetalheVeiculo } from '../src/services/acesso-rapido.js';
import { extrairTelefone, extrairTextoMensagem } from '../src/routes/webhook.js';

async function main() {
  await initDatabase();
  const db = getDb();

  const tables = (await db.prepare(`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('tokens_acesso_rapido','notificacoes_whatsapp')
  `).all()).map((t) => t.name);
  console.log('tables:', tables.join(', ') || '(missing)');

  const cols = (await db.prepare(`
    SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'usuarios'
  `).all()).map((c) => c.name);
  console.log('usuarios.whatsapp:', cols.includes('whatsapp'));
  console.log('usuarios.cargo:', cols.includes('cargo'));
  console.log('users:', await db.prepare('SELECT login, papel, cargo FROM usuarios').all());

  const phone = extrairTelefone({
    event: 'Message',
    data: { from: '5511999999999@s.whatsapp.net', message: { conversation: 'ABC1D23' } },
  });
  const text = extrairTextoMensagem({
    event: 'Message',
    data: { from: '5511999999999@s.whatsapp.net', message: { conversation: 'ABC1D23' } },
  });
  console.log('parse webhook:', { phone, text });

  const veiculo = await db.prepare('SELECT id, placa, filial_id FROM veiculos WHERE ativo = 1 LIMIT 1').get();
  if (veiculo) {
    const { token, link } = await gerarTokenAcessoRapido({
      veiculoId: veiculo.id,
      filialId: veiculo.filial_id,
      whatsappOrigem: '5511999999999',
    });
    const row = await validarTokenAcessoRapido(token);
    const detalhe = await montarDetalheVeiculo(veiculo.id, veiculo.filial_id);
    console.log('token ok:', Boolean(row), 'link ends:', link.slice(-20));
    console.log('detalhe placa:', detalhe?.placa, 'pneus:', detalhe?.pneus?.length);
  } else {
    console.log('sem veiculos para testar token');
  }

  await closePool();
  console.log('smoke ok');
}

main().catch(async (err) => {
  console.error(err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
