/**
 * Limpa veículos, pneus e histórico de UMA filial (padrão: Belo Horizonte).
 * Mantém cadastro da filial, logins e WhatsApp.
 *
 * Uso (na pasta backend, com DATABASE_URL no ambiente):
 *   node scripts/limpar-filial.js --listar
 *   node scripts/limpar-filial.js --filial=BH --confirmar
 */
import { initDatabase, getDb, closePool } from '../src/database.js';
import { localizarFilialBh, limparFrotaFilial, contarFrotaFilial } from '../src/services/limpar-filial.js';

function arg(nome) {
  const hit = process.argv.find((a) => a === `--${nome}` || a.startsWith(`--${nome}=`));
  if (!hit) return null;
  if (hit === `--${nome}`) return true;
  return hit.slice(nome.length + 3);
}

async function main() {
  await initDatabase();
  const db = getDb();
  const listar = Boolean(arg('listar'));
  const confirmar = Boolean(arg('confirmar'));
  const filtro = arg('filial');
  const filtroTxt = filtro === true ? '' : String(filtro || '');

  const filiais = await db.prepare(`
    SELECT id, nome, codigo, ativo FROM filiais ORDER BY nome
  `).all();
  console.log('Filiais:', filiais.map((f) => `${f.id} ${f.codigo} ${f.nome}`).join(' | '));

  if (listar) {
    await closePool();
    return;
  }

  const filial = filtroTxt
    ? await localizarFilialBh(db, filtroTxt)
    : await localizarFilialBh(db);

  const antes = await contarFrotaFilial(db, filial.id);
  console.log(`Alvo: ${filial.nome} (${filial.codigo}) id=${filial.id}`);
  console.log('Antes:', antes);

  if (!confirmar) {
    console.log('Nada foi apagado. Rode de novo com --confirmar para executar.');
    await closePool();
    return;
  }

  const resultado = await limparFrotaFilial(db, filial.id);
  console.log('Depois:', resultado.depois);
  console.log(`OK: frota de ${filial.nome} limpa. Perfil/login mantidos.`);
  await closePool();
}

main().catch(async (err) => {
  console.error(err.message || err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
