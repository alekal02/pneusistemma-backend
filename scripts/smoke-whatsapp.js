import { getDb } from '../src/database.js';
import { gerarTokenAcessoRapido, validarTokenAcessoRapido, montarDetalheVeiculo } from '../src/services/acesso-rapido.js';
import { extrairTelefone, extrairTextoMensagem } from '../src/routes/webhook.js';

const db = getDb();
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table' AND name IN ('tokens_acesso_rapido','notificacoes_whatsapp')
`).all().map((t) => t.name);
console.log('tables:', tables.join(', ') || '(missing)');

const cols = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name);
console.log('usuarios.whatsapp:', cols.includes('whatsapp'));
console.log('usuarios.cargo:', cols.includes('cargo'));
console.log('users:', db.prepare('SELECT login, papel, cargo FROM usuarios').all());

const phone = extrairTelefone({
  event: 'Message',
  data: { from: '5511999999999@s.whatsapp.net', message: { conversation: 'ABC1D23' } },
});
const text = extrairTextoMensagem({
  event: 'Message',
  data: { from: '5511999999999@s.whatsapp.net', message: { conversation: 'ABC1D23' } },
});
console.log('parse webhook:', { phone, text });

const veiculo = db.prepare('SELECT id, placa, filial_id FROM veiculos WHERE ativo = 1 LIMIT 1').get();
if (veiculo) {
  const { token, link } = gerarTokenAcessoRapido({
    veiculoId: veiculo.id,
    filialId: veiculo.filial_id,
    whatsappOrigem: '5511999999999',
  });
  const row = validarTokenAcessoRapido(token);
  const detalhe = montarDetalheVeiculo(veiculo.id, veiculo.filial_id);
  console.log('token ok:', Boolean(row), 'link ends:', link.slice(-20));
  console.log('detalhe placa:', detalhe?.placa, 'pneus:', detalhe?.pneus?.length);
} else {
  console.log('sem veiculos para testar token');
}

console.log('smoke ok');
