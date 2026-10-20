import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { getDb } from './database.js';

export const PAPEIS = ['admin', 'gerente', 'filial', 'presidente'];

/** Único usuário que pode ter o papel. A ativação continua no script de migração. */
export const PRESIDENTE_RESERVADO = { id: 34, login: 'presidente' };

export function ehPresidenteReservado(usuario) {
  return Number(usuario?.id) === PRESIDENTE_RESERVADO.id
    && String(usuario?.login || '').toLowerCase() === PRESIDENTE_RESERVADO.login;
}

export const LABELS_PAPEL = {
  admin: 'Admin total',
  gerente: 'Gerente de unidade',
  filial: 'Operador de filial',
  presidente: 'Presidente',
};

/** Admin total e presidente enxergam todas as unidades e não ficam vinculados a uma filial. */
export function papelSemFilial(papel) {
  return papel === 'admin' || papel === 'presidente';
}

/** Presidente conserva as permissões do admin total. */
export function temPrivilegioAdmin(user) {
  return user?.papel === 'admin' || user?.papel === 'presidente';
}

export function hashSenha(senha) {
  return bcrypt.hashSync(senha, 10);
}

export function verificarSenha(senha, hash) {
  return bcrypt.compareSync(senha, hash);
}

export function emitirToken(usuario) {
  return jwt.sign(
    {
      sub: usuario.id,
      login: usuario.login,
      papel: usuario.papel,
      cargo: usuario.cargo || null,
      filial_id: usuario.filial_id ?? null,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function usuarioPublico(row, filial = null) {
  return {
    id: row.id,
    login: row.login,
    papel: row.papel,
    cargo: row.cargo || null,
    papel_label: LABELS_PAPEL[row.papel] || row.papel,
    whatsapp: row.whatsapp || null,
    filial_id: row.filial_id ?? null,
    ultimo_login: row.ultimo_login || null,
    filial: filial
      ? { id: filial.id, nome: filial.nome, codigo: filial.codigo }
      : null,
  };
}

export async function carregarUsuario(id) {
  const db = getDb();
  const row = await db.prepare(`
    SELECT u.*, f.nome as filial_nome, f.codigo as filial_codigo
    FROM usuarios u
    LEFT JOIN filiais f ON f.id = u.filial_id
    WHERE u.id = ? AND u.ativo = 1
  `).get(id);
  if (!row) return null;
  return {
    ...row,
    filial: row.filial_id
      ? { id: row.filial_id, nome: row.filial_nome, codigo: row.filial_codigo }
      : null,
  };
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ erro: 'Não autenticado' });
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ erro: 'Sessão expirada ou inválida' });
  }

  try {
    const user = await carregarUsuario(payload.sub);
    if (!user) return res.status(401).json({ erro: 'Usuário inválido ou inativo' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Admin total e presidente — diretoria / TI */
export function requireAdmin(req, res, next) {
  if (!temPrivilegioAdmin(req.user)) {
    return res.status(403).json({ erro: 'Acesso restrito ao administrador total' });
  }
  next();
}

/**
 * Saúde e desgaste, PDF executivo e o futuro planejamento de compras.
 * Admin, gerente e filial não passam, mesmo com URL direta.
 */
export function requirePresidente(req, res, next) {
  if (req.user?.papel !== 'presidente') {
    return res.status(403).json({ erro: 'Acesso restrito ao perfil presidente' });
  }
  next();
}

/** Gerente de unidade, admin ou presidente — visão de filiais / compras */
export function requireGerenteOuAdmin(req, res, next) {
  if (!req.user || !(temPrivilegioAdmin(req.user) || req.user.papel === 'gerente')) {
    return res.status(403).json({ erro: 'Acesso restrito a gerentes ou administrador' });
  }
  next();
}

/** Operador não configura chatbot. Admin e presidente configuram. */
export function requireChatbotAcesso(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ erro: 'Não autenticado' });
  }
  if (temPrivilegioAdmin(req.user)) {
    return next();
  }
  return res.status(403).json({ erro: 'Somente o administrador configura o chatbot' });
}

export function requireFilial(req, res, next) {
  if (!req.user || req.user.papel !== 'filial' || !req.user.filial_id) {
    return res.status(403).json({ erro: 'Acesso restrito a usuários de filial' });
  }
  next();
}

export function isAdmin(user) {
  return temPrivilegioAdmin(user);
}

export function isPresidente(user) {
  return user?.papel === 'presidente';
}

export function isGerente(user) {
  return user?.papel === 'gerente';
}

/**
 * Escopo de filiais para listagens:
 * - admin: todas
 * - gerente com filial_id: só a dele
 * - gerente sem filial (ex. compras): todas
 */
export function filiaisEscopoIds(req) {
  if (temPrivilegioAdmin(req.user)) return null; // todas
  if (req.user?.papel === 'gerente') {
    return req.user.filial_id ? [req.user.filial_id] : null;
  }
  if (req.user?.papel === 'filial' && req.user.filial_id) {
    return [req.user.filial_id];
  }
  return [];
}

/** ID da filial no escopo operacional (usuário filial). Admin/gerente não operam frota aqui. */
export function filialScopeId(req) {
  if (req.user?.papel === 'filial') return req.user.filial_id;
  return null;
}

export async function assertVeiculoDaFilial(veiculoId, filialId) {
  const db = getDb();
  const v = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND ativo = 1 AND filial_id = ?
  `).get(veiculoId, filialId);
  return v || null;
}

export async function assertPneuDaFilial(pneuId, filialId, { incluirInativos = false } = {}) {
  const db = getDb();
  const row = await db.prepare(`
    SELECT p.*,
      COALESCE(p.filial_id, v.filial_id) as filial_id,
      v.placa, v.apelido, v.km_atual, v.hr_atual,
      v.tipo as veiculo_tipo, v.layout_pneus
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1
    WHERE p.id = ?
      ${incluirInativos ? '' : 'AND p.ativo = 1'}
      AND COALESCE(p.filial_id, v.filial_id) = ?
  `).get(pneuId, filialId);
  return row || null;
}
