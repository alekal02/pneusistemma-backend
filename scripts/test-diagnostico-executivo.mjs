/**
 * Regras do diagnóstico executivo. Sem banco.
 * node scripts/test-diagnostico-executivo.mjs
 */
import assert from 'node:assert/strict';
import {
  CORTES_EXECUTIVOS,
  classificarVeiculoExecutivo,
  ehMatriz,
  montarDiagnosticoExecutivo,
} from '../src/services/diagnostico-executivo.js';

const AGORA = new Date('2026-10-22T12:00:00-03:00');
const POS_TOCO = ['1E', '1D', '2EE', '2EI', '2DI', '2DE'];

assert.equal(CORTES_EXECUTIVOS.min_veiculos_criticos, 2);
assert.equal(CORTES_EXECUTIVOS.pct_criticos, 20);
assert.equal(CORTES_EXECUTIVOS.pct_sem_dados_nao_avaliada, 50);
assert.equal(CORTES_EXECUTIVOS.pct_sem_dados_atencao, 20);
assert.equal(CORTES_EXECUTIVOS.pct_vencida_atencao, 50);
assert.equal(ehMatriz('matriz'), true);
assert.equal(ehMatriz('0101'), false);

function sulco(mm, extra = {}) {
  return {
    sulco_externo: mm,
    sulco_central: mm,
    sulco_interno: mm,
    sulco_auxiliar: mm,
    data_medicao: '2026-10-22',
    ...extra,
  };
}

function pneu(posicao, mm, extra = {}) {
  return {
    id: extra.id || posicao,
    veiculo_id: extra.veiculo_id,
    filial_id: extra.filial_id ?? 1,
    posicao,
    numero_fogo: extra.numero_fogo || `F-${posicao}`,
    ...sulco(mm, extra),
  };
}

function veiculo(id, extra = {}) {
  return {
    id,
    placa: extra.placa || `AAA${id}`,
    apelido: extra.placa || `AAA${id}`,
    tipo: 'Toco / Mini',
    layout_pneus: 'toco_6',
    cadastro_completo: 1,
    dia_medicao: 4,
    filial_id: extra.filial_id ?? 1,
    ...extra,
  };
}

function jogoOk(veiculoId, filialId = 1) {
  return POS_TOCO.map((pos) => pneu(pos, 12, { veiculo_id: veiculoId, filial_id: filialId }));
}

function filialDe(veiculos, pneus, filial = { id: 1, nome: 'Unaí', codigo: '0107', dia_medicao: 4 }, extra = {}) {
  return montarDiagnosticoExecutivo({
    filiais: [filial],
    veiculos,
    pneus,
    agora: AGORA,
    ...extra,
  }).filiais[0];
}

const vazio = classificarVeiculoExecutivo(veiculo(1, { placa: 'SEM1000' }), [], { diaFilial: 4, agora: AGORA });
assert.equal(vazio.classe, 'sem_dados');
assert.equal(vazio.pneus.some((p) => p.kpi === 'critico'), false);
assert.equal(vazio.posicoes_vazias.length, 6);

const parcial = classificarVeiculoExecutivo(
  veiculo(2, { placa: 'CRT3MM1' }),
  [pneu('1E', 3, {
    veiculo_id: 2,
    numero_fogo: 'F-CRIT',
    sulco_central: null,
    sulco_interno: null,
    sulco_auxiliar: null,
    data_medicao: '2026-10-19',
  })],
  { diaFilial: 4, agora: AGORA },
);
assert.equal(parcial.classe, 'critico');
assert.equal(parcial.pneus[0].sulco_incompleto, true);
assert.equal(parcial.pneus[0].menor_sulco, 3);
assert.equal(parcial.pneus[0].alertas.includes('Sulco incompleto'), true);
assert.equal(parcial.medicao_vencida, false);

