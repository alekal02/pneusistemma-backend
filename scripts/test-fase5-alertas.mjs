/**
 * Fase 5 — alertas e ações por perfil.
 * Sem banco: node scripts/test-fase5-alertas.mjs
 */
import assert from 'node:assert/strict';
import { sugerirAcao } from '../src/diagnostico.js';
import { getLimitesPorPerfil } from '../src/limites.js';
import {
  avaliarAlertaPerfil,
  classeAlerta,
  especificacaoMedicao,
  prepararMedicao,
  rotuloAlerta,
  textoMensagemAlerta,
} from '../src/medicao-perfil.js';

const limitesCaminhao = getLimitesPorPerfil('caminhao');
const limitesTrator = getLimitesPorPerfil('trator');
const limitesIndustrial = {
  perfil: 'industrial',
  sulco_critico_mm: 2,
  sulco_alerta_mm: 5,
};

function pontos(ext, cent, int, aux) {
  return {
    sulco_externo: ext,
    sulco_central: cent,
    sulco_interno: int,
    sulco_auxiliar: aux,
    km_veiculo: 1000,
    hr_veiculo: 100,
  };
}

const candidatos = [{
  id: 9,
  posicao: '1D',
  numero_fogo: '90',
  sulco_externo: 8,
  sulco_central: 8,
  sulco_interno: 8,
  sulco_auxiliar: 8,
}];

assert.equal(especificacaoMedicao('Compactador').codigo, 'caminhao');
assert.equal(especificacaoMedicao('Trator').codigo, 'trator');
assert.equal(especificacaoMedicao('Trator').unidade, 'horas');
assert.equal(especificacaoMedicao('Mini carregadeira').codigo, 'industrial');
assert.equal(especificacaoMedicao('Giro zero').codigo, 'industrial');

const critico = prepararMedicao(pontos(2, 2, 2, 2), { tipo: 'Compactador', posicao: '1E' });
const diretoCritico = sugerirAcao(2, limitesCaminhao, 0, { pontos: pontos(2, 2, 2, 2), posicaoAtual: '1E' });
assert.equal(critico.acao.codigo, 'troca');
assert.equal(critico.acao.codigo, diretoCritico.codigo);
assert.equal(critico.acao.motivo, diretoCritico.motivo);
assert.equal(critico.status_sulco, 'critico');
assert.equal(critico.notificar, true);
assert.ok(critico.alertas.some((a) => a.codigo === 'sulco_critico'));
assert.equal(critico.acao.rodizio_sugestao, null);

const monitor = prepararMedicao(pontos(6, 6, 6, 6), { tipo: 'Compactador' });
const diretoMonitor = sugerirAcao(6, limitesCaminhao, 0, { pontos: pontos(6, 6, 6, 6) });
assert.equal(monitor.acao.codigo, 'monitorar');
assert.equal(monitor.acao.codigo, diretoMonitor.codigo);
assert.equal(monitor.acao.prazo_recap_dias, diretoMonitor.prazo_recap_dias);
assert.ok(monitor.alertas.some((a) => a.codigo === 'monitoramento'));
assert.ok(monitor.alertas.some((a) => a.codigo === 'recapagem'));

const irregular = prepararMedicao(pontos(10, 10, 10, 4), {
  tipo: 'Compactador',
  posicao: '1E',
  candidatos,
});
assert.equal(irregular.acao.codigo, 'rodizio');
assert.ok(irregular.acao.rodizio_sugestao);
assert.ok(irregular.alertas.some((a) => a.codigo === 'rodizio'));
assert.ok(irregular.alertas.some((a) => a.codigo === 'desgaste_irregular'));

const progressivo = prepararMedicao(pontos(4, 8, 10, 10), { tipo: 'Compactador', posicao: '1E' });
assert.equal(progressivo.acao.codigo, 'monitorar');
assert.equal(progressivo.acao.rodizio_sugestao, null);
assert.equal(progressivo.alertas.some((a) => a.codigo === 'rodizio'), false);

