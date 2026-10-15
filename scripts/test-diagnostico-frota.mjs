/**
 * Regras do diagnóstico da frota e o corte de filial.
 * Sem banco: node scripts/test-diagnostico-frota.mjs
 */
import assert from 'node:assert/strict';
import {
  avaliarFrota,
  diagnosticarVeiculo,
  escopoPermite,
  rejeitarFilialForaDoEscopo,
  situacaoMedicao,
} from '../src/services/diagnostico-frota.js';
import { gerarPdfDiagnosticoFrota } from '../src/services/diagnostico-frota-pdf.js';

const AGORA = new Date('2026-10-15T15:00:00-03:00');

function pneu(extra = {}) {
  return {
    id: 1,
    posicao: '1E',
    numero_fogo: '100',
    filial_id: 3,
    cadastro_completo: 1,
    condicao: 'novo',
    tipo_pneu: 'direcional',
    data_medicao: '2026-10-14',
    sulco_externo: 10,
    sulco_central: 10,
    sulco_interno: 10,
    sulco_auxiliar: 10,
    sulco_mm: null,
    ...extra,
  };
}

function veiculo(extra = {}) {
  return {
    id: 10,
    placa: 'ABC1D23',
    tipo: 'Truck / Tração',
    tipo_codigo: 'truck_tracao',
    layout_pneus: 'truck_10',
    dia_medicao: 4,
    cadastro_completo: 1,
    marca: 'Volvo',
    modelo: 'FH',
    filial_id: 3,
    filial_nome: 'Unai',
    filial_codigo: '0107',
    filial_dia: 4,
    pneus: [],
    ...extra,
  };
}

function codigos(diag) {
  return diag.pendencias.filter((p) => p.reprova).map((p) => p.codigo);
}

const semana = situacaoMedicao({ dataMedicao: '2026-10-14', diaVeiculo: 3, diaFilial: null, agora: AGORA });
assert.equal(semana.situacao, 'em_dia');
assert.equal(semana.semana.hoje, '2026-10-15');
assert.equal(semana.semana.iso_dia, 4);

assert.equal(
  situacaoMedicao({ dataMedicao: '2026-10-09', diaVeiculo: 4, diaFilial: null, agora: AGORA }).situacao,
  'hoje',
);
assert.equal(
  situacaoMedicao({ dataMedicao: '2026-10-09', diaVeiculo: 3, diaFilial: null, agora: AGORA }).situacao,
  'atrasada',
);
assert.equal(
  situacaoMedicao({ dataMedicao: '2026-10-09', diaVeiculo: 5, diaFilial: null, agora: AGORA }).situacao,
  'no_prazo',
);
assert.equal(
  situacaoMedicao({ dataMedicao: null, diaVeiculo: null, diaFilial: null, agora: AGORA }).situacao,
  'no_prazo',
);

const completo = veiculo({
  layout_pneus: 'utilitario_4',
  pneus: ['DD', 'DE', 'TD', 'TE'].map((posicao, i) => pneu({
    id: i + 1,
    posicao,
    tipo_pneu: posicao.startsWith('D') ? 'direcional' : 'borrachudo',
  })),
});
const ok = diagnosticarVeiculo(completo, { agora: AGORA });
assert.equal(ok.conforme, true, 'veículo completo e medido nesta semana é conforme');
assert.equal(codigos(ok).length, 0);

const hoje = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  dia_medicao: 4,
  pneus: [pneu({ posicao: 'DD', data_medicao: '2026-10-09', tipo_pneu: 'direcional' })],
}), { agora: AGORA });
assert.equal(hoje.pendencias.some((p) => p.codigo === 'medicao_atrasada'), false);
assert.equal(hoje.pendencias.some((p) => p.codigo === 'sem_medicao' && p.posicao === 'DD'), false);

const atrasado = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  dia_medicao: 3,
  pneus: [pneu({ posicao: 'DD', data_medicao: '2026-10-09', tipo_pneu: 'direcional' })],
}), { agora: AGORA });
const atraso = atrasado.pendencias.find((p) => p.codigo === 'medicao_atrasada' && p.posicao === 'DD');
assert.equal(atraso?.severidade, 'critica');
assert.equal(atraso?.reprova, true);

const nuncaAtrasado = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  dia_medicao: 3,
  pneus: [pneu({ posicao: 'DD', data_medicao: null, tipo_pneu: 'direcional', sulco_externo: null, sulco_central: null, sulco_interno: null, sulco_auxiliar: null })],
}), { agora: AGORA });
assert.equal(nuncaAtrasado.pendencias.some((p) => p.posicao === 'DD' && p.codigo === 'medicao_atrasada'), true);
assert.equal(nuncaAtrasado.pendencias.some((p) => p.posicao === 'DD' && p.codigo === 'sem_medicao'), false);
assert.equal(nuncaAtrasado.pendencias.some((p) => p.posicao === 'DD' && p.codigo === 'sulco_incompleto'), false);

