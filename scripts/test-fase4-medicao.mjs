/**
 * Fase 4 — motor de medição por perfil do catálogo.
 * Sem banco: node scripts/test-fase4-medicao.mjs
 */
import assert from 'node:assert/strict';
import { resolverTipoEquipamento } from '../src/equipamento-tipos.js';
import { classificarSulco, getLimitesPorPerfil, limitesDoVeiculo } from '../src/limites.js';
import { diagnosticarPerfil } from '../src/diagnostico.js';
import { especificacaoMedicao, prepararMedicao } from '../src/medicao-perfil.js';

function spec(tipo) {
  return especificacaoMedicao(tipo);
}

const caminhao = spec('Truck / Tração');
const compactador = spec('Compactador');
const toco = spec('Toco / Mini');
const trator = spec('Trator');
const mini = spec('Mini carregadeira');
const giro = spec('Giro zero');

assert.equal(caminhao.codigo, 'caminhao');
assert.equal(caminhao.unidade, 'km');
assert.equal(caminhao.sulco, 'quatro_pontos');
assert.equal(caminhao.diagnostico_desgaste, true);
assert.equal(caminhao.inspecao_danos, false);

assert.equal(compactador.codigo, 'caminhao');
assert.equal(compactador.unidade, 'km');
assert.equal(compactador.sulco, 'quatro_pontos');
assert.equal(toco.codigo, 'caminhao');
assert.equal(spec('Utilitário / Varredeira').unidade, 'km');

assert.equal(trator.codigo, 'trator');
assert.equal(trator.unidade, 'horas');
assert.equal(trator.sulco, 'quatro_pontos');
assert.equal(trator.diagnostico_desgaste, true);
assert.equal(trator.inspecao_danos, false);

assert.equal(mini.codigo, 'industrial');
assert.equal(giro.codigo, 'industrial');
assert.equal(mini.unidade, 'horas');
assert.equal(giro.unidade, 'horas');
assert.equal(mini.sulco, 'simples');
assert.equal(giro.sulco, 'simples');
assert.equal(mini.diagnostico_desgaste, false);
assert.equal(giro.inspecao_danos, true);
assert.deepEqual(mini.inspecoes.map((i) => i.codigo), [
  'corte', 'dano_lateral', 'desgaste_irregular', 'outro',
]);
assert.equal(resolverTipoEquipamento('mini_carregadeira').perfil_medicao, 'industrial');
assert.equal(resolverTipoEquipamento('giro_zero').perfil_medicao, 'industrial');

assert.equal(especificacaoMedicao(null, 'truck_10').codigo, 'caminhao');
assert.equal(especificacaoMedicao(null, 'truck_10').unidade, 'km');
assert.equal(especificacaoMedicao(null, 'trator_4').codigo, 'trator');
assert.equal(especificacaoMedicao(null, 'trator_4').unidade, 'horas');

const sulcos = {
  sulco_externo: 8,
  sulco_central: 8,
  sulco_interno: 7,
  sulco_auxiliar: 8,
  km_veiculo: 12000,
  hr_veiculo: 400,
};

const medCaminhao = prepararMedicao(sulcos, {
  tipo: 'Compactador',
  anterior: { sulco_externo: 10, sulco_central: 10, sulco_interno: 10, sulco_auxiliar: 10, km_veiculo: 10000 },
});
assert.equal(medCaminhao.erro, undefined);
assert.equal(medCaminhao.km_veiculo, 12000);
assert.equal(medCaminhao.hr_veiculo, null);
assert.equal(medCaminhao.sulco_mm, null);
assert.equal(medCaminhao.inspecao_danos, null);
assert.equal(medCaminhao.sulco_externo, 8);
assert.equal(medCaminhao.desgaste_mm_km, 0.0015);
assert.equal(medCaminhao.desgaste_mm_hora, null);
assert.ok(medCaminhao.diagnostico.codigo);
assert.notEqual(medCaminhao.status_sulco, null);

