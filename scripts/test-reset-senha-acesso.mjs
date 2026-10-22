/**
 * Autorização de senha e de gestão de usuários.
 * Não abre banco, não cria conta e não fala com o Neon.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PAPEIS_GERENCIAVEIS_PELO_GERENTE,
  decidirResetSenha,
  requireAdmin,
  requireChatbotAcesso,
  requireFilial,
  requireGerenteOuAdmin,
  requireLeituraExecutiva,
} from '../src/auth.js';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');
const usuariosSrc = readFileSync(path.join(raiz, 'usuarios.js'), 'utf8');
const filiaisSrc = readFileSync(path.join(raiz, 'filiais.js'), 'utf8');
const presidenteSrc = readFileSync(path.join(raiz, 'presidente.js'), 'utf8');

function negado(resultado) {
  assert.equal(resultado.permitido, false);
  assert.equal(resultado.status, 403);
}

function permitido(resultado) {
  assert.equal(resultado.permitido, true);
  assert.equal(resultado.status, undefined);
}

function guarda(middleware, papel, extra = {}) {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let passou = false;
  middleware({ user: { papel, ...extra } }, res, () => {
    passou = true;
  });
  return { passou, statusCode: res.statusCode };
}

const presidente = { id: 9, papel: 'presidente', filial_id: null };
const admin = { id: 1, papel: 'admin', filial_id: null };
const gerenteSemFilial = { id: 2, papel: 'gerente', filial_id: null };
const gerenteNorte = { id: 3, papel: 'gerente', filial_id: 10 };
const operadorNorte = { id: 4, papel: 'filial', filial_id: 10 };
const operadorSul = { id: 5, papel: 'filial', filial_id: 20 };
const gerenteSul = { id: 6, papel: 'gerente', filial_id: 20 };

negado(decidirResetSenha(gerenteSemFilial, presidente));
negado(decidirResetSenha(gerenteSemFilial, { ...presidente, filial_id: 10 }));
negado(decidirResetSenha(gerenteSemFilial, admin));
negado(decidirResetSenha(gerenteNorte, presidente));
negado(decidirResetSenha(gerenteNorte, { ...presidente, filial_id: 10 }));
negado(decidirResetSenha(gerenteNorte, admin));
negado(decidirResetSenha(gerenteNorte, { ...admin, filial_id: 10 }));
negado(decidirResetSenha(operadorNorte, presidente));
negado(decidirResetSenha(operadorNorte, admin));
negado(decidirResetSenha(presidente, operadorNorte));

permitido(decidirResetSenha(admin, presidente));
permitido(decidirResetSenha(admin, admin));
permitido(decidirResetSenha(admin, gerenteSemFilial));
permitido(decidirResetSenha(admin, gerenteNorte));
permitido(decidirResetSenha(admin, operadorNorte));

permitido(decidirResetSenha(gerenteSemFilial, operadorNorte));
permitido(decidirResetSenha(gerenteSemFilial, gerenteNorte));
permitido(decidirResetSenha(gerenteNorte, operadorNorte));
permitido(decidirResetSenha(gerenteNorte, { ...gerenteNorte, id: 30 }));
negado(decidirResetSenha(gerenteNorte, operadorSul));
negado(decidirResetSenha(gerenteNorte, gerenteSul));

assert.equal(guarda(requireAdmin, 'gerente').passou, false);
assert.equal(guarda(requireAdmin, 'gerente').statusCode, 403);
assert.equal(guarda(requireAdmin, 'filial').passou, false);
assert.equal(guarda(requireAdmin, 'presidente').passou, false);
assert.equal(guarda(requireAdmin, 'admin').passou, true);

assert.equal(guarda(requireGerenteOuAdmin, 'filial').passou, false);
assert.equal(guarda(requireGerenteOuAdmin, 'presidente').passou, false);
assert.equal(guarda(requireGerenteOuAdmin, 'gerente').passou, true);
assert.equal(guarda(requireGerenteOuAdmin, 'admin').passou, true);

assert.equal(guarda(requireFilial, 'presidente').passou, false);
assert.equal(guarda(requireFilial, 'admin').passou, false);
assert.equal(guarda(requireFilial, 'gerente').passou, false);
assert.equal(guarda(requireFilial, 'filial', { filial_id: 10 }).passou, true);

assert.equal(guarda(requireChatbotAcesso, 'presidente').passou, false);
assert.equal(guarda(requireChatbotAcesso, 'gerente').passou, false);
assert.equal(guarda(requireChatbotAcesso, 'admin').passou, true);

assert.equal(guarda(requireLeituraExecutiva, 'presidente').passou, true);
assert.equal(guarda(requireLeituraExecutiva, 'admin').passou, true);
assert.equal(guarda(requireLeituraExecutiva, 'gerente').passou, false);
assert.equal(guarda(requireLeituraExecutiva, 'filial').passou, false);

assert.deepEqual(PAPEIS_GERENCIAVEIS_PELO_GERENTE, ['gerente', 'filial']);
assert.equal(PAPEIS_GERENCIAVEIS_PELO_GERENTE.includes('admin'), false);
assert.equal(PAPEIS_GERENCIAVEIS_PELO_GERENTE.includes('presidente'), false);
assert.match(usuariosSrc, /decidirResetSenha\(req\.user, alvo\)/);
assert.match(usuariosSrc, /PAPEIS_GERENCIAVEIS_PELO_GERENTE/);
assert.match(usuariosSrc, /router\.patch\('\/:id', requireAdmin/);
assert.match(usuariosSrc, /router\.post\('\/', requireAdmin/);

assert.match(filiaisSrc, /papel = 'filial'/);
assert.match(presidenteSrc, /requireLeituraExecutiva/);
assert.match(presidenteSrc, /req\.method !== 'GET' && req\.method !== 'HEAD'/);
assert.doesNotMatch(presidenteSrc, /router\.(post|put|patch|delete)\(/);

console.log('reset de senha: ok');
