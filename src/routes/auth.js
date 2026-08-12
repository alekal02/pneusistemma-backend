import { Router } from 'express';
import { getDb } from '../database.js';
import {
  verificarSenha,
  hashSenha,
  emitirToken,
  usuarioPublico,
  requireAuth,
  carregarUsuario,
} from '../auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const { login, senha } = req.body || {};
  if (!login?.trim() || !senha) {
    return res.status(400).json({ erro: 'Informe login e senha' });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT u.*, f.nome as filial_nome, f.codigo as filial_codigo, f.ativo as filial_ativa
    FROM usuarios u
    LEFT JOIN filiais f ON f.id = u.filial_id
    WHERE lower(u.login) = lower(?) AND u.ativo = 1
  `).get(login.trim());

  if (!row || !verificarSenha(senha, row.senha_hash)) {
    return res.status(401).json({ erro: 'Login ou senha inválidos' });
  }

  if (row.papel === 'filial' || row.papel === 'gerente') {
    if (row.papel === 'filial' && (!row.filial_id || row.filial_ativa === 0)) {
      return res.status(403).json({ erro: 'Filial inativa ou sem vínculo' });
    }
    if (row.papel === 'gerente' && row.filial_id && row.filial_ativa === 0) {
      return res.status(403).json({ erro: 'Filial do gerente está inativa' });
    }
  }

  db.prepare(`
    UPDATE usuarios SET ultimo_login = datetime('now', 'localtime') WHERE id = ?
  `).run(row.id);

  const filial = row.filial_id
    ? { id: row.filial_id, nome: row.filial_nome, codigo: row.filial_codigo }
    : null;

  const token = emitirToken(row);
  res.json({
    token,
    usuario: usuarioPublico({ ...row, ultimo_login: new Date().toISOString() }, filial),
  });
});

router.get('/me', requireAuth, (req, res) => {
  const user = carregarUsuario(req.user.id);
  res.json(usuarioPublico(user, user.filial));
});

router.post('/trocar-senha', requireAuth, (req, res) => {
  const { senha_atual, senha_nova } = req.body || {};
  if (!senha_atual || !senha_nova || senha_nova.length < 4) {
    return res.status(400).json({ erro: 'Informe senha atual e nova senha (mín. 4 caracteres)' });
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!row || !verificarSenha(senha_atual, row.senha_hash)) {
    return res.status(400).json({ erro: 'Senha atual incorreta' });
  }

  db.prepare(`
    UPDATE usuarios SET senha_hash = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(hashSenha(senha_nova), req.user.id);

  res.json({ mensagem: 'Senha alterada com sucesso' });
});

export default router;
