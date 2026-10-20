import { Router } from 'express';
import { getDb } from '../database.js';
import {
  requireAuth,
  requireAdmin,
  requireGerenteOuAdmin,
  hashSenha,
  usuarioPublico,
  LABELS_PAPEL,
  PAPEIS,
  filiaisEscopoIds,
  papelSemFilial,
  ehPresidenteReservado,
} from '../auth.js';

const router = Router();

function cargoPadrao(papel) {
  if (papel === 'admin') return 'admin';
  if (papel === 'presidente') return 'presidente';
  if (papel === 'gerente') return 'gerente_filial';
  return 'funcionario';
}

router.use(requireAuth);

function mapUsuario(row) {
  return {
    id: row.id,
    login: row.login,
    papel: row.papel,
    papel_label: LABELS_PAPEL[row.papel] || row.papel,
    cargo: row.cargo || null,
    whatsapp: row.whatsapp || null,
    ativo: !!row.ativo,
    filial_id: row.filial_id ?? null,
    filial_nome: row.filial_nome || null,
    filial_codigo: row.filial_codigo || null,
    ultimo_login: row.ultimo_login || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

/** Lista usuários — admin vê todos; gerente vê operadores da(s) sua(s) filial(is) */
router.get('/', requireGerenteOuAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const escopo = filiaisEscopoIds(req);
    let sql = `
    SELECT u.id, u.login, u.papel, u.cargo, u.whatsapp, u.ativo, u.filial_id,
      u.ultimo_login, u.created_at, u.updated_at,
      f.nome as filial_nome, f.codigo as filial_codigo
    FROM usuarios u
    LEFT JOIN filiais f ON f.id = u.filial_id
    WHERE 1=1
  `;
    const params = [];

    if (req.user.papel === 'gerente') {
      // Gerente não vê admin total; vê gerentes/operadores no escopo
      sql += ` AND u.papel IN ('gerente', 'filial')`;
      if (escopo?.length) {
        sql += ` AND u.filial_id IN (${escopo.map(() => '?').join(',')})`;
        params.push(...escopo);
      }
    }

    sql += ` ORDER BY
    CASE u.papel WHEN 'presidente' THEN 0 WHEN 'admin' THEN 1 WHEN 'gerente' THEN 2 ELSE 3 END,
    f.nome, u.login`;

    const rows = await db.prepare(sql).all(...params);
    res.json({
      usuarios: rows.map(mapUsuario),
      papeis: PAPEIS
        .filter((p) => p !== 'presidente')
        .map((p) => ({ codigo: p, label: LABELS_PAPEL[p] })),
    });
  } catch (err) {
    next(err);
  }
});

/** Admin cria usuário */
router.post('/', requireAdmin, async (req, res, next) => {
  const { login, senha, papel, cargo, filial_id, whatsapp } = req.body || {};
  if (!login?.trim() || !senha || senha.length < 4) {
    return res.status(400).json({ erro: 'Login e senha (mín. 4 caracteres) são obrigatórios' });
  }
  const papelFinal = papel || 'filial';
  if (papelFinal === 'presidente') {
    return res.status(403).json({ erro: 'Não é permitido criar usuário com o papel presidente' });
  }
  if (!PAPEIS.includes(papelFinal)) {
    return res.status(400).json({ erro: `Papel inválido. Use: ${PAPEIS.filter((p) => p !== 'presidente').join(', ')}` });
  }
  if (papelFinal === 'filial' && !filial_id) {
    return res.status(400).json({ erro: 'Operador de filial precisa de filial_id' });
  }
  if (papelSemFilial(papelFinal) && filial_id) {
    return res.status(400).json({ erro: 'Admin total e presidente não ficam vinculados a uma filial' });
  }

  const db = getDb();
  try {
    const result = await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, whatsapp, ativo)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      login.trim().toLowerCase(),
      hashSenha(senha),
      papelFinal,
      cargo?.trim() || cargoPadrao(papelFinal),
      papelSemFilial(papelFinal) ? null : (filial_id || null),
      whatsapp?.replace(/\D/g, '') || null
    );
    const row = await db.prepare(`
      SELECT u.*, f.nome as filial_nome, f.codigo as filial_codigo
      FROM usuarios u LEFT JOIN filiais f ON f.id = u.filial_id WHERE u.id = ?
    `).get(result.lastInsertRowid);
    res.status(201).json({
      mensagem: `Usuário ${row.login} criado`,
      usuario: mapUsuario(row),
      // Senha só é devolvida no momento da criação (não fica armazenada em texto)
      senha_provisoria: senha,
    });
  } catch (err) {
    if (err.code === '23505' || String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Login já existe' });
    }
    next(err);
  }
});

