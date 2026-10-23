import { Router } from 'express';
import { getDb } from '../database.js';
import {
  verificarSenha,
  hashSenha,
  emitirToken,
  usuarioPublico,
  requireAuth,
  criarSessao,
  revogarSessao,
  revogarSessoesDoUsuario,
} from '../auth.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  const { login, senha } = req.body || {};
  if (!login?.trim() || !senha) {
    return res.status(400).json({ erro: 'Informe login e senha' });
  }

  try {
    const db = getDb();
    const row = await db.prepare(`
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

    await db.prepare(`
      UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?
    `).run(row.id);

    const filial = row.filial_id
      ? { id: row.filial_id, nome: row.filial_nome, codigo: row.filial_codigo }
      : null;

    const sid = await criarSessao(row.id);
    const token = emitirToken(row, sid);
    res.json({
      token,
      usuario: usuarioPublico({ ...row, ultimo_login: new Date().toISOString() }, filial),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json(usuarioPublico(req.user, req.user.filial));
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await revogarSessao(req.sessaoId);
    res.json({ mensagem: 'Sessão encerrada' });
  } catch (err) {
    next(err);
  }
});

router.post('/trocar-senha', requireAuth, async (req, res, next) => {
  const { senha_atual, senha_nova } = req.body || {};
  if (!senha_atual || !senha_nova || senha_nova.length < 4) {
    return res.status(400).json({ erro: 'Informe senha atual e nova senha (mín. 4 caracteres)' });
  }

  try {
    const db = getDb();
    const row = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
    if (!row || !verificarSenha(senha_atual, row.senha_hash)) {
      return res.status(400).json({ erro: 'Senha atual incorreta' });
    }

    await db.transaction(async () => {
      await db.prepare(`
        UPDATE usuarios SET senha_hash = ?, updated_at = NOW()
        WHERE id = ?
      `).run(hashSenha(senha_nova), req.user.id);
      await revogarSessoesDoUsuario(req.user.id);
    });

    res.json({ mensagem: 'Senha alterada. Entre novamente.' });
  } catch (err) {
    next(err);
  }
});

export default router;