const medTrator = prepararMedicao({
  ...sulcos,
  hr_veiculo: 200,
}, {
  tipo: 'Trator',
  anterior: { sulco_externo: 12, sulco_central: 12, sulco_interno: 12, sulco_auxiliar: 12, hr_veiculo: 100, km_veiculo: 999 },
});
assert.equal(medTrator.km_veiculo, null);
assert.equal(medTrator.hr_veiculo, 200);
assert.equal(medTrator.sulco_interno, 7);
assert.equal(medTrator.desgaste_mm_km, null);
assert.equal(medTrator.desgaste_mm_hora, 0.05);
assert.equal(medTrator.status_sulco, 'critico');
assert.ok(medTrator.diagnostico.codigo);

const medMini = prepararMedicao({
  sulco_externo: 2,
  sulco_central: 9,
  sulco_interno: 3,
  sulco_auxiliar: 8,
  km_veiculo: 5000,
  hr_veiculo: 80,
  sulco_mm: 6,
  inspecao_danos: ['corte', 'dano lateral', 'desgaste irregular', 'outro'],
}, {
  tipo: 'Mini carregadeira',
  anterior: { sulco_mm: 8, hr_veiculo: 40, km_veiculo: 1000 },
});
assert.equal(medMini.km_veiculo, null);
assert.equal(medMini.hr_veiculo, 80);
assert.equal(medMini.sulco_externo, null);
assert.equal(medMini.sulco_central, null);
assert.equal(medMini.sulco_interno, null);
assert.equal(medMini.sulco_auxiliar, null);
assert.equal(medMini.sulco_mm, 6);
assert.equal(medMini.marcacao_json, null);
assert.deepEqual(medMini.inspecao_danos.itens, ['corte', 'dano_lateral', 'desgaste_irregular', 'outro']);
assert.equal(medMini.diagnostico.codigo, null);
assert.equal(medMini.acao.codigo, 'corte');
assert.equal(medMini.acao.rodizio_sugestao, null);
assert.equal(medMini.status_sulco, null);
assert.equal(medMini.desgaste_mm_km, null);
assert.equal(medMini.desgaste_mm_hora, 0.05);

const medGiro = prepararMedicao({
  hr_veiculo: 10,
  sulco_mm: 1,
  inspecao_danos: { itens: ['outro'], outro: 'rasgo na banda' },
}, { tipo: 'giro_zero' });
assert.equal(medGiro.status_sulco, null);
assert.equal(medGiro.diagnostico.codigo, null);
assert.equal(medGiro.inspecao_danos.outro, 'rasgo na banda');
assert.notEqual(medGiro.status_sulco, 'critico');

const legado = prepararMedicao({
  sulco_externo: 11,
  sulco_central: 9,
  hr_veiculo: 15,
}, { tipo: 'Giro zero' });
assert.equal(legado.sulco_mm, 9);
assert.equal(legado.sulco_externo, null);
assert.equal(legado.status_sulco, null);

assert.equal(prepararMedicao({ hr_veiculo: 10 }, { tipo: 'Mini carregadeira' }).erro, 'Informe o sulco');
assert.equal(
  prepararMedicao({ sulco_mm: 5, hr_veiculo: 10, inspecao_danos: ['furo'] }, { tipo: 'Mini carregadeira' }).erro,
  'Inspeção inválida: furo',
);

assert.equal(getLimitesPorPerfil('industrial').sulco_critico_mm, null);
assert.equal(classificarSulco(1, limitesDoVeiculo({ tipo: 'Mini carregadeira' })), null);
assert.equal(classificarSulco(1, limitesDoVeiculo({ tipo: 'Giro zero' })), null);
assert.equal(classificarSulco(1, {
  perfil: 'industrial',
  sulco_critico_mm: 2,
  sulco_alerta_mm: 5,
}), 'critico');

const irregular = {
  tipo: 'Mini carregadeira',
  sulco_externo: 2,
  sulco_central: 14,
  sulco_interno: 3,
  sulco_auxiliar: 12,
};
assert.equal(diagnosticarPerfil(irregular, 1).codigo, null);
assert.equal(diagnosticarPerfil({
  sulco_externo: 10,
  sulco_central: 10,
  sulco_interno: 10,
  sulco_auxiliar: 10,
}, 1, { tipo: 'Truck / Tração' }).codigo, 'ok');
assert.equal(classificarSulco(2, limitesDoVeiculo({ tipo: 'Truck / Tração' })), 'critico');
assert.equal(classificarSulco(12, limitesDoVeiculo({ tipo: 'Trator' })), 'alerta');

console.log('fase 4 ok');
