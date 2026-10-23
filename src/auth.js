import { randomUUID } from 'crypto';
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

/** Admin total e presidente não ficam vinculados a uma filial. Isso não concede administração. */
export function papelSemFilial(papel) {
  return papel === 'admin' || papel === 'presidente';
}

/** Somente o admin total. O presidente não herda operação administrativa. */
export function temPrivilegioAdmin(user) {
  return user?.papel === 'admin';
}

export function hashSenha(senha) {
  return bcrypt.hashSync(senha, 10);
}

export function verificarSenha(senha, hash) {
  return bcrypt.compareSync(senha, hash);
}

/**
 * Uma ida ao banco: valida usuário ativo e sessão, e só grava visto_em
 * se o toque anterior já passou do intervalo configurado.
 */
export const SQL_AUTENTICAR_SESSAO = `
WITH alvo AS (
  SELECT
    s.id AS sessao_id,
    s.visto_em AS sessao_visto_em,
    u.id,
    u.login,
    u.papel,
    u.cargo,
    u.whatsapp,
    u.filial_id,
    u.ultimo_login,
    u.ativo,
    f.nome AS filial_nome,
    f.codigo AS filial_codigo
  FROM sessoes_login s
  JOIN usuarios u ON u.id = s.usuario_id AND u.ativo = 1
  LEFT JOIN filiais f ON f.id = u.filial_id
  WHERE s.id = ?
    AND s.usuario_id = ?
    AND s.revogada_em IS NULL
    AND s.expira_em > NOW()
    AND s.visto_em > NOW() - (? * INTERVAL '1 minute')
),
toque AS (
  UPDATE sessoes_login
  SET visto_em = NOW()
  FROM alvo
  WHERE sessoes_login.id = alvo.sessao_id
    AND alvo.sessao_visto_em <= NOW() - (? * INTERVAL '1 minute')
  RETURNING sessoes_login.id
)
SELECT
  alvo.id,
  alvo.login,
  alvo.papel,
  alvo.cargo,
  alvo.whatsapp,
  alvo.filial_id,
  alvo.ultimo_login,
  alvo.ativo,
  alvo.filial_nome,
  alvo.filial_codigo,
  alvo.sessao_id
FROM alvo
LEFT JOIN toque ON toque.id = alvo.sessao_id
`;

