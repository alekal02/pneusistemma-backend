/**
 * Gera docs/Preview-Frota-Visual.pdf com o mesmo desenho do relatório do chatbot.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gerarPdfRelatorioSemanal } from '../src/services/relatorio-semanal-pdf.js';

const pneu = (posicao, mm, status) => ({
  posicao,
  menor_sulco: mm,
  status_sulco: status,
  status_label: status === 'critico' ? 'Critico' : status === 'alerta' ? 'Alerta' : 'OK',
  diagnostico: status === 'critico' ? 'Critico' : status === 'alerta' ? 'Falta de calibragem' : 'OK',
  acao: status === 'critico' ? 'Trocar' : status === 'alerta' ? 'Monitorar' : 'OK',
  motivo: status === 'critico'
    ? 'Critico — retirar e trocar (sulco 3,1 mm).'
    : status === 'alerta'
      ? 'Sulco em alerta — acompanhar nesta semana.'
      : 'Desgaste uniforme.',
});

const dados = {
  titulo: 'Preview frota visual',
  filial: { nome: 'Unidade BH', codigo: 'BH' },
  periodo: { label: '15/09 a 21/09' },
  gerado_em: new Date().toISOString(),
  gerado_por: 'Preview',
  limites: { critico_mm: 3, monitorar_ate_mm: 6, prazo_recap_dias: 15 },
  resumo: {
    veiculos: 3,
    pneus_montados: 30,
    pneus_estoque: 4,
    pneus_em_recapagem: 1,
    pneus_descarte: 0,
    sulco_ok: 28,
    sulco_monitorar: 6,
    sulco_critico: 3,
    sem_medicao: 0,
    acao_trocar: 2,
    acao_recap: 1,
    acao_monitorar: 3,
    acao_rodizio: 0,
    medicoes_semana: 5,
    movimentacoes_semana: 2,
    veiculos_atrasados_medicao: 1,
    custo_montado: 0,
    custo_estoque: 0,
    descarte_aguardando: 0,
  },
  frota: [
    {
      placa: 'BH1A23',
      status_sulco: 'critico',
      status_label: 'Critico',
      menor_sulco: 3.1,
      ultima_medicao: '2026-09-18',
      pneus: [
        pneu('1E', 8.2, 'ok'), pneu('1D', 8.0, 'ok'),
        pneu('2EE', 3.1, 'critico'), pneu('2EI', 5.0, 'alerta'),
        pneu('2DI', 5.2, 'alerta'), pneu('2DE', 7.1, 'ok'),
        pneu('3EE', 7.8, 'ok'), pneu('3EI', 7.4, 'ok'),
        pneu('3DI', 7.6, 'ok'), pneu('3DE', 7.9, 'ok'),
      ],
    },
    {
      placa: 'UN4B56',
      status_sulco: 'alerta',
      status_label: 'Alerta',
      menor_sulco: 5.4,
      ultima_medicao: '2026-09-18',
      pneus: [
        pneu('1E', 5.4, 'alerta'), pneu('1D', 8.1, 'ok'),
        pneu('2EE', 8.0, 'ok'), pneu('2EI', 7.8, 'ok'),
        pneu('2DI', 7.9, 'ok'), pneu('2DE', 8.2, 'ok'),
        pneu('3EE', 9.0, 'ok'), pneu('3EI', 8.8, 'ok'),
        pneu('3DI', 8.6, 'ok'), pneu('3DE', 8.7, 'ok'),
      ],
    },
    {
      placa: 'AP7C89',
      status_sulco: 'ok',
      status_label: 'OK',
      menor_sulco: 9.2,
      ultima_medicao: '2026-09-17',
      pneus: [
        pneu('1E', 10, 'ok'), pneu('1D', 9.8, 'ok'),
        pneu('2EE', 9.4, 'ok'), pneu('2EI', 9.2, 'ok'),
        pneu('2DI', 9.5, 'ok'), pneu('2DE', 9.6, 'ok'),
        pneu('3EE', 11, 'ok'), pneu('3EI', 10, 'ok'),
        pneu('3DI', 10, 'ok'), pneu('3DE', 9.9, 'ok'),
      ],
    },
  ],
  prioridades: {
    troca: [{
      placa: 'BH1A23', posicao: '2EE', menor_sulco: 3.1, status_label: 'Critico',
      acao: 'Trocar', motivo: 'Critico — retirar e trocar (sulco 3,1 mm).',
    }],
    monitorar: [
      { placa: 'BH1A23', posicao: '2EI', menor_sulco: 5.0, status_label: 'Alerta', acao: 'Monitorar', motivo: 'Sulco em alerta — acompanhar.' },
      { placa: 'UN4B56', posicao: '1E', menor_sulco: 5.4, status_label: 'Alerta', acao: 'Monitorar', motivo: 'Sulco em alerta no eixo dianteiro.' },
    ],
    rodizio: [],
  },
  diagnosticos: [
    { placa: 'BH1A23', posicao: '2EE', menor_sulco: 3.1, status_label: 'Critico', diagnostico: 'Critico', motivo: 'Sulco no limite critico — retirar e trocar.' },
    { placa: 'BH1A23', posicao: '2EI', menor_sulco: 5.0, status_label: 'Alerta', diagnostico: 'Calibragem baixa', motivo: 'Centro mais gasto que as bordas.' },
    { placa: 'UN4B56', posicao: '1E', menor_sulco: 5.4, status_label: 'Alerta', diagnostico: 'Desgaste irregular', motivo: 'Perfil inconsistente — inspecao visual.' },
  ],
  medicoes_semana_lista: [
    { data: '2026-09-18', placa: 'BH1A23', posicao: '2EE', menor_sulco: 3.1, status: 'Critico' },
    { data: '2026-09-18', placa: 'BH1A23', posicao: '2EI', menor_sulco: 5.0, status: 'Alerta' },
    { data: '2026-09-18', placa: 'UN4B56', posicao: '1E', menor_sulco: 5.4, status: 'Alerta' },
    { data: '2026-09-17', placa: 'AP7C89', posicao: '3DE', menor_sulco: 9.2, status: 'OK' },
    { data: '2026-09-17', placa: 'AP7C89', posicao: '1E', menor_sulco: 10, status: 'OK' },
  ],
  estoque: [
    { fogo: '8821', marca: 'Michelin', modelo: 'XZE2', medida: '295/80', padrao: 'Misto', vida: 'Novo', sulco: 14 },
    { fogo: '8822', marca: 'Goodyear', modelo: 'KMAX', medida: '295/80', padrao: 'Direcional', vida: '1a recap', sulco: 11 },
  ],
  em_recapagem: [
    { fogo: '7704', marca: 'Pirelli', modelo: 'FH01', vida: '1a recap', sulco: 3.2, placa_origem: 'BH1A23' },
  ],
  historico: [
    { data: '2026-09-18', tipo_label: 'Envio a recap', fogo: '7704', placa: 'BH1A23', posicao: '2EE', detalhes: 'Retirado para recap' },
  ],
  descarte: [],
};

const buffer = await gerarPdfRelatorioSemanal(dados);
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/Preview-Frota-Visual.pdf');
writeFileSync(out, buffer);
console.log('PDF:', out);