const nuncaNoPrazo = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  dia_medicao: 5,
  pneus: [pneu({ posicao: 'DD', data_medicao: null, tipo_pneu: 'direcional' })],
}), { agora: AGORA });
const sem = nuncaNoPrazo.pendencias.find((p) => p.posicao === 'DD' && p.codigo === 'sem_medicao');
assert.equal(sem?.severidade, 'atencao');
assert.equal(nuncaNoPrazo.pendencias.some((p) => p.posicao === 'DD' && p.codigo === 'medicao_atrasada'), false);

const sulcoTruck = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  pneus: [pneu({ posicao: 'DD', sulco_auxiliar: null, tipo_pneu: 'direcional' })],
}), { agora: AGORA });
assert.equal(
  sulcoTruck.pendencias.find((p) => p.codigo === 'sulco_incompleto' && p.posicao === 'DD')?.severidade,
  'atencao',
);

const mini = diagnosticarVeiculo(veiculo({
  tipo: 'Mini carregadeira',
  tipo_codigo: 'mini_carregadeira',
  layout_pneus: 'skid_4',
  pneus: ['S1E', 'S1D', 'S2E', 'S2D'].map((posicao, i) => pneu({
    id: i + 1,
    posicao,
    tipo_pneu: 'misto',
    sulco_externo: null,
    sulco_central: null,
    sulco_interno: null,
    sulco_auxiliar: null,
    sulco_mm: 8,
  })),
}), { agora: AGORA });
assert.equal(mini.pendencias.some((p) => p.codigo === 'sulco_incompleto'), false);

const miniSem = diagnosticarVeiculo(veiculo({
  tipo: 'Giro zero',
  tipo_codigo: 'giro_zero',
  layout_pneus: 'giro_4',
  pneus: [pneu({
    posicao: 'G1E',
    tipo_pneu: 'misto',
    sulco_externo: 5,
    sulco_central: 5,
    sulco_interno: 5,
    sulco_auxiliar: 5,
    sulco_mm: null,
  })],
}), { agora: AGORA });
assert.equal(miniSem.pendencias.some((p) => p.codigo === 'sulco_incompleto'), true);

const trator = diagnosticarVeiculo(veiculo({
  tipo: 'Trator',
  tipo_codigo: 'trator',
  layout_pneus: 'trator_4',
  pneus: [pneu({ posicao: '1E', sulco_interno: null, tipo_pneu: 'misto' })],
}), { agora: AGORA });
assert.equal(trator.pendencias.some((p) => p.codigo === 'sulco_incompleto' && p.posicao === '1E'), true);

const semPsi = diagnosticarVeiculo(completo, { agora: AGORA });
assert.equal(semPsi.pendencias.some((p) => /press[aã]o|psi|inspe/i.test(p.descricao)), false);

const semFogo = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  pneus: [pneu({ posicao: 'DD', numero_fogo: '  ', tipo_pneu: 'direcional' })],
}), { agora: AGORA });
assert.equal(semFogo.pendencias.find((p) => p.codigo === 'fogo_vazio')?.severidade, 'cadastral');

for (const fogo of ['Sem identificação', 'Sem identificação 45', 'Sem identificação2', 'S/N', 'sem fogo']) {
  const diag = diagnosticarVeiculo(veiculo({
    layout_pneus: 'utilitario_4',
    pneus: [pneu({ posicao: 'DD', numero_fogo: fogo, tipo_pneu: 'direcional' })],
  }), { agora: AGORA });
  assert.equal(diag.pendencias.some((p) => p.codigo === 'fogo_vazio'), true, fogo);
}
for (const fogo of ['18', '64', '1224510', 'CLG0748', '0104-0003']) {
  const diag = diagnosticarVeiculo(veiculo({
    layout_pneus: 'utilitario_4',
    pneus: [pneu({ posicao: 'DD', numero_fogo: fogo, tipo_pneu: 'direcional' })],
  }), { agora: AGORA });
  assert.equal(diag.pendencias.some((p) => p.codigo === 'fogo_vazio'), false, fogo);
}

const estepe = diagnosticarVeiculo(veiculo({
  tipo: 'Utilitário / Varredeira',
  layout_pneus: 'padrao_5',
  pneus: ['DD', 'DE', 'TD', 'TE'].map((posicao, i) => pneu({
    id: i + 1,
    posicao,
    tipo_pneu: posicao.startsWith('D') ? 'direcional' : 'misto',
  })),
}), { agora: AGORA });
assert.equal(estepe.pendencias.some((p) => p.codigo === 'estepe_vazio' && p.reprova === false), true);
assert.equal(estepe.conforme, true);
assert.equal(estepe.pendencias.some((p) => p.codigo === 'posicao_vazia'), false);

