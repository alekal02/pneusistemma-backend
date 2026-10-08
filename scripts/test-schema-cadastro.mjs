/**
 * Schema sem cadastro_completo e backfill que não regrava Truckado.
 * Sem banco: node scripts/test-schema-cadastro.mjs
 */
import assert from 'node:assert/strict';
import { backfillTipoCodigoVeiculos, codigoTipoExato } from '../src/equipamento-tipos.js';
import {
  filtroCadastroCompleto,
  limparCacheColunas,
  projecaoCadastroCompleto,
} from '../src/schema-colunas.js';
import { clausulaTiposNotificacao, TIPOS_NOTIFICACAO_WHATSAPP } from '../src/database.js';
import fs from 'node:fs';

function dbColuna(existe) {
  return {
    prepare() {
      return {
        async get() {
          return existe ? { ok: 1 } : undefined;
        },
      };
    },
  };
}

limparCacheColunas();
assert.equal(await filtroCadastroCompleto(dbColuna(false), 'veiculos', 'v.cadastro_completo'), 'TRUE');
assert.equal(await projecaoCadastroCompleto(dbColuna(false), 'pneus'), '1 AS cadastro_completo');

limparCacheColunas();
assert.equal(
  await filtroCadastroCompleto(dbColuna(true), 'veiculos', 'v.cadastro_completo'),
  'COALESCE(v.cadastro_completo, 1) = 1',
);
assert.equal(await projecaoCadastroCompleto(dbColuna(true), 'veiculos'), 'cadastro_completo');

assert.equal(codigoTipoExato('Truckado'), null);
assert.equal(codigoTipoExato('Toco / Mini'), 'toco_mini');
assert.equal(codigoTipoExato('truck'), 'truck_tracao');

const updates = [];
const dbBackfill = {
  prepare(sql) {
    if (String(sql).includes('SELECT')) {
      return {
        async all() {
          return [
            { id: 7, tipo: 'Truckado' },
            { id: 8, tipo: 'Toco / Mini' },
          ];
        },
      };
    }
    return {
      async run(codigo, id) {
        updates.push({ codigo, id });
        return { changes: 1 };
      },
    };
  },
};
const n = await backfillTipoCodigoVeiculos(dbBackfill);
assert.equal(n, 1);
assert.deepEqual(updates, [{ codigo: 'toco_mini', id: 8 }]);

const clausula = clausulaTiposNotificacao(['menu', 'link_veiculo', 'relatorio_semanal']);
for (const tipo of ['menu', 'link_veiculo', 'relatorio_semanal', 'alerta_critico', 'alerta_desgaste', 'alerta_posicao']) {
  assert.ok(clausula.includes(`'${tipo}'`), tipo);
}
assert.deepEqual(
  TIPOS_NOTIFICACAO_WHATSAPP.includes('menu'),
  true,
);
const dbSrc = fs.readFileSync(new URL('../src/database.js', import.meta.url), 'utf8');
assert.equal(dbSrc.includes('DELETE FROM notificacoes_whatsapp'), false);
assert.equal(dbSrc.includes('UPDATE usuarios SET senha_hash'), false);
assert.equal(dbSrc.includes('DELETE FROM medicoes'), false);
assert.equal(dbSrc.includes('DELETE FROM movimentacoes'), false);
assert.equal(dbSrc.includes('DELETE FROM pneus'), false);
assert.match(dbSrc, /DROP CONSTRAINT IF EXISTS notificacoes_whatsapp_tipo_check/);
assert.equal((dbSrc.match(/DROP CONSTRAINT IF EXISTS notificacoes_whatsapp_tipo_check/g) || []).length, 1);

console.log('schema cadastro ok');
