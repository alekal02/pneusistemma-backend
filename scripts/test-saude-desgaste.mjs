/**
 * Testes locais da saúde e desgaste. Não grava e não migra.
 * Se o PostgreSQL for localhost, faz uma leitura do relatório e encerra.
 */
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { separarPorCiclo } from '../src/services/pneu-ciclo.js';
import {
  gerarPdfSaudeBuffer,
  textoCompraNova,
  textoConsolidadoFrota,
  textoVeiculosUnidade,
} from '../src/services/saude-desgaste-pdf.js';
import {
  aplicarComparacao,
  avaliarElegibilidadeRecap,
  calcularConsumoEProjecao,
  classificarDesgasteBanda,
  faixaRecapagemCaminhao,
  menorSulcoBanda,
  montarAnalisePneu,
  montarPrevisaoFilial,
  necessidadeCompra,
  normalizarMedida,
} from '../src/services/saude-desgaste.js';
import {
  alertaCompraIncompleta,
  contextoEquipamento,
  filialForaDoIndicadorExecutivo,
} from '../src/services/saude-desgaste-relatorio.js';

function med(parcial) {
  return {
    id: parcial.id,
    data_medicao: parcial.data,
    sulco_externo: parcial.ext ?? null,
    sulco_central: parcial.cent ?? null,
    sulco_interno: parcial.int ?? null,
    sulco_auxiliar: parcial.aux ?? null,
    km_veiculo: parcial.km ?? null,
    hr_veiculo: parcial.hr ?? null,
    ciclo: parcial.ciclo ?? null,
  };
}

assert.equal(faixaRecapagemCaminhao(8.01), 'acompanhamento_normal');
assert.equal(faixaRecapagemCaminhao(8), 'monitoramento_preventivo');
assert.equal(faixaRecapagemCaminhao(5.01), 'monitoramento_preventivo');
assert.equal(faixaRecapagemCaminhao(5), 'programar_recapagem');
assert.equal(faixaRecapagemCaminhao(3.01), 'programar_recapagem');
assert.equal(faixaRecapagemCaminhao(3), 'critico');
assert.equal(faixaRecapagemCaminhao(1.6), 'critico');
assert.equal(faixaRecapagemCaminhao(null), 'sem_medicao');

assert.equal(menorSulcoBanda({ sulco_externo: 10, sulco_central: 9, sulco_interno: 11, sulco_auxiliar: 1 }), 9);
assert.equal(menorSulcoBanda({ sulco_externo: null, sulco_central: 4, sulco_interno: 9, sulco_auxiliar: 1 }), 4);
assert.equal(menorSulcoBanda({ sulco_auxiliar: 2, sulco_mm: 2 }), null);

const critico = avaliarElegibilidadeRecap({
  faixa: 'critico',
  reguaRecap: true,
  papel: 'tracao',
  statusPneu: 'montado',
  danos: [],
  cicloConfiavel: true,
});
assert.equal(critico.apto_recapagem, false);
assert.equal(critico.candidato_programacao, false);
assert.equal(critico.envio_automatico, false);
assert.equal(critico.encaminhamento, 'retirada_avaliacao_urgente');

const dianteira = avaliarElegibilidadeRecap({
  faixa: 'programar_recapagem',
  reguaRecap: true,
  papel: 'direcional',
  statusPneu: 'montado',
});
assert.equal(dianteira.candidato_programacao, false);
assert.ok(dianteira.bloqueios.some((b) => /dianteira/i.test(b)));

const comCorte = avaliarElegibilidadeRecap({
  faixa: 'programar_recapagem',
  reguaRecap: true,
  papel: 'tracao',
  statusPneu: 'montado',
  danos: ['corte'],
  cicloConfiavel: true,
});
assert.equal(comCorte.candidato_programacao, false);

const candidato = avaliarElegibilidadeRecap({
  faixa: 'programar_recapagem',
  reguaRecap: true,
  papel: 'tracao',
  statusPneu: 'montado',
  danos: [],
  cicloConfiavel: true,
  vidaRecap: 1,
  maxRecaps: 6,
});
assert.equal(candidato.candidato_programacao, true);
assert.equal(candidato.apto_recapagem, false);
assert.equal(candidato.envio_automatico, false);