const pressao = prepararMedicao(pontos(10, 8, 10, 10), { tipo: 'Compactador' });
assert.equal(pressao.diagnostico.codigo, 'falta_calib');
assert.ok(pressao.alertas.some((a) => a.codigo === 'pressao'));
assert.equal(pressao.acao.codigo, 'monitorar');

const tratorCritico = prepararMedicao(pontos(8, 8, 8, 8), {
  tipo: 'Trator',
  posicao: '1E',
  candidatos,
});
assert.equal(tratorCritico.status_sulco, 'critico');
assert.equal(tratorCritico.acao.codigo, 'substituir');
assert.equal(tratorCritico.acao.label, 'Programar substituição');
assert.match(tratorCritico.acao.motivo, /horas/);
assert.equal(tratorCritico.acao.rodizio_sugestao, null);
assert.equal(tratorCritico.acao.prazo_recap_dias, undefined);
assert.equal(tratorCritico.notificar, true);
assert.equal(tratorCritico.acao.codigo === 'rodizio', false);
assert.equal(tratorCritico.acao.codigo === 'recap', false);
assert.equal(tratorCritico.desgaste_mm_km, null);

const tratorMonitor = avaliarAlertaPerfil(pontos(12, 12, 12, 12), {
  tipo: 'Trator',
  limites: limitesTrator,
});
assert.equal(tratorMonitor.acao.codigo, 'monitorar');
assert.match(tratorMonitor.acao.motivo, /Reinspecionar em horas/);
assert.equal(tratorMonitor.acao.prazo_recap_dias, undefined);
assert.equal(tratorMonitor.alertas.some((a) => a.codigo === 'recapagem'), false);

const tratorDif = avaliarAlertaPerfil(pontos(20, 20, 20, 12), {
  tipo: 'Trator',
  posicao: '1E',
  candidatos,
  limites: limitesTrator,
});
assert.equal(tratorDif.acao.codigo, 'verificar_desgaste');
assert.equal(tratorDif.acao.label, 'Verificar desgaste');
assert.match(tratorDif.acao.motivo, /Diferença/);
assert.equal(tratorDif.acao.rodizio_sugestao, null);

const tratorReinspecao = avaliarAlertaPerfil(pontos(20, 20, 18, 20), {
  tipo: 'Trator',
  limites: limitesTrator,
});
assert.equal(tratorReinspecao.acao.codigo, 'reinspecionar');
assert.match(tratorReinspecao.acao.motivo, /horas/);
assert.equal(tratorReinspecao.notificar, true);

const miniCorte = prepararMedicao({
  sulco_mm: 6,
  hr_veiculo: 40,
  inspecao_danos: ['corte'],
}, { tipo: 'Mini carregadeira' });
assert.equal(miniCorte.status_sulco, null);
assert.equal(miniCorte.diagnostico.codigo, null);
assert.equal(miniCorte.acao.codigo, 'corte');
assert.match(miniCorte.acao.motivo, /Corte/);
assert.match(miniCorte.acao.motivo, /horímetro/);
assert.equal(miniCorte.acao.rodizio_sugestao, null);
assert.equal(miniCorte.notificar, true);
assert.equal(classeAlerta(miniCorte.alerta), 'critico');

const miniLateral = avaliarAlertaPerfil({
  sulco_mm: 6,
  inspecao_danos: ['dano_lateral'],
}, { tipo: 'Mini carregadeira' });
assert.equal(miniLateral.acao.codigo, 'dano_lateral');
assert.match(miniLateral.acao.motivo, /Dano lateral/);

const miniIrregular = avaliarAlertaPerfil({
  sulco_mm: 6,
  inspecao_danos: ['desgaste_irregular'],
}, { tipo: 'giro_zero' });
assert.equal(miniIrregular.acao.codigo, 'desgaste_irregular');
assert.match(miniIrregular.acao.motivo, /Desgaste irregular/);
assert.equal(miniIrregular.severidade, 'alerta');

