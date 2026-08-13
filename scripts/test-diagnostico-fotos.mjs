/**
 * Casos de medição — consumo por lado do caminhão.
 * Uso: node scripts/test-diagnostico-fotos.mjs
 */
import {
  desvioEntrePontos,
  diagnosticarPerfil,
  sugerirAcao,
  desgasteProgressivoEsperado,
} from '../src/diagnostico.js';
import { posicaoEspelhada, ladoPosicao } from '../src/pneus-layouts.js';

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

assert(posicaoEspelhada('1E') === '1D', '1E espelha 1D');
assert(ladoPosicao('1D') === 'direito', '1D é lado direito');
assert(ladoPosicao('1E') === 'esquerdo', '1E é lado esquerdo');

// Caso real do usuário: 1D · 8·9·10 → consumo esperado (dir→esq), NÃO irregular
{
  const row = pontos(8, 9, 10);
  assert(desgasteProgressivoEsperado(row), '8·9·10 é consumo progressivo (ext < int)');
  const diag = diagnosticarPerfil(row, 1, { posicao: '1D' });
  assert(diag.codigo === 'desgaste_progressivo', `8·9·10 em 1D → progressivo (foi ${diag.codigo})`);
  assert(/direita para a esquerda/i.test(diag.descricao), 'menciona direita → esquerda');
  const acao = sugerirAcao(8, limites, 0, { pontos: row, posicaoAtual: '1D', candidatos: [] });
  assert(acao.codigo !== 'rodizio', `8·9·10 sem rodízio (foi ${acao.codigo})`);
}

// Lado esquerdo com mesmo padrão: 8·9·10 → esq→dir
{
  const row = pontos(8, 9, 10);
  const diag = diagnosticarPerfil(row, 1, { posicao: '1E' });
  assert(diag.codigo === 'desgaste_progressivo', '8·9·10 em 1E → progressivo');
  assert(/esquerda para a direita/i.test(diag.descricao), 'menciona esquerda → direita');
}

// Interno mais gasto (12·10·7) → fora do padrão
{
  const row = pontos(12, 10, 7);
  assert(!desgasteProgressivoEsperado(row), '12·10·7 NÃO é consumo esperado');
  const diag = diagnosticarPerfil(row, 1, { posicao: '1D' });
  assert(diag.codigo === 'irregular', `12·10·7 → irregular (foi ${diag.codigo})`);
}

// Desvio alto no padrão esperado → sem rodízio (monitorar/ok)
{
  const row = pontos(7, 10, 12);
  assert(desgasteProgressivoEsperado(row), '7·10·12 é progressivo');
  const acao = sugerirAcao(7, limites, 0, {
    pontos: row,
    posicaoAtual: '1D',
    candidatos: [{ id: 2, posicao: '1E', sulco_externo: 11, sulco_central: 11, sulco_interno: 10 }],
  });
  assert(acao.codigo === 'monitorar', `7·10·12 → monitorar (foi ${acao.codigo})`);
  assert(acao.rodizio_sugestao == null, 'sem rodízio no consumo esperado');
}

// Desvio alto FORA do padrão → rodízio
{
  const row = pontos(12, 10, 7);
  assert(desvioEntrePontos(row) === 5, 'desvio 5');
  const acao = sugerirAcao(7, limites, 0, {
    pontos: row,
    posicaoAtual: '1E',
    candidatos: [{ id: 2, posicao: '1D', numero_fogo: '88', sulco_externo: 11, sulco_central: 11, sulco_interno: 10 }],
  });
  assert(acao.codigo === 'rodizio', `12·10·7 → rodízio (foi ${acao.codigo})`);
  assert(acao.rodizio_sugestao?.posicao_destino === '1D', 'destino 1D');
}

// Crítico
{
  const row = pontos(5, 3, 2);
  const acao = sugerirAcao(2, limites, 0, { pontos: row, posicaoAtual: '1D', candidatos: [] });
  assert(acao.codigo === 'troca', 'crítico → troca');
}

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log('\nTodos os casos passaram.');
