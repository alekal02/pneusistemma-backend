/**
 * Contrato da frota ilustrada, filtro, vencimento e autorização.
 * Não grava e não fala com o banco.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { requireLeituraExecutiva } from '../src/auth.js';
import { somenteLeituraExecutiva } from '../src/routes/presidente-leitura.js';
import {
  filtrarFiliaisPorSituacao,
  montarDiagnosticoExecutivo,
  situacaoMedicaoExecutiva as situacaoMedicao,
} from '../src/services/diagnostico-executivo.js';
import {
  CAMPOS_PNEU_FROTA,
  CAMPOS_VEICULO_FROTA,
  agregarVisao,
  medicaoAtrasada,
  recortar,
  resolverPeriodo,
} from '../src/services/dashboard-executivo.js';

const hoje = '2026-10-22';
const periodo = resolverPeriodo({ periodo: '30' }, hoje);
const POS = ['1E', '1D', '2EE', '2EI', '2DI', '2DE'];

function chama(papel) {
  let status = 0;
  let passou = false;
  const res = {
    status(codigo) { status = codigo; return this; },
    json() { return this; },
  };
  requireLeituraExecutiva({ user: papel ? { papel } : null }, res, () => { passou = true; });
  return { status, passou };
}

assert.equal(chama('presidente').passou, true);
assert.equal(chama('admin').passou, true);
assert.equal(chama('filial').status, 403);
assert.equal(chama('gerente').status, 403);
assert.equal(chama(null).status, 403);

let escrita = 0;
somenteLeituraExecutiva({ method: 'POST' }, { status(c) { escrita = c; return this; }, json() { return this; } }, () => {});
assert.equal(escrita, 405);
let leitura = false;
somenteLeituraExecutiva({ method: 'GET' }, {}, () => { leitura = true; });
assert.equal(leitura, true);

assert.equal(medicaoAtrasada(null, hoje), false);
assert.equal(situacaoMedicao({ dataMedicao: null, diaFilial: 4, agora: new Date('2026-10-22T15:00:00-03:00') }).situacao, 'sem_medicao');
const vencida = situacaoMedicao({
  dataMedicao: '2026-10-15',
  diaFilial: 2,
  agora: new Date('2026-10-22T15:00:00-03:00'),
});
assert.equal(vencida.situacao, 'atrasada');

function pneu(parcial) {
  return {
    status_pneu: 'montado',
    sulco_externo: 12,
    sulco_central: 12,
    sulco_interno: 12,
    sulco_auxiliar: 12,
    data_medicao: '2026-10-22',
    perfil_sulco: 'quatro_pontos',
    kpi: 'ok',
    atrasada: false,
    situacao_medicao: 'em_dia',
    ...parcial,
  };
}

const visao = agregarVisao({
  hoje,
  periodo,
  prazoRecapDias: 15,
  filiais: [
    { id: 1, nome: 'Unaí', codigo: '0107', dia_medicao: 4 },
    { id: 2, nome: 'Aparecida', codigo: '0102', dia_medicao: 4 },
    { id: 3, nome: 'Contagem', codigo: '0103', dia_medicao: 4 },
  ],
  veiculos: [
    { id: 10, placa: 'AAA1A11', apelido: 'Com pneus', tipo: 'toco_mini', tipo_codigo: 'toco_mini', layout_pneus: 'toco_6', filial_id: 1, filial_nome: 'Unaí', dia_medicao: 4, cadastro_completo: 1 },
    { id: 11, placa: 'BBB2B22', apelido: 'Só acompanhamento', tipo: 'toco_mini', tipo_codigo: 'toco_mini', layout_pneus: 'toco_6', filial_id: 1, filial_nome: 'Unaí', dia_medicao: 4, cadastro_completo: 1 },
    { id: 12, placa: 'CCC3C33', apelido: 'Sem layout', tipo: 'toco_mini', tipo_codigo: 'toco_mini', layout_pneus: null, filial_id: 1, filial_nome: 'Unaí', dia_medicao: 4, cadastro_completo: 1 },
  ],
  pneus: [
    pneu({
      id: 1, filial_id: 1, veiculo_id: 10, posicao: '1E', numero_fogo: '1001',
      kpi: 'critico', menor_sulco: 2, sulco_auxiliar: 2, pressao_psi: 110,
      risco_imediato: true,
    }),
    pneu({ id: 2, filial_id: 1, veiculo_id: 10, posicao: '1D', numero_fogo: '1002', pressao_psi: null }),
    ...Array.from({ length: 8 }, (_, i) => pneu({
      id: 20 + i, filial_id: 1, veiculo_id: 11, posicao: POS[i % 6], numero_fogo: `20${i}`,
    })),
    pneu({
      id: 9, filial_id: 1, veiculo_id: 12, posicao: 'LIVRE', numero_fogo: '9009',
      kpi: 'sem_dado', perfil_sulco: 'simples', sulco_mm: null,
      sulco_externo: null, sulco_central: null, sulco_interno: null, sulco_auxiliar: null,
      data_medicao: null, situacao_medicao: 'sem_medicao', menor_sulco: null,
    }),
  ],
});

const diag = montarDiagnosticoExecutivo({
  filiais: [
    { id: 1, nome: 'Unaí', codigo: '0107', dia_medicao: 4 },
    { id: 2, nome: 'Aparecida', codigo: '0102', dia_medicao: 4 },
    { id: 3, nome: 'Contagem', codigo: '0103', dia_medicao: 4 },
  ],
  veiculos: visao.listas.frota.map((v) => ({
    id: v.id,
    placa: v.placa,
    apelido: v.apelido,
    tipo: 'toco_mini',
    layout_pneus: v.layout_id,
    cadastro_completo: 1,
    dia_medicao: 4,
    filial_id: v.filial_id,
  })),
  pneus: visao.listas.frota.flatMap((v) => v.pneus.map((p) => ({ ...p, veiculo_id: v.id, filial_id: v.filial_id }))),
  incluirMatriz: true,
  agora: new Date('2026-10-22T15:00:00-03:00'),
});
const unaiVisao = visao.filiais.find((f) => f.id === 1);
const unaiDiag = diag.filiais.find((f) => f.id === 1);
assert.equal(unaiVisao.situacao_executiva, unaiDiag.situacao);
assert.equal(unaiVisao.pct_critico, unaiDiag.pct_critico);
assert.equal(unaiVisao.pneus_criticos, unaiDiag.pneus_criticos);
assert.equal(unaiVisao.pneus_sem_dados, unaiDiag.pneus_sem_dados);
assert.notEqual(unaiVisao.situacao_executiva, 'critica');
assert.equal(unaiVisao.riscos_imediatos, 1);

const aparecida = diag.filiais.find((f) => f.nome === 'Aparecida');
const contagem = diag.filiais.find((f) => f.nome === 'Contagem');
assert.equal(aparecida.sem_frota, true);
assert.equal(contagem.sem_frota, true);
assert.equal(aparecida.situacao, 'nao_avaliada');

const filtrada = agregarVisao({
  hoje,
  periodo,
  filiais: [
    { id: 1, nome: 'Unaí', codigo: '0107', dia_medicao: 4 },
    { id: 2, nome: 'Aparecida', codigo: '0102', dia_medicao: 4 },
  ],
  veiculos: [
    { id: 10, placa: 'AAA1A11', tipo: 'toco_mini', tipo_codigo: 'toco_mini', layout_pneus: 'toco_6', filial_id: 1, filial_nome: 'Unaí', dia_medicao: 4 },
    { id: 11, placa: 'BBB2B22', tipo: 'toco_mini', tipo_codigo: 'toco_mini', layout_pneus: 'toco_6', filial_id: 1, filial_nome: 'Unaí', dia_medicao: 4 },
  ],
  pneus: visao.listas.frota.filter((v) => v.id !== 12).flatMap((v) => v.pneus.map((p) => ({
    ...p,
    status_pneu: 'montado',
    veiculo_id: v.id,
    filial_id: 1,
    kpi: p.kpi,
  }))),
  situacao: 'critico',
});
assert.equal(filtrada.filiais.length, 1);
assert.equal(filtrada.filiais[0].id, 1);
assert.notEqual(filtrada.filiais[0].pct_critico, 100);
assert.equal(filtrada.resumo.cards.find((c) => c.id === 'montados').valor > 1, true);
assert.equal(filtrada.listas.frota.some((v) => v.id === 11), true);
const diagFiltrado = filtrarFiliaisPorSituacao(diag, 'critico');
assert.deepEqual(filtrada.filiais.map((f) => f.id), [1]);
assert.equal(diagFiltrado.filiais.some((f) => f.id === 2), false);

const veiculo = visao.listas.frota.find((v) => v.id === 10);
for (const campo of CAMPOS_VEICULO_FROTA) assert.equal(campo in veiculo, true, campo);
assert.deepEqual(veiculo.posicoes, POS);
const direcional = veiculo.pneus.find((p) => p.posicao === '1E');
for (const campo of CAMPOS_PNEU_FROTA) assert.equal(campo in direcional, true, campo);
assert.equal(direcional.numero_fogo, '1001');
assert.equal(direcional.sulco_externo, 12);
assert.equal(direcional.sulco_auxiliar, 2);
assert.equal(direcional.pressao_psi, 110);
assert.equal(direcional.perfil_sulco, 'quatro_pontos');
assert.equal(direcional.condicao, 'Substituição prioritária');
assert.equal(direcional.risco_imediato, true);
assert.equal(direcional.menor_sulco, 2);
assert.equal('media' in direcional, false);

const semLayout = visao.listas.frota.find((v) => v.id === 12);
assert.deepEqual(semLayout.posicoes, []);
assert.equal(semLayout.sem_layout, true);
assert.equal(semLayout.pneus[0].perfil_sulco, 'simples');
assert.equal(semLayout.pneus[0].sem_medicao, true);
assert.equal(semLayout.pneus[0].atrasada, false);
assert.equal(semLayout.medicao_label, 'Sem medição');

const pagina = recortar(visao, { recorte: 'frota', filialId: 1, pagina: 1, limite: 2 });
assert.equal(pagina.limite, 2);
assert.equal(pagina.itens.length, 2);
assert.equal(pagina.total, 3);

const inicio = performance.now();
const muitosVeiculos = Array.from({ length: 200 }, (_, i) => ({
  id: 1000 + i,
  placa: `PNE${i}`,
  tipo: 'toco_mini',
  tipo_codigo: 'toco_mini',
  layout_pneus: 'toco_6',
  filial_id: 1,
  filial_nome: 'Unaí',
  dia_medicao: 4,
  cadastro_completo: 1,
}));
const muitosPneus = muitosVeiculos.flatMap((v) => POS.map((posicao, n) => pneu({
  id: v.id * 10 + n,
  filial_id: 1,
  veiculo_id: v.id,
  posicao,
  numero_fogo: String(v.id * 10 + n),
})));
agregarVisao({
  hoje,
  periodo,
  filiais: [{ id: 1, nome: 'Unaí', codigo: '0107', dia_medicao: 4 }],
  veiculos: muitosVeiculos,
  pneus: muitosPneus,
});
const ms = performance.now() - inicio;
assert.equal(ms < 1500, true, `frota de 200 veículos levou ${Math.round(ms)} ms`);

console.log('contrato frota: ok', `${Math.round(ms)} ms`);
