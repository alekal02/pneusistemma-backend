/**
 * Descarta o cache executivo depois que a gravação foi confirmada.
 * Nas rotas HTTP o ouvinte roda no finish: a rota já esperou db.transaction
 * (o COMMIT acontece antes da função resolver) e já enviou o status.
 * Importação em lote usa uma transação e uma resposta, então invalida uma vez.
 * GET, falha e reset de senha não mexem nos indicadores.
 */
import { invalidarIndicadoresExecutivos } from './dashboard-executivo.js';

const METODOS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Id numérico positivo. Qualquer outro valor vira limpeza do cache inteiro. */
export function filialConfiavel(filialId) {
  const id = Number(filialId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function invalidarOperacaoConfirmada(filialId) {
  invalidarIndicadoresExecutivos(filialConfiavel(filialId));
}

export function gravacaoAlteraIndicadores(req) {
  if (!req || !METODOS.has(req.method)) return false;
  const caminho = `${req.path || ''} ${req.originalUrl || req.url || ''}`;
  if (/reset-senha/i.test(caminho)) return false;
  return true;
}

/** Filial ou gerente: a unidade do usuário. Acesso rápido: a unidade do token. Admin: null. */
export function filialDaGravacao(req) {
  const papel = req.user?.papel;
  if (papel === 'filial' || papel === 'gerente') {
    return filialConfiavel(req.user?.filial_id);
  }
  return filialConfiavel(req.acessoRapido?.filial_id);
}

/**
 * O ouvinte roda no finish, quando a rota já preencheu params e o status.
 * filialDe, se existir, também roda nesse momento.
 */
export function invalidarExecutivoAoConfirmar(opcoes = {}) {
  return function invalidarExecutivo(req, res, next) {
    res.on('finish', () => {
      if (!gravacaoAlteraIndicadores(req)) return;
      if (res.statusCode >= 400) return;
      const bruto = typeof opcoes.filialDe === 'function'
        ? opcoes.filialDe(req)
        : filialDaGravacao(req);
      invalidarOperacaoConfirmada(bruto);
    });
    next();
  };
}
