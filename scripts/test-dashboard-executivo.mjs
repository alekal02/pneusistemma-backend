/**
 * Regras puras da visão executiva. Não grava e não fala com o banco.
 */
import assert from 'node:assert/strict';
import {
  DADOS_INSUFICIENTES,
  HISTORICO_INDISPONIVEL,
  agregarVisao,
  classificarLinha,
  medicaoAtrasada,
  montarSerie,
  resolverPeriodo,
  situacaoOperacional,
} from '../src/services/dashboard-executivo.js';

const hoje = '2026-10-21';
const periodo = resolverPeriodo({ periodo: '30' }, hoje);

const sulcoQuatro = classificarLinha({
  tipo: 'toco_mini',
  tipo_codigo: 'toco_mini',
  layout_pneus: 'toco_6',
  sulco_externo: 9,
  sulco_central: 8,
  sulco_interno: 7,
  sulco_auxiliar: 3,
});
assert.equal(sulcoQuatro.menor_sulco, 3);
assert.equal(sulcoQuatro.kpi, 'critico');

const tresPontos = classificarLinha({
  tipo_codigo: 'toco_mini',
  layout_pneus: 'toco_6',
  sulco_externo: 9,
  sulco_central: 8,
  sulco_interno: 7,
  sulco_auxiliar: null,
});
assert.equal(tresPontos.menor_sulco, 7);
assert.equal(tresPontos.kpi, 'monitorar');

const semMedicao = classificarLinha({
  tipo_codigo: 'toco_mini',
  layout_pneus: 'toco_6',
});
assert.equal(semMedicao.menor_sulco, null);
assert.equal(semMedicao.kpi, 'sem_dado');
assert.notEqual(semMedicao.menor_sulco, 0);

const tratorNaFaixa = classificarLinha({
  tipo: 'trator',
  tipo_codigo: 'trator',
  sulco_externo: 20,
  sulco_central: 20,
  sulco_interno: 20,
  sulco_auxiliar: 12,
});
assert.equal(tratorNaFaixa.menor_sulco, 12);
assert.equal(tratorNaFaixa.kpi, 'monitorar');

const tratorCritico = classificarLinha({
  tipo: 'trator',
  tipo_codigo: 'trator',
  sulco_externo: 20,
  sulco_central: 20,
  sulco_interno: 20,
  sulco_auxiliar: 9,
});
assert.equal(tratorCritico.menor_sulco, 9);
assert.equal(tratorCritico.kpi, 'critico');

const industrialSemRegua = classificarLinha({
  tipo: 'mini_carregadeira',
  tipo_codigo: 'mini_carregadeira',
  sulco_mm: 4,
  sulco_externo: 4,
  sulco_central: 4,
  sulco_interno: 4,
  sulco_auxiliar: 4,
});
assert.equal(industrialSemRegua.kpi, 'sem_dado');

assert.equal(medicaoAtrasada('2026-09-30', hoje), true);
assert.equal(medicaoAtrasada('2026-10-02', hoje), false);
assert.equal(medicaoAtrasada(null, hoje), true);

assert.equal(situacaoOperacional({
  montados: 4, criticos: 0, atrasados: 0, monitorar: 0, veiculos: 1, veiculosSemPneu: 0,
}).codigo, 'ok');

const semPneu = situacaoOperacional({
  montados: 0, criticos: 0, atrasados: 0, monitorar: 0, veiculos: 2, veiculosSemPneu: 2,
});
assert.equal(semPneu.codigo, 'insuficiente');
assert.equal(semPneu.label, DADOS_INSUFICIENTES);
assert.notEqual(semPneu.codigo, 'ok');

const visao = agregarVisao({
  hoje,
  periodo,
  prazoRecapDias: 15,
  filiais: [
    { id: 1, nome: 'Norte', codigo: 'NORTE' },
    { id: 2, nome: 'Sul', codigo: 'SUL' },
  ],
  veiculos: [
    { id: 10, placa: 'AAA1A11', apelido: 'Um', tipo_codigo: 'toco_mini', tipo: 'toco_mini', layout_pneus: 'toco_6', filial_id: 1, filial_nome: 'Norte' },
    { id: 11, placa: 'BBB2B22', apelido: 'Dois', tipo_codigo: 'toco_mini', tipo: 'toco_mini', layout_pneus: 'toco_6', filial_id: 2, filial_nome: 'Sul' },
  ],
  pneus: [
    {
      id: 1, status_pneu: 'montado', kpi: 'critico', menor_sulco: 3, atrasada: false,
      filial_id: 1, filial_nome: 'Norte', veiculo_id: 10, placa: 'AAA1A11', posicao: '1E',
      numero_fogo: '10', tipo_codigo: 'toco_mini', acao: null, veiculo_ativo: 1, veiculo_filial_id: 1,
    },
    {
      id: 2, status_pneu: 'estoque', kpi: null, menor_sulco: null, atrasada: false,
      filial_id: 1, filial_nome: 'Norte', veiculo_id: null, numero_fogo: '11',
    },
  ],
});

const condicao = visao.saude.condicao.reduce((s, item) => s + item.valor, 0);
const montados = visao.saude.localizacao.find((item) => item.id === 'montado').valor;
const estoque = visao.saude.localizacao.find((item) => item.id === 'estoque').valor;
assert.equal(condicao, montados);
assert.equal(montados, 1);
assert.equal(estoque, 1);
assert.equal(condicao + estoque, 2);

const sul = visao.filiais.find((f) => f.id === 2);
assert.equal(sul.situacao.codigo, 'insuficiente');
assert.equal(sul.situacao.label, DADOS_INSUFICIENTES);
assert.equal(sul.percentual_atualizado, null);
assert.notEqual(sul.situacao.codigo, 'ok');

const norte = visao.filiais.find((f) => f.id === 1);
assert.equal(norte.situacao.codigo, 'critica');

const vazio = montarSerie({ periodo });
for (const serie of Object.values(vazio.series)) {
  assert.equal(serie.disponivel, false);
  assert.equal(serie.motivo, HISTORICO_INDISPONIVEL);
  assert.equal(serie.pontos.length, 0);
}

const comMedicao = montarSerie({
  periodo: resolverPeriodo({ periodo: '7' }, hoje),
  historicoMedicoes: true,
  diasMedicao: [{ dia: hoje, medicoes: 4, filiais: [1] }],
});
assert.equal(comMedicao.series.medicoes.disponivel, true);
assert.equal(comMedicao.series.conformidade.disponivel, false);
assert.equal(comMedicao.series.conformidade.motivo, HISTORICO_INDISPONIVEL);
assert.ok(comMedicao.series.medicoes.pontos.some((p) => p.valor === 4));

const cardMontados = visao.resumo.cards.find((c) => c.id === 'montados').valor;
const cardCriticos = visao.resumo.cards.find((c) => c.id === 'criticos').valor;
assert.equal(cardCriticos <= cardMontados, true);
assert.equal(JSON.stringify(visao).includes('custo'), false);

console.log('dashboard executivo: ok');