export function emitirToken(usuario, sid) {
  if (!sid) {
    throw new Error('Sessão ausente');
  }
  return jwt.sign(
    {
      sub: usuario.id,
      sid,
      login: usuario.login,
      papel: usuario.papel,
      cargo: usuario.cargo || null,
      filial_id: usuario.filial_id ?? null,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function lerPayloadToken(token) {
  try {
    return { ok: true, payload: jwt.verify(token, config.jwtSecret) };
  } catch {
    return { ok: false };
  }
}

/** Token antigo, sem sid, não pode ser renovado nem reaproveitado. */
export function recusaPayload(payload) {
  if (!payload?.sid || payload.sub == null) return 'Sessão expirada ou inválida';
  return null;
}

function montarUsuarioSessao(row) {
  return {
    id: row.id,
    login: row.login,
    papel: row.papel,
    cargo: row.cargo || null,
    whatsapp: row.whatsapp || null,
    filial_id: row.filial_id ?? null,
    ultimo_login: row.ultimo_login || null,
    ativo: row.ativo,
    sessao_id: row.sessao_id,
    filial: row.filial_id
      ? { id: row.filial_id, nome: row.filial_nome, codigo: row.filial_codigo }
      : null,
  };
}

export async function criarSessao(usuarioId, db = getDb()) {
  const sid = randomUUID();
  await db.prepare(`
    INSERT INTO sessoes_login (id, usuario_id, expira_em)
    VALUES (?, ?, NOW() + (? * INTERVAL '1 hour'))
  `).run(sid, usuarioId, config.sessaoDuracaoHoras);
  return sid;
}

export async function autenticarSessao(db, usuarioId, sid) {
  const row = await db.prepare(SQL_AUTENTICAR_SESSAO).get(
    sid,
    usuarioId,
    config.sessaoOciosidadeMin,
    config.sessaoToqueMin,
  );
  if (!row) return null;
  return montarUsuarioSessao(row);
}

export async function revogarSessao(sid, db = getDb()) {
  if (!sid) return;
  await db.prepare(`
    UPDATE sessoes_login
    SET revogada_em = NOW()
    WHERE id = ? AND revogada_em IS NULL
  `).run(sid);
}

export async function revogarSessoesDoUsuario(usuarioId, db = getDb()) {
  await db.prepare(`
    UPDATE sessoes_login
    SET revogada_em = NOW()
    WHERE usuario_id = ? AND revogada_em IS NULL
  `).run(usuarioId);
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

  const lido = lerPayloadToken(token);
  if (!lido.ok) {
    return res.status(401).json({ erro: 'Sessão expirada ou inválida' });
  }
  const recusa = recusaPayload(lido.payload);
  if (recusa) {
    return res.status(401).json({ erro: recusa });
  }

  try {
    const user = await autenticarSessao(getDb(), lido.payload.sub, lido.payload.sid);
    if (!user) return res.status(401).json({ erro: 'Sessão expirada ou inválida' });
    req.sessaoId = user.sessao_id;
    delete user.sessao_id;
    req.user = user;
    const encerraPropriaSessao = req.path === '/logout';
    if (user.papel === 'presidente' && req.method !== 'GET' && req.method !== 'HEAD' && !encerraPropriaSessao) {
      return res.status(403).json({
        erro: 'O painel do presidente é somente consulta. Nenhuma alteração foi gravada.',
        somente_leitura: true,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Admin total — diretoria / TI. O presidente não passa por aqui. */
export function requireAdmin(req, res, next) {
  if (!temPrivilegioAdmin(req.user)) {
    return res.status(403).json({ erro: 'Acesso restrito ao administrador total' });
  }
  next();
}

/** Consulta executiva: presidente (somente leitura) ou administrador. */
export function requireLeituraExecutiva(req, res, next) {
  if (!req.user || !['admin', 'presidente'].includes(req.user.papel)) {
    return res.status(403).json({ erro: 'Acesso restrito à visão executiva' });
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

/**
 * Classificação de compras. Só o usuário reservado, ativo e sem filial.
 * Admin não passa por aqui, mesmo com privilégio administrativo.
 */
export function requirePresidenteReservado(req, res, next) {
  const user = req.user;
  const semFilial = user?.filial_id == null;
  if (user?.papel !== 'presidente' || !ehPresidenteReservado(user) || !semFilial || Number(user?.ativo) !== 1) {
    return res.status(403).json({ erro: 'Acesso restrito ao perfil presidente' });
  }
  next();
}

/** Gerente de unidade ou admin. O presidente não herda este acesso. */
export function requireGerenteOuAdmin(req, res, next) {
  if (!req.user || !(temPrivilegioAdmin(req.user) || req.user.papel === 'gerente')) {
    return res.status(403).json({ erro: 'Acesso restrito a gerentes ou administrador' });
  }
  next();
}

/** Operador não configura chatbot. Só o admin total configura. */
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
 * - presidente: nenhum escopo operacional; o relatório executivo não usa esta função
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

/** Papéis que o gerente pode ver e cuja senha pode redefinir. Admin e presidente ficam de fora. */
export const PAPEIS_GERENCIAVEIS_PELO_GERENTE = ['gerente', 'filial'];

/**
 * Quem pode redefinir a senha de outra conta.
 * Admin altera qualquer uma. Gerente altera só gerente/filial no escopo
 * (sem filial, o escopo continua o da listagem: todas as unidades).
 * Admin e presidente só têm a senha redefinida pelo administrador total,
 * mesmo que o alvo tenha filial_id. Filial e presidente não redefinem terceiros.
 */
export function decidirResetSenha(ator, alvo) {
  if (!ator?.papel) {
    return { permitido: false, status: 401, erro: 'Não autenticado' };
  }
  if (!alvo) {
    return { permitido: false, status: 404, erro: 'Usuário não encontrado' };
  }
  const protegido = alvo.papel === 'admin' || alvo.papel === 'presidente';
  if (ator.papel !== 'admin' && protegido) {
    return {
      permitido: false,
      status: 403,
      erro: 'Somente o administrador total redefine a senha deste acesso',
    };
  }
  if (ator.papel === 'admin') return { permitido: true };
  if (ator.papel !== 'gerente') {
    return { permitido: false, status: 403, erro: 'Acesso restrito a gerentes ou administrador' };
  }
  const escopo = ator.filial_id ? [ator.filial_id] : null;
  if (escopo?.length && !escopo.includes(alvo.filial_id)) {
    return { permitido: false, status: 403, erro: 'Usuário fora do escopo da sua unidade' };
  }
  return { permitido: true };
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
