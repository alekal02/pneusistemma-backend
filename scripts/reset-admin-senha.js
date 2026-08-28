/**
 * Redefine a senha do usuário admin no PostgreSQL.
 * Uso (na pasta backend):
 *   $env:DATABASE_URL="postgresql://..."
 *   $env:ADMIN_PASSWORD="nova-senha"
 *   $env:ADMIN_USER="admin"   # opcional
 *   node scripts/reset-admin-senha.js
 */
import bcrypt from 'bcryptjs';
import { createPool, getDb, closePool } from '../src/pg-db.js';

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const senha = process.env.ADMIN_PASSWORD;
const login = String(process.env.ADMIN_USER || 'admin').trim() || 'admin';

if (!databaseUrl) {
  console.error('Defina DATABASE_URL');
  process.exit(1);
}
if (!senha || senha.length < 4) {
  console.error('Defina ADMIN_PASSWORD (mín. 4 caracteres)');
  process.exit(1);
}

createPool(databaseUrl);
const db = getDb();

const admin = await db.prepare(`
  SELECT id, login, ativo FROM usuarios WHERE papel = 'admin' ORDER BY id LIMIT 1
`).get();

if (!admin) {
  const hash = bcrypt.hashSync(senha, 10);
  await db.prepare(`
    INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
    VALUES (?, ?, 'admin', 'admin', NULL, 1)
  `).run(login, hash);
  console.log(`Admin criado: ${login}`);
} else {
  const hash = bcrypt.hashSync(senha, 10);
  await db.prepare(`
    UPDATE usuarios SET
      senha_hash = ?,
      login = ?,
      ativo = 1,
      updated_at = NOW()
    WHERE id = ?
  `).run(hash, login, admin.id);
  console.log(`Senha redefinida. Login: ${login} (id ${admin.id}, ativo=1)`);
}

await closePool();