/** Reset de senha — admin qualquer; gerente só operadores da sua filial */
router.post('/:id/reset-senha', requireGerenteOuAdmin, async (req, res, next) => {
  const { senha } = req.body || {};
  if (!senha || senha.length < 4) {
    return res.status(400).json({ erro: 'Informe a nova senha (mín. 4 caracteres)' });
  }

  try {
    const db = getDb();
    const alvo = await db.prepare(`
      SELECT u.*, f.nome as filial_nome FROM usuarios u
      LEFT JOIN filiais f ON f.id = u.filial_id WHERE u.id = ?
    `).get(req.params.id);
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    if (req.user.papel === 'gerente') {
      if (alvo.papel === 'admin' || alvo.papel === 'presidente') {
        return res.status(403).json({ erro: 'Gerente não pode alterar senha do admin total nem do presidente' });
      }
      const escopo = filiaisEscopoIds(req);
      if (escopo?.length && !escopo.includes(alvo.filial_id)) {
        return res.status(403).json({ erro: 'Usuário fora do escopo da sua unidade' });
      }
    }

    await db.prepare(`
      UPDATE usuarios SET senha_hash = ?, updated_at = NOW()
      WHERE id = ?
    `).run(hashSenha(senha), alvo.id);

    res.json({
      mensagem: `Senha de ${alvo.login} redefinida`,
      login: alvo.login,
      // Devolve só neste response — senhas nunca ficam em texto no banco
      senha_provisoria: senha,
    });
  } catch (err) {
    next(err);
  }
});

/** Ativar / desativar / alterar papel e filial */
router.patch('/:id', requireAdmin, async (req, res, next) => {
  const { ativo, cargo, whatsapp, papel, filial_id } = req.body || {};
  try {
    const db = getDb();
    const alvo = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    if (Number(alvo.id) === Number(req.user.id) && ativo === false) {
      return res.status(400).json({ erro: 'Você não pode desativar a si mesmo' });
    }

    const papelFinal = papel != null ? papel : alvo.papel;
    if (!PAPEIS.includes(papelFinal)) {
      return res.status(400).json({ erro: 'Papel inválido' });
    }
    if (papel != null && papelFinal !== alvo.papel) {
      if (papelFinal === 'presidente' || (ehPresidenteReservado(alvo) && alvo.papel === 'presidente')) {
        return res.status(403).json({
          erro: 'O papel presidente é exclusivo do usuário presidente e não pode ser atribuído nem alterado por aqui',
        });
      }
    }

    let filialFinal = alvo.filial_id;
    if (filial_id !== undefined) {
      filialFinal = filial_id === null || filial_id === '' ? null : Number(filial_id);
    }
    if (papelSemFilial(papelFinal)) {
      filialFinal = null;
    }
    if (papelFinal === 'filial' && !filialFinal) {
      return res.status(400).json({ erro: 'Operador de filial precisa de uma filial' });
    }

    const cargoFinal = cargo != null
      ? (String(cargo).trim() || null)
      : (papel != null ? cargoPadrao(papelFinal) : alvo.cargo);

    await db.prepare(`
      UPDATE usuarios SET
        ativo = COALESCE(?, ativo),
        cargo = ?,
        whatsapp = COALESCE(?, whatsapp),
        papel = ?,
        filial_id = ?,
        updated_at = NOW()
      WHERE id = ?
    `).run(
      ativo == null ? null : (ativo ? 1 : 0),
      cargoFinal,
      whatsapp != null ? String(whatsapp).replace(/\D/g, '') || null : null,
      papelFinal,
      filialFinal,
      alvo.id
    );

    const row = await db.prepare(`
      SELECT u.*, f.nome as filial_nome, f.codigo as filial_codigo
      FROM usuarios u LEFT JOIN filiais f ON f.id = u.filial_id WHERE u.id = ?
    `).get(alvo.id);

    res.json({ mensagem: 'Usuário atualizado', usuario: mapUsuario(row) });
  } catch (err) {
    next(err);
  }
});

export default router;