const irregular = classificarDesgasteBanda({ sulco_externo: 8, sulco_central: 4, sulco_interno: 8 });
assert.equal(irregular.padrao, 'irregular');
assert.ok(irregular.hipoteses.every((h) => /hipótese/i.test(h.texto)));
assert.ok(irregular.hipoteses.every((h) => !/falta de calibragem/i.test(h.texto)));

const progressivo = classificarDesgasteBanda({ sulco_externo: 6, sulco_central: 7, sulco_interno: 8 });
assert.equal(progressivo.padrao, 'progressivo');
assert.match(progressivo.hipoteses[0].texto, /não é diagnóstico/i);

const uniforme = classificarDesgasteBanda({ sulco_externo: 7.2, sulco_central: 7, sulco_interno: 7.4 });
assert.equal(uniforme.padrao, 'uniforme');
assert.equal(uniforme.hipoteses.length, 0);

const curto = calcularConsumoEProjecao([
  med({ id: 1, data: '2026-01-01', ext: 12, cent: 12, int: 12, km: 1000 }),
  med({ id: 2, data: '2026-02-01', ext: 10, cent: 10, int: 10, km: 1050 }),
], { unidade: 'km', reguaRecap: true });
assert.equal(curto.confiavel, false);
assert.equal(curto.projecao.disponivel, false);
assert.equal(curto.mm_por_1000_km, 40);

const proj = calcularConsumoEProjecao([
  med({ id: 1, data: '2026-01-01', ext: 10, cent: 10, int: 10, km: 10000 }),
  med({ id: 2, data: '2026-02-01', ext: 8, cent: 8, int: 8, km: 11000 }),
], { unidade: 'km', reguaRecap: true });
assert.equal(proj.confiavel, true);
assert.equal(proj.mm_por_1000_km, 2);
assert.equal(proj.projecao.disponivel, true);
assert.equal(proj.projecao.alvo_5.ja_atingido, false);
assert.equal(proj.projecao.alvo_5.uso_restante, 1500);
assert.ok(proj.projecao.alvo_5.data);
assert.equal(proj.projecao.alvo_3.uso_restante, 2500);

const semData = calcularConsumoEProjecao([
  med({ id: 1, data: '2026-01-01', ext: 10, cent: 10, int: 10, km: 10000 }),
  med({ id: 2, data: '2026-01-05', ext: 8, cent: 8, int: 8, km: 11000 }),
], { unidade: 'km', reguaRecap: true });
assert.equal(semData.projecao.alvo_5.data, null);
assert.equal(semData.projecao.alvo_5.uso_restante, 1500);

const subiu = calcularConsumoEProjecao([
  med({ id: 1, data: '2026-01-01', ext: 8, cent: 8, int: 8, km: 1000 }),
  med({ id: 2, data: '2026-03-01', ext: 12, cent: 12, int: 12, km: 5000 }),
], { unidade: 'km', reguaRecap: true });
assert.equal(subiu.confiavel, false);
assert.equal(subiu.projecao.disponivel, false);

const horas = calcularConsumoEProjecao([
  med({ id: 1, data: '2026-01-01', ext: 20, cent: 20, int: 20, hr: 100 }),
  med({ id: 2, data: '2026-03-01', ext: 18, cent: 18, int: 18, hr: 200 }),
], { unidade: 'horas', reguaRecap: false });
assert.equal(horas.mm_por_100_h, 2);
assert.equal(horas.mm_por_1000_km, null);
assert.equal(horas.projecao.disponivel, false);