const vazio = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  pneus: [pneu({ posicao: 'DD', tipo_pneu: 'direcional' })],
}), { agora: AGORA });
assert.equal(vazio.pendencias.some((p) => p.codigo === 'posicao_vazia' && p.severidade === 'cadastral'), true);
assert.equal(vazio.conforme, false);

const personalizado = diagnosticarVeiculo(veiculo({
  layout_pneus: 'personalizado',
  pneus: [pneu({ posicao: 'ZZ', tipo_pneu: 'misto' })],
}), { agora: AGORA });
assert.equal(personalizado.layout_disponivel, false);
assert.equal(personalizado.pendencias.some((p) => p.codigo === 'layout_indisponivel' && p.reprova === false), true);
assert.equal(personalizado.pendencias.some((p) => p.codigo === 'posicao_vazia'), false);
assert.equal(personalizado.pendencias.some((p) => p.codigo === 'posicao_fora_layout'), false);

const recap = diagnosticarVeiculo(veiculo({
  layout_pneus: 'utilitario_4',
  pneus: [pneu({ posicao: 'DD', condicao: 'recapado', tipo_pneu: 'direcional' })],
}), { agora: AGORA });
assert.equal(recap.pendencias.find((p) => p.codigo === 'montagem_incorreta')?.severidade, 'critica');

const rel = avaliarFrota([
  veiculo({ id: 1, cadastro_completo: 0, marca: '', modelo: '', layout_pneus: '', pneus: [] }),
  veiculo({
    id: 2,
    placa: 'CON1A23',
    layout_pneus: 'utilitario_4',
    pneus: ['DD', 'DE', 'TD', 'TE'].map((posicao, i) => pneu({
      id: i + 1,
      posicao,
      tipo_pneu: posicao.startsWith('D') ? 'direcional' : 'borrachudo',
    })),
  }),
  veiculo({
    id: 3,
    placa: 'PEN1A23',
    filial_id: 9,
    filial_nome: 'Outra',
    filial_codigo: '9999',
    layout_pneus: 'utilitario_4',
    pneus: [pneu({ posicao: 'DD', numero_fogo: '', filial_id: 9, tipo_pneu: 'direcional' })],
  }),
], {}, { agora: AGORA, escopo: [3] });

assert.equal(rel.resumo.veiculos_analisados, 1);
assert.equal(rel.resumo.veiculos_conformes, 1);
assert.equal(rel.resumo.conformidade_pct, 100);
assert.equal(rel.resumo.cadastros_incompletos_veiculos, 1);
assert.equal(rel.veiculos.some((v) => v.filial_id === 9), false);
assert.equal(rel.cadastros_incompletos.veiculos[0].placa, 'ABC1D23');
assert.equal(escopoPermite(null, 9), true);
assert.equal(escopoPermite([3], 9), false);
assert.equal(rejeitarFilialForaDoEscopo([3], 9)?.status, 403);
assert.equal(rejeitarFilialForaDoEscopo(null, 9), null);
assert.equal(rejeitarFilialForaDoEscopo([3], 'x')?.status, 400);

const filtrado = avaliarFrota([
  veiculo({
    id: 2,
    layout_pneus: 'utilitario_4',
    pneus: [pneu({ posicao: 'DD', data_medicao: '2026-09-01', tipo_pneu: 'direcional' })],
  }),
], { periodo_inicio: '2026-10-01', periodo_fim: '2026-10-15' }, { agora: AGORA, escopo: null });
assert.equal(filtrado.resumo.veiculos_analisados, 0);

const soCritica = avaliarFrota([
  veiculo({
    id: 2,
    placa: 'CON1A23',
    layout_pneus: 'utilitario_4',
    pneus: ['DD', 'DE', 'TD', 'TE'].map((posicao, i) => pneu({
      id: i + 1,
      posicao,
      tipo_pneu: posicao.startsWith('D') ? 'direcional' : 'borrachudo',
    })),
  }),
  veiculo({
    id: 4,
    placa: 'ATR1A23',
    dia_medicao: 3,
    layout_pneus: 'utilitario_4',
    pneus: ['DD', 'DE', 'TD', 'TE'].map((posicao, i) => pneu({
      id: i + 10,
      posicao,
      data_medicao: '2026-10-09',
      tipo_pneu: posicao.startsWith('D') ? 'direcional' : 'borrachudo',
    })),
  }),
], { pendencia: 'critica' }, { agora: AGORA, escopo: null });
assert.equal(soCritica.resumo.veiculos_analisados, 2);
assert.equal(soCritica.resumo.veiculos_conformes, 1);
assert.equal(soCritica.veiculos.length, 1);
assert.equal(soCritica.veiculos[0].placa, 'ATR1A23');

const pdf = await gerarPdfDiagnosticoFrota(rel);
assert.equal(pdf.slice(0, 4).toString(), '%PDF');
assert.ok(pdf.length > 1000);

console.log('test-diagnostico-frota ok');