const umCritico = filialDe(
  [veiculo(2, { placa: 'CRT3MM1' })],
  [pneu('1E', 3, { veiculo_id: 2, numero_fogo: 'F-CRIT', data_medicao: '2026-10-19' })],
);
assert.equal(umCritico.situacao, 'atencao');
assert.equal(umCritico.com_criticos, 1);
assert.equal(umCritico.justificativa.some((v) => v.pneus.some((p) => p.numero_fogo === 'F-CRIT' && p.kpi === 'critico')), true);

const doisDeCinco = [];
const pneus40 = [];
for (let i = 1; i <= 5; i += 1) {
  doisDeCinco.push(veiculo(i, { placa: `P${i}` }));
  if (i <= 2) {
    pneus40.push(pneu('1E', 3, { veiculo_id: i, numero_fogo: `C${i}` }));
    for (const pos of POS_TOCO.slice(1)) pneus40.push(pneu(pos, 12, { veiculo_id: i }));
  } else {
    pneus40.push(...jogoOk(i));
  }
}
const criticaPequena = filialDe(doisDeCinco, pneus40);
assert.equal(criticaPequena.com_criticos, 2);
assert.equal(criticaPequena.criticos_sobre_diagnosticados_pct, 40);
assert.equal(criticaPequena.situacao, 'critica');

const frota15 = [];
const pneus15 = [];
for (let i = 1; i <= 15; i += 1) {
  frota15.push(veiculo(i, { placa: `G${i}` }));
  if (i <= 2) {
    pneus15.push(pneu('1D', 3, { veiculo_id: i, numero_fogo: `ISO${i}`, data_medicao: '2026-10-19' }));
    for (const pos of POS_TOCO.filter((p) => p !== '1D')) pneus15.push(pneu(pos, 12, { veiculo_id: i }));
  } else if (i <= 14) {
    pneus15.push(pneu('2EI', 6, { veiculo_id: i, numero_fogo: `MON${i}` }));
    for (const pos of POS_TOCO.filter((p) => p !== '2EI')) pneus15.push(pneu(pos, 12, { veiculo_id: i }));
  } else {
    pneus15.push(...jogoOk(i));
  }
}
const atencaoProporcao = filialDe(frota15, pneus15);
assert.equal(atencaoProporcao.com_criticos, 2);
assert.equal(atencaoProporcao.com_monitoramento, 12);
assert.equal(atencaoProporcao.situacao, 'atencao');
assert.equal(atencaoProporcao.justificativa.filter((v) => v.classe === 'critico').length, 2);
assert.equal(
  atencaoProporcao.justificativa.filter((v) => v.classe === 'critico').every((v) => v.pneus.some((p) => p.kpi === 'critico')),
  true,
);

const soMonitor = filialDe(
  [veiculo(1, { placa: 'MON1000' })],
  POS_TOCO.map((pos) => pneu(pos, 8, { veiculo_id: 1, numero_fogo: `M-${pos}` })),
);
assert.equal(soMonitor.situacao, 'atencao');
assert.equal(soMonitor.com_criticos, 0);
assert.equal(soMonitor.com_monitoramento, 1);

const semFrota = filialDe([], []);
assert.equal(semFrota.situacao, 'nao_avaliada');
assert.equal(semFrota.motivo, 'Sem veículo ativo.');

const soSemDados = filialDe(
  [veiculo(1, { placa: 'SEM1' }), veiculo(2, { placa: 'SEM2' })],
  [],
);
assert.equal(soSemDados.situacao, 'nao_avaliada');
assert.equal(soSemDados.com_criticos, 0);
assert.equal(soSemDados.sem_dados, 2);

const maioriaSemDados = filialDe(
  [1, 2, 3, 4, 5, 6].map((id) => veiculo(id, { placa: `X${id}` })),
  [...jogoOk(1), ...jogoOk(2), ...jogoOk(3)],
);
assert.equal(maioriaSemDados.sem_dados, 3);
assert.equal(maioriaSemDados.situacao, 'nao_avaliada');