const ciclo0 = [
  med({ id: 1, data: '2026-01-01', ext: 14, cent: 14, int: 14, km: 1000, ciclo: 0 }),
  med({ id: 2, data: '2026-02-01', ext: 12, cent: 12, int: 12, km: 2000, ciclo: 0 }),
];
const ciclo1 = [
  med({ id: 3, data: '2026-04-01', ext: 13, cent: 13, int: 13, km: 5000, ciclo: 1 }),
];
const separacao = separarPorCiclo({
  medicoes: [...ciclo0, ...ciclo1],
  movimentacoes: [{ id: 1, tipo: 'enviar_recap', data_evento: '2026-03-01', ciclo: 0 }],
});
const analise = montarAnalisePneu({
  id: 7,
  vida_recap: 1,
  status_pneu: 'montado',
  medida: '275/80R22.5',
  filial_id: 1,
}, {
  medicoes: [...ciclo0, ...ciclo1],
  separacao,
  perfil: 'caminhao',
  unidade: 'km',
  permiteRecap: true,
  papel: 'tracao',
  maxRecaps: 6,
  danos: [],
});
assert.equal(analise.ciclo_atual, 1);
assert.equal(analise.consumo.confiavel, false);
assert.notEqual(analise.consumo.mm_por_1000_km, 0.5);
assert.ok(analise.evolucao.length >= 2);

const misturado = montarAnalisePneu({
  id: 8,
  vida_recap: 2,
  status_pneu: 'montado',
  filial_id: 1,
}, {
  medicoes: [
    med({ id: 1, data: '2026-01-01', ext: 14, cent: 14, int: 14, km: 1000 }),
    med({ id: 2, data: '2026-06-01', ext: 6, cent: 6, int: 6, km: 20000 }),
  ],
  separacao: separarPorCiclo({
    medicoes: [
      med({ id: 1, data: '2026-01-01', ext: 14, cent: 14, int: 14, km: 1000 }),
      med({ id: 2, data: '2026-06-01', ext: 6, cent: 6, int: 6, km: 20000 }),
    ],
    movimentacoes: [],
  }),
  perfil: 'caminhao',
  unidade: 'km',
  permiteRecap: true,
  papel: 'tracao',
});
assert.equal(misturado.ciclo_confiavel, false);
assert.equal(misturado.consumo.mm_por_1000_km, null);
assert.equal(misturado.evolucao.length, 0);

const basePneu = (id, taxaKm, extra = {}) => {
  const consumo = calcularConsumoEProjecao([
    med({ id: 1, data: '2026-01-01', ext: 12, cent: 12, int: 12, km: 0 }),
    med({ id: 2, data: '2026-03-01', ext: 12 - taxaKm, cent: 12 - taxaKm, int: 12 - taxaKm, km: 1000 }),
  ], { unidade: 'km', reguaRecap: true });
  return {
    id,
    status_pneu: 'montado',
    medida: '275/80R22.5',
    tipo_codigo: 'truck_tracao',
    papel: 'tracao',
    vida_recap: 0,
    ciclo_atual: 0,
    consumo,
    ...extra,
  };
};
const grupo = [basePneu(1, 1), basePneu(2, 1), basePneu(3, 4)];
const cmp = aplicarComparacao(grupo);
assert.equal(cmp.acima_da_media, 1);
assert.equal(grupo[2].comparacao.acima, true);
assert.equal(grupo[0].comparacao.acima, false);
const pequeno = [basePneu(4, 5), basePneu(5, 1)];
aplicarComparacao(pequeno);
assert.equal(pequeno[0].comparacao.aplicavel, false);

const direcional = {
  status_pneu: 'montado',
  papel: 'direcional',
  faixa: 'programar_recapagem',
  filial_id: 3,
  medida: '275/80R22.5',
  condicao: 'novo',
  elegibilidade: { candidato_programacao: false, encaminhamento: null, bloqueios: ['dianteira'] },
  regua_recap: true,
  consumo: { projecao: {} },
};
assert.equal(necessidadeCompra(direcional), true);
const previsao = montarPrevisaoFilial([
  direcional,
  { ...direcional, id: 2, status_pneu: 'estoque', faixa: 'sem_medicao', papel: null, condicao: 'novo' },
]);
assert.equal(previsao[0].necessidade_pneu_novo, 1);
assert.equal(previsao[0].estoque_novo, 1);
assert.equal(previsao[0].comprar_novo, 0);
assert.equal(previsao[0].candidatos_recap, 0);