const miniOutro = avaliarAlertaPerfil({
  sulco_mm: 6,
  inspecao_danos: { itens: ['outro'], outro: 'rasgo na banda' },
}, { tipo: 'Giro zero' });
assert.equal(miniOutro.acao.codigo, 'avaliar');
assert.equal(miniOutro.acao.label, 'Inspecionar e avaliar');
assert.match(miniOutro.acao.motivo, /rasgo na banda/);
assert.match(miniOutro.acao.motivo, /inspeção e avaliação/);
assert.equal(miniOutro.status_sulco, null);

const miniSemLimite = avaliarAlertaPerfil({ sulco_mm: 1 }, { tipo: 'Mini carregadeira' });
assert.equal(miniSemLimite.status_sulco, null);
assert.equal(miniSemLimite.acao.codigo, null);
assert.equal(miniSemLimite.notificar, false);
assert.equal(classeAlerta(miniSemLimite), 'sem_classificacao');
assert.equal(rotuloAlerta(miniSemLimite, true), 'Sem classificacao');

const miniCritico = avaliarAlertaPerfil({ sulco_mm: 1 }, {
  tipo: 'Mini carregadeira',
  limites: limitesIndustrial,
});
assert.equal(miniCritico.status_sulco, 'critico');
assert.equal(miniCritico.acao.codigo, 'substituir');
assert.equal(miniCritico.acao.codigo === 'troca', false);
assert.equal(miniCritico.acao.codigo === 'recap', false);
assert.equal(miniCritico.notificar, true);

const miniAlerta = avaliarAlertaPerfil({ sulco_mm: 4 }, {
  tipo: 'Giro zero',
  limites: limitesIndustrial,
});
assert.equal(miniAlerta.status_sulco, 'alerta');
assert.equal(miniAlerta.acao.codigo, 'monitorar');
assert.match(miniAlerta.acao.motivo, /horas/);
assert.equal(miniAlerta.alertas.some((a) => a.codigo === 'recapagem' || a.codigo === 'rodizio'), false);

const miniOk = avaliarAlertaPerfil({ sulco_mm: 9 }, {
  tipo: 'Mini carregadeira',
  limites: limitesIndustrial,
});
assert.equal(miniOk.status_sulco, 'ok');
assert.equal(miniOk.notificar, false);
assert.equal(classeAlerta(miniOk), 'ok');

const miniAmbos = avaliarAlertaPerfil({
  sulco_mm: 1,
  inspecao_danos: ['corte'],
}, { tipo: 'Mini carregadeira', limites: limitesIndustrial });
assert.equal(miniAmbos.acao.codigo, 'substituir');
assert.ok(miniAmbos.alertas.some((a) => a.codigo === 'corte'));
assert.ok(miniAmbos.alertas.some((a) => a.codigo === 'substituir'));
assert.equal(miniAmbos.acao.rodizio_sugestao, null);

const msgTrator = textoMensagemAlerta(tratorCritico.alerta, {
  veiculo: { placa: 'TRT1A23' },
  pneu: { posicao: '1E', numero_fogo: '10' },
  menorSulco: 8,
});
assert.match(msgTrator, /Programar substituição/);
assert.match(msgTrator, /horas/);
assert.equal(/recapagem/i.test(msgTrator), false);
assert.equal(msgTrator.includes('CRÍTICO — TROCAR'), false);
assert.equal(msgTrator.includes('compras e recapagens'), false);

const msgMini = textoMensagemAlerta(miniCorte.alerta, {
  veiculo: { placa: 'MIN1' },
  pneu: { posicao: 'DE' },
  menorSulco: 6,
});
assert.match(msgMini, /Corte/);
assert.equal(/rodízio|recapagem/i.test(msgMini), false);
assert.equal(msgMini.includes('Sulco mínimo'), false);

const msgCaminhao = textoMensagemAlerta(critico.alerta, {
  veiculo: { placa: 'ABC1D23' },
  pneu: { posicao: '1E' },
  menorSulco: 2,
});
assert.match(msgCaminhao, /Trocar|trocar|Crítico/);
assert.equal(msgCaminhao.includes('compras e recapagens'), false);

console.log('fase 5 ok');
