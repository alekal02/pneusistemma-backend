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
  textoCondicaoUnidade,
  textoConsolidadoFrota,
  textoLeituraSulco,
  textoParecer,
  textoVeiculosUnidade,
} from '../src/services/saude-desgaste-pdf.js';
import {
  aplicarComparacao,
  avaliarElegibilidadeRecap,
  calcularConsumoEProjecao,
  cicloMensalDe,
  classificarDesgasteBanda,
  evolucaoMensal,
  faixaRecapagemCaminhao,
  leituraSulco,
  menorSulcoBanda,
  montarAnalisePneu,
  montarParecerExecutivo,
  montarPrevisaoFilial,
  necessidadeCompra,
  normalizarMedida,
  pontosLeituraSulco,
} from '../src/services/saude-desgaste.js';
import {
  alertaCompraIncompleta,
  contagemCondicao,
  contextoEquipamento,
  filialForaDoIndicadorExecutivo,
  montadoIncompleto,
  resumirLeituraSulco,
  situacaoAtualizacaoMensal,
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

assert.equal(menorSulcoBanda({ sulco_externo: 10, sulco_central: 9, sulco_interno: 11, sulco_auxiliar: 1 }), 1);
assert.equal(menorSulcoBanda({ sulco_externo: null, sulco_central: 4, sulco_interno: 9, sulco_auxiliar: 1 }), 1);
assert.equal(menorSulcoBanda({ sulco_auxiliar: 2, sulco_mm: 2 }), 2);
assert.equal(menorSulcoBanda({ sulco_mm: 2 }), null);
assert.equal(faixaRecapagemCaminhao(menorSulcoBanda({
  sulco_externo: 10, sulco_central: 9, sulco_interno: 11, sulco_auxiliar: 1,
})), 'critico');

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
assert.match(alerta.texto, /necessidade técnica/);
assert.doesNotMatch(alerta.texto, /ignora/);
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
const faixasMistas = {
  acompanhamento_normal: 2,
  acompanhamento_equipamento: 1,
  monitoramento_preventivo: 1,
  monitoramento_equipamento: 1,
  programar_recapagem: 3,
  critico: 2,
  critico_equipamento: 1,
};
const condicaoMista = contagemCondicao(faixasMistas);
const textoCondicao = textoCondicaoUnidade({ faixas: faixasMistas });
assert.match(textoCondicao, new RegExp(`bom estado ${condicaoMista.bom}`));
assert.match(textoCondicao, new RegExp(`atenção ${condicaoMista.atencao}`));
assert.match(textoCondicao, new RegExp(`críticos ${condicaoMista.criticos}`));
assert.match(textoCondicao, /faixa de programar recapagem 3/);
assert.equal(condicaoMista.atencao, 5);
assert.equal(condicaoMista.criticos, 3);

const cicloTeste = cicloMensalDe('2026-10-20');
assert.equal(cicloTeste.inicio, '2026-10-01');
assert.equal(cicloTeste.fim, '2026-10-31');
const sulcoCompleto = { externo: 2.5, central: 3, interno: 2.8 };
const sulcoQuatro = { externo: 10, central: 4, interno: 10, auxiliar: 1 };
assert.equal(pontosLeituraSulco(sulcoCompleto).length, 3);
assert.equal(pontosLeituraSulco(sulcoQuatro).length, 4);
assert.equal(menorSulcoBanda({ sulco_externo: 10, sulco_central: 4, sulco_interno: 10, sulco_auxiliar: 1 }), 1);
assert.notEqual(menorSulcoBanda({ sulco_externo: 10, sulco_central: 4, sulco_interno: 10, sulco_auxiliar: 1 }), 6.25);
assert.equal(leituraSulco({ sulcos: sulcoCompleto, data_medicao: '2026-10-13' }, cicloTeste), 'no_ciclo');
assert.equal(leituraSulco({ sulcos: sulcoQuatro, data_medicao: '2026-10-13' }, cicloTeste), 'no_ciclo');
assert.equal(leituraSulco({ sulcos: sulcoCompleto, data_medicao: '2026-09-25' }, cicloTeste), 'ciclo_anterior');
assert.equal(leituraSulco({ sulcos: sulcoCompleto, data_medicao: '2026-09-10' }, cicloTeste), 'vencida');
assert.equal(leituraSulco({ sulcos: sulcoCompleto, data_medicao: '2026-08-20' }, cicloTeste), 'vencida');
assert.equal(leituraSulco({ sulcos: { externo: null, central: null, interno: null, auxiliar: null }, data_medicao: null }, cicloTeste), 'sem_historico');
assert.equal(leituraSulco({
  sulcos: { externo: null, central: null, interno: null },
  data_medicao: null,
  data_entrada: '2026-10-05',
}, cicloTeste), 'nao_exigivel');
assert.equal(leituraSulco({
  sulcos: { externo: null, central: null, interno: null },
  data_medicao: null,
  data_entrada: '2026-08-01',
}, cicloTeste), 'sem_historico');
assert.equal(leituraSulco({ sulcos: { externo: null, central: null, interno: null }, data_medicao: '2026-10-17' }, cicloTeste), 'invalida');
assert.equal(leituraSulco({ sulcos: { externo: 4, central: null, interno: null }, data_medicao: '2026-10-20' }, cicloTeste), 'parcial');
assert.equal(leituraSulco({
  sulcos: sulcoCompleto,
  data_medicao: '2026-09-10',
  medida: null,
  faixa: 'critico',
}, cicloTeste), 'vencida');
const antigoSemDimensao = {
  status_pneu: 'montado',
  sulcos: sulcoCompleto,
  data_medicao: '2026-09-10',
  medida: '',
  faixa: 'critico',
  leitura_sulco: 'vencida',
  dimensao_comercial: false,
};
assert.equal(montadoIncompleto(antigoSemDimensao), false);
assert.equal(montadoIncompleto({
  status_pneu: 'montado',
  leitura_sulco: 'sem_historico',
}), true);
assert.equal(situacaoAtualizacaoMensal([
  { leitura_sulco: 'no_ciclo', data_medicao: '2026-10-13' },
], cicloTeste).situacao_mes, 'no_ciclo');
assert.equal(situacaoAtualizacaoMensal([
  { leitura_sulco: 'ciclo_anterior', data_medicao: '2026-09-25' },
], cicloTeste).situacao_mes, 'ciclo_anterior');
assert.equal(situacaoAtualizacaoMensal([
  { leitura_sulco: 'vencida', data_medicao: '2026-08-20' },
], cicloTeste).situacao_mes, 'vencida');
assert.equal(situacaoAtualizacaoMensal([
  { leitura_sulco: 'sem_historico', data_medicao: null },
], cicloTeste).situacao_mes, 'sem_medicao');
assert.deepEqual(resumirLeituraSulco([
  { leitura_sulco: 'vencida' },
  { leitura_sulco: 'ciclo_anterior' },
  { leitura_sulco: 'no_ciclo' },
  { leitura_sulco: 'sem_historico' },
], cicloTeste), {
  sem_historico: 1,
  invalida: 0,
  parcial: 0,
  vencida: 1,
  ciclo_anterior: 1,
  no_ciclo: 1,
  nao_exigivel: 0,
});
const compraSemEstoque = montarParecerExecutivo({
  bom: 2, atencao: 0, criticos: 1, necessidade: 2, estoqueNovo: 0, comprarNovo: 2,
  estoqueConferido: true, candidatos: 1, vencidas: 1,
});
assert.equal(compraSemEstoque.quantidade_compra, 2);
assert.equal(compraSemEstoque.recomendacoes.includes('COMPRA RECOMENDADA'), true);
assert.equal(compraSemEstoque.recomendacoes.includes('AVALIAR RECAPAGEM'), true);
assert.equal(compraSemEstoque.recomendacoes.includes('AVALIAÇÃO PRIORITÁRIA'), true);
assert.match(compraSemEstoque.substituicao, /não apaga essa necessidade/);
assert.match(compraSemEstoque.recapagem, /inspeção técnica da carcaça/);
const estoqueCobre = montarParecerExecutivo({
  bom: 4, atencao: 0, criticos: 0, necessidade: 2, estoqueNovo: 5, comprarNovo: 0,
  estoqueConferido: true,
});
assert.equal(estoqueCobre.quantidade_compra, null);
assert.deepEqual(estoqueCobre.recomendacoes, ['COMPRA NÃO NECESSÁRIA NO MOMENTO']);
const semConferencia = montarParecerExecutivo({
  bom: 0, atencao: 0, criticos: 2, necessidade: 2, estoqueNovo: 0, comprarNovo: 2,
  estoqueConferido: false,
});
assert.equal(semConferencia.quantidade_compra, null);
assert.equal(semConferencia.recomendacoes.includes('COMPRA RECOMENDADA'), false);
assert.match(semConferencia.compra, /não está fechada/);
const historicoCurto = evolucaoMensal([med({ id: 1, data: '2026-10-13', ext: 8, cent: 8, int: 8 })]);
assert.equal(historicoCurto.disponivel, false);
assert.equal(historicoCurto.delta_mm, null);
assert.match(historicoCurto.motivo, /insuficiente/);
assert.equal('prazo' in historicoCurto, false);
const historicoMensal = evolucaoMensal([
  med({ id: 1, data: '2026-09-15', ext: 8, cent: 8, int: 8 }),
  med({ id: 2, data: '2026-10-15', ext: 6, cent: 7, int: 6.5 }),
]);
assert.equal(historicoMensal.disponivel, true);
assert.equal(historicoMensal.delta_mm, 2);
assert.match(historicoMensal.texto, /Não é prazo de substituição/);
const novoSemMedicao = montarAnalisePneu({
  id: 9,
  status_pneu: 'montado',
  data_entrada: '2026-10-05',
  vida_recap: 0,
}, { medicoes: [], perfil: 'caminhao', permiteRecap: true, papel: 'tracao' });
assert.equal(novoSemMedicao.menor_sulco, null);
assert.equal(novoSemMedicao.evolucao_mensal.disponivel, false);
assert.match(textoLeituraSulco({
  leitura_sulco: { sem_historico: 0, vencida: 3, ciclo_anterior: 1, no_ciclo: 4, parcial: 0, invalida: 0, nao_exigivel: 0 },
}), /medição mensal vencida 3/);
assert.match(textoLeituraSulco({
  leitura_sulco: { sem_historico: 0, vencida: 3, no_ciclo: 4, parcial: 0, invalida: 0 },
}), /neste mês 4/);
assert.equal(textoLeituraSulco({
  leitura_sulco: { sem_historico: 0, vencida: 144, no_ciclo: 0, parcial: 0, invalida: 0 },
  sem_dimensao_comercial: 144,
}).includes('nesta semana'), false);
assert.equal(textoLeituraSulco({
  leitura_sulco: { sem_historico: 0, vencida: 144, no_ciclo: 0 },
}).includes('sem dimensão comercial'), false);
assert.match(textoParecer(compraSemEstoque), /COMPRA RECOMENDADA/);
assert.match(textoParecer(compraSemEstoque), /AVALIAR RECAPAGEM/);
assert.match(textoParecer(estoqueCobre), /COMPRA NÃO NECESSÁRIA NO MOMENTO/);

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