assert.equal(normalizarMedida('275/80/22,5'), normalizarMedida('275/80/22.5'));
const grafia = montarPrevisaoFilial([
  ...Array.from({ length: 6 }, (_, i) => ({ ...direcional, id: i + 1, medida: '275/80/22,5', faixa: 'critico' })),
  { ...direcional, id: 8, medida: '275/80/22.5', faixa: 'programar_recapagem' },
  { ...direcional, id: 9, status_pneu: 'estoque', faixa: 'sem_medicao', papel: null, medida: '275/80/22.5', condicao: 'novo' },
]);
assert.equal(grafia.length, 1);
assert.equal(grafia[0].medida, '275/80r22.5');
assert.equal(normalizarMedida('275/80/22.5'), normalizarMedida('275/80R22.5'));
assert.equal(normalizarMedida('12-16-5'), normalizarMedida('12-16.5'));
assert.notEqual(normalizarMedida('275/80'), normalizarMedida('275/80R22.5'));
assert.notEqual(normalizarMedida('275/80R22'), normalizarMedida('275/80R22.5'));
assert.notEqual(normalizarMedida('275/80R22.6'), normalizarMedida('275/80R22.5'));
assert.equal(grafia[0].necessidade_pneu_novo, 7);
assert.equal(grafia[0].estoque_novo, 1);
assert.equal(grafia[0].comprar_novo, 6);

const unidades = [
  { id: 1, codigo: 'MATRIZ', nome: 'Matriz', ativo: 1 },
  { id: 6, codigo: 'E2E595151', nome: 'Filial Teste E2E 595151', ativo: 0 },
  { id: 7, codigo: 'E2E714384', nome: 'Filial Teste E2E 714384', ativo: 0 },
  { id: 4, codigo: '0501', nome: 'Aparecida', ativo: 1 },
  { id: 12, codigo: '0301', nome: 'Contagem', ativo: 1 },
  { id: 13, codigo: '0102', nome: 'Porto Velho', ativo: 0 },
];
const executivas = unidades.filter((f) => !filialForaDoIndicadorExecutivo(f));
assert.deepEqual(executivas.map((f) => f.codigo), ['0501', '0301', '0102']);
assert.equal(filialForaDoIndicadorExecutivo({ codigo: 'E2E9', nome: 'E2E ativa', ativo: 1 }), false);

const alerta = alertaCompraIncompleta(21);
assert.equal(alerta.definitivo, false);
assert.match(alerta.texto, /não é definitiva/);
assert.equal(alertaCompraIncompleta(0).definitivo, true);
assert.equal(alertaCompraIncompleta(0).texto, null);

const mini = contextoEquipamento({
  tipo_codigo: 'mini_carregadeira',
  tipo: 'Truck / Tração',
  layout_pneus: 'utilitario_4',
});
assert.equal(mini.perfil, 'industrial');
assert.equal(mini.unidade, 'horas');
assert.equal(mini.permiteRecap, false);
const truck = contextoEquipamento({
  tipo_codigo: 'truck_tracao',
  tipo: 'Truck / Tração',
  layout_pneus: 'truck_10',
});
assert.equal(truck.perfil, 'caminhao');
assert.equal(truck.unidade, 'km');
assert.equal(truck.permiteRecap, true);

const medsInd = [
  med({ id: 1, data: '2026-01-01', ext: 12, cent: 12, int: 12, hr: 100 }),
  med({ id: 2, data: '2026-03-01', ext: 10, cent: 10, int: 10, hr: 200 }),
];
const industrial = montarAnalisePneu({ id: 3, status_pneu: 'montado', vida_recap: 0 }, {
  medicoes: medsInd,
  separacao: separarPorCiclo({ medicoes: medsInd, movimentacoes: [] }),
  perfil: mini.perfil,
  unidade: mini.unidade,
  permiteRecap: mini.permiteRecap,
  papel: 'tracao',
});
assert.equal(industrial.faixa, 'sem_regua');
assert.equal(industrial.consumo.mm_por_100_h, 2);
assert.equal(industrial.consumo.mm_por_1000_km, null);
assert.equal(industrial.elegibilidade.candidato_programacao, false);
assert.equal(industrial.elegibilidade.apto_recapagem, false);
assert.equal(necessidadeCompra(direcional), true);

