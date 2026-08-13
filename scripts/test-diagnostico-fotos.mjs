/**
 * Casos das fotos de medição — rodízio > 4 mm e 1E → 1D.
 * Uso: node scripts/test-diagnostico-fotos.mjs
 */
import {
  desvioEntrePontos,
  diagnosticarPerfil,
  sugerirAcao,
  internoMaisGastoQueExterno,
} from '../src/diagnostico.js';
import { posicaoEspelhada } from '../src/pneus-layouts.js';

const limites = {
  sulco_critico_mm: 3,
  sulco_alerta_mm: 8,
  max_recaps: 6,
  prazo_recap_dias: 15,
  diagnostico_tolerancia_mm: 1,
  rodizio_desvio_mm: 4,
  rodizio_similaridade_mm: 2.5,
  acoes: {},
};

let falhas = 0;

function assert(cond, msg) {
  if (!cond) {
    falhas += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK  :', msg);
  }
}

function pontos(ext, cent, int, aux = null) {
  return {
    sulco_externo: ext,
    sulco_central: cent,
    sulco_interno: int,
    sulco_auxiliar: aux,
  };
}

// Espelhamento
assert(posicaoEspelhada('1E') === '1D', '1E espelha 1D');
assert(posicaoEspelhada('1D') === '1E', '1D espelha 1E');
assert(posicaoEspelhada('2EE') === '2DE', '2EE espelha 2DE');

// Exemplos da folha (desvio)
const casosOk = [
  [14, 14, 13],
  [14, 13, 12],
  [13, 12, 11],
  [11, 12, 11],
  [10, 10, 6], // desvio 4 → NÃO rodízio (regra > 4)
  [5, 5, 5],
];

for (const [e, c, i] of casosOk) {
  const row = pontos(e, c, i);
  const desvio = desvioEntrePontos(row);
  const acao = sugerirAcao(Math.min(e, c, i), limites, 0, {
    pontos: row,
    candidatos: [{ id: 2, posicao: '1D', numero_fogo: '99', sulco_externo: 12, sulco_central: 12, sulco_interno: 12 }],
    posicaoAtual: '1E',
  });
  assert(acao.codigo !== 'rodizio', `${e}·${c}·${i} desvio=${desvio} → sem rodízio (foi ${acao.codigo})`);
}

// 12·10·7 → rodízio → 1D
{
  const row = pontos(12, 10, 7);
  assert(desvioEntrePontos(row) === 5, '12·10·7 desvio = 5');
  assert(internoMaisGastoQueExterno(row), '12·10·7 interno mais gasto que externo');
  const diag = diagnosticarPerfil(row, 1, { papel: 'direcional' });
  assert(diag.codigo === 'alinhamento', `perfil cunha → alinhamento (foi ${diag.codigo})`);
  assert(/interno mais gasto/i.test(diag.descricao), 'descrição menciona interno mais gasto');

  const acao = sugerirAcao(7, limites, 0, {
    pontos: row,
    candidatos: [{ id: 2, posicao: '1D', numero_fogo: '88', sulco_externo: 11, sulco_central: 11, sulco_interno: 10 }],
    posicaoAtual: '1E',
  });
  assert(acao.codigo === 'rodizio', `12·10·7 → rodízio (foi ${acao.codigo})`);
  assert(acao.rodizio_sugestao?.posicao_destino === '1D', `destino 1D (foi ${acao.rodizio_sugestao?.posicao_destino})`);
  assert(acao.rodizio_sugestao?.pneu_id === 2, 'ocupante do 1D sugerido');
}

// Slot 1D vazio → sugere mover para vazio
{
  const row = pontos(12, 10, 7);
  const acao = sugerirAcao(7, limites, 0, {
    pontos: row,
    candidatos: [{ id: 3, posicao: '2EE', sulco_externo: 12, sulco_central: 12, sulco_interno: 12 }],
    posicaoAtual: '1E',
  });
  assert(acao.codigo === 'rodizio', 'rodízio com 1D vazio');
  assert(acao.rodizio_sugestao?.slot_vazio === true, 'marca slot vazio');
  assert(acao.rodizio_sugestao?.posicao_destino === '1D', 'destino 1D mesmo vazio');
}

// Crítico tem prioridade sobre rodízio
{
  const row = pontos(2, 2, 1);
  const acao = sugerirAcao(1, limites, 0, {
    pontos: row,
    candidatos: [{ id: 2, posicao: '1D' }],
    posicaoAtual: '1E',
  });
  assert(acao.codigo === 'troca', `sulco crítico → troca (foi ${acao.codigo})`);
}

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log('\nTodos os casos das fotos passaram.');
