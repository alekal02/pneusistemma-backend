/**
 * PDF da visão executiva com o exemplo de 120 pneus. Sem banco.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { gerarPdfExecutivoBuffer } from '../src/services/dashboard-executivo-pdf.js';

const buffer = await gerarPdfExecutivoBuffer({
  snapshot: {
    gerado_em: '2026-10-22T15:00:00.000Z',
    resumo: { cards: [{ id: 'montados', rotulo: 'Pneus montados', valor: 120, cor: 'neutro' }] },
    saude: { condicao: [], localizacao: [], atualizacao: [] },
    filiais: [],
  },
  evolucao: { series: {} },
  diagnostico: {
    filiais: [
      {
        id: 1,
        nome: 'Exemplo 120',
        situacao: 'atencao',
        situacao_label: 'Requer acompanhamento',
        sem_frota: false,
        veiculos_ativos: 12,
        pneus_montados: 120,
        pneus_sem_alerta: 60,
        pneus_atencao: 57,
        pneus_criticos: 3,
        pneus_sem_dados: 0,
        pct_sem_alerta: 50,
        pct_atencao: 47.5,
        pct_critico: 2.5,
        pct_sem_dados: 0,
        riscos_imediatos: 1,
      },
      {
        id: 4,
        nome: 'Aparecida',
        situacao: 'nao_avaliada',
        situacao_label: 'Dados insuficientes',
        sem_frota: true,
        veiculos_ativos: 0,
        pneus_montados: 0,
      },
    ],
  },
});

assert.ok(buffer.slice(0, 5).toString() === '%PDF-');
const bruto = buffer.toString('latin1');
const textos = [];
for (const trecho of bruto.split('stream\n').slice(1)) {
  const corpo = trecho.split('\nendstream')[0];
  try {
    textos.push(zlib.inflateSync(Buffer.from(corpo, 'latin1')).toString('latin1'));
  } catch {
    textos.push(corpo);
  }
}
const texto = textos.join('\n').replace(/<([0-9A-Fa-f]+)>/g, (_, hex) => Buffer.from(hex, 'hex').toString('latin1'));
assert.match(texto, /Requer acompanhamento/);
assert.match(texto, /2,5%/);
assert.match(texto, /47,5%/);
assert.match(texto, /imediata/);
assert.match(texto, /Dados insuficientes/);
assert.match(texto, /Aparecida/);
assert.equal(texto.includes('Situação crítica'), false);
console.log('pdf executivo: ok', buffer.length);