const pdf = await gerarPdfSaudeBuffer({
  gerado_em: '2026-10-19T12:00:00.000Z',
  consolidado: { filiais: 1, veiculos: 1, pneus_montados: 1, faixas: { critico: 1 }, uniformes: 0, irregulares: 0, candidatos_recap: 0, avaliacao_urgente: 1, acima_da_media: 0, sem_projecao_caminhao: 1 },
  por_unidade: [],
  por_veiculo: [],
  pneus: [],
  compras_por_filial: [],
  limitacoes: ['Teste local'],
});
assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
assert.equal(textoCompraNova({ recomendacao_definitiva: true, montados_sem_medida: 0, comprar_novo: 2 }), '2');
assert.equal(textoCompraNova({ recomendacao_definitiva: false, montados_sem_medida: 0, comprar_novo: 2 }), 'não definitiva');
assert.equal(textoCompraNova({ recomendacao_definitiva: true, montados_sem_medida: 4, comprar_novo: 2 }), 'não definitiva');
assert.match(textoConsolidadoFrota({ filiais: 1, veiculos_cadastrados: 5, veiculos: 2, pneus_montados: 4 }), /Veículos cadastrados: 5/);
assert.match(textoConsolidadoFrota({ filiais: 1, veiculos_cadastrados: 5, veiculos: 2, pneus_montados: 4 }), /Com pneu montado: 2/);
assert.equal(textoVeiculosUnidade({ veiculos_cadastrados: 5, veiculos: 2 }), '5 cadastrado(s), 2 com pneu montado');

console.log('test-saude-desgaste: cálculos ok');

function hostLocal(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

const urlLeitura = String(process.env.DATABASE_URL || '').trim();
if (!hostLocal(urlLeitura)) {
  console.log('leitura do banco ignorada: DATABASE_URL não é localhost');
  process.exit(0);
}

const { createPool, closePool } = await import('../src/pg-db.js');
const { getDb } = await import('../src/database.js');
const { refreshLimitesCache } = await import('../src/limites.js');
const { carregarRelatorioSaude } = await import('../src/services/saude-desgaste-relatorio.js');

createPool(config.databaseUrl);
try {
  await refreshLimitesCache();
  const rel = await carregarRelatorioSaude(getDb(), {});
  const criticosAptos = (rel.pneus || []).filter((p) => (
    (p.faixa === 'critico' || p.faixa === 'critico_equipamento') && p.elegibilidade?.apto_recapagem
  ));
  assert.equal(criticosAptos.length, 0);
  const codigos = (rel.por_unidade || []).map((u) => String(u.codigo || '').toUpperCase());
  assert.equal(codigos.includes('MATRIZ'), false);
  assert.equal(codigos.some((c) => c.startsWith('E2E')), false);
  const somaFaixas = Object.values(rel.consolidado.faixas || {}).reduce((s, n) => s + n, 0);
  assert.equal(somaFaixas, rel.consolidado.pneus_montados);
  const envioAuto = (rel.pneus || []).filter((p) => p.elegibilidade?.envio_automatico).length;
  assert.equal(envioAuto, 0);
  console.log(JSON.stringify({
    filiais: rel.consolidado.filiais,
    veiculos: rel.consolidado.veiculos,
    montados: rel.consolidado.pneus_montados,
    faixas: rel.consolidado.faixas,
    irregulares: rel.consolidado.irregulares,
    acima_da_media: rel.consolidado.acima_da_media,
    candidatos_recap: rel.consolidado.candidatos_recap,
    avaliacao_urgente: rel.consolidado.avaliacao_urgente,
    sem_projecao: rel.consolidado.sem_projecao_caminhao,
    ciclo_nao_separado: rel.consolidado.ciclo_nao_separado,
    compras: (rel.compras_por_filial || []).length,
  }));
} catch (err) {
  if (err?.code === 'ECONNREFUSED' || err?.errors?.some?.((e) => e.code === 'ECONNREFUSED')) {
    console.log('PostgreSQL local indisponível. Cálculos testados sem leitura da frota.');
    process.exit(0);
  }
  throw err;
} finally {
  await closePool().catch(() => {});
}