const controlada = filialDe(
  [1, 2, 3, 4, 5].map((id) => veiculo(id)),
  [1, 2, 3, 4, 5].flatMap((id) => jogoOk(id)),
);
assert.equal(controlada.situacao, 'controlada');
assert.equal(controlada.frota_avaliada_pct, 100);
assert.equal(controlada.veiculos_medicao_vencida, 0);

const dadosVinte = filialDe(
  [1, 2, 3, 4, 5].map((id) => veiculo(id)),
  [1, 2, 3, 4].flatMap((id) => jogoOk(id)),
);
assert.equal(dadosVinte.situacao, 'atencao');
assert.equal(dadosVinte.com_criticos, 0);

const quaseCompleta = filialDe(
  Array.from({ length: 10 }, (_, i) => veiculo(i + 1)),
  Array.from({ length: 9 }, (_, i) => jogoOk(i + 1)).flat(),
);
assert.equal(quaseCompleta.situacao, 'controlada');
assert.equal(quaseCompleta.sem_dados, 1);

const vencidos = [1, 2, 3, 4, 5].map((id) => veiculo(id, { dia_medicao: 3, placa: `V${id}` }));
const pneusVencidos = vencidos.flatMap((v) => POS_TOCO.map((pos) => pneu(pos, 12, {
  veiculo_id: v.id,
  data_medicao: '2026-10-16',
})));
const atencaoPrazo = filialDe(vencidos, pneusVencidos);
assert.equal(atencaoPrazo.sem_risco_critico, 5);
assert.equal(atencaoPrazo.veiculos_medicao_vencida, 5);
assert.equal(atencaoPrazo.situacao, 'atencao');
assert.notEqual(atencaoPrazo.situacao, 'critica');

const noDia = classificarVeiculoExecutivo(
  veiculo(9, { dia_medicao: 4, placa: 'HOJE01' }),
  jogoOk(9).map((p) => ({ ...p, data_medicao: '2026-10-16' })),
  { diaFilial: 4, agora: AGORA },
);
assert.equal(noDia.medicao_vencida, false);
assert.equal(noDia.classe, 'sem_risco');

const estepe = classificarVeiculoExecutivo(
  veiculo(8, { layout_pneus: 'padrao_5', placa: 'EST0001' }),
  ['DD', 'DE', 'TD', 'TE'].map((pos) => pneu(pos, 12, { veiculo_id: 8 })),
  { diaFilial: 4, agora: AGORA },
);
assert.equal(estepe.classe, 'sem_risco');
assert.equal(estepe.avaliado_integral, true);

const matriz = montarDiagnosticoExecutivo({
  filiais: [
    { id: 9, nome: 'Matriz', codigo: 'MATRIZ', dia_medicao: null },
    { id: 1, nome: 'Unaí', codigo: '0107', dia_medicao: 4 },
  ],
  veiculos: [veiculo(1, { filial_id: 9, placa: 'MAT1000' }), veiculo(2, { filial_id: 1, placa: 'UNA1000' })],
  pneus: [pneu('1E', 3, { veiculo_id: 1, filial_id: 9, numero_fogo: 'MAT-CRIT' }), ...jogoOk(2)],
  agora: AGORA,
});
assert.equal(matriz.matriz_fora_da_visao, true);
assert.equal(matriz.filiais.some((f) => f.codigo === 'MATRIZ'), false);
assert.equal(matriz.filiais.length, 1);

const comMatriz = montarDiagnosticoExecutivo({
  filiais: [{ id: 9, nome: 'Matriz', codigo: 'MATRIZ', dia_medicao: null }],
  veiculos: [veiculo(1, { filial_id: 9, placa: 'MAT1000' })],
  pneus: [pneu('1E', 3, { veiculo_id: 1, filial_id: 9 })],
  incluirMatriz: true,
  agora: AGORA,
});
assert.equal(comMatriz.filiais.length, 1);
assert.equal(comMatriz.filiais[0].situacao, 'atencao');

console.log('diagnostico executivo: ok');
