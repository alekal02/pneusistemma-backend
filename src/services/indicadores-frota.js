/**
 * Agrega o motor de alertas para dashboard, painel da filial e relatórios.
 * Não cria regra de medição: só lê avaliarAlertaPerfil e separa KM de horas.
 */
import { avaliarAlertaPerfil, classeAlerta } from '../medicao-perfil.js';
import { especificacaoMedicao } from '../medicao-perfil.js';
import { resolverTipoEquipamento } from '../equipamento-tipos.js';
import { papelPosicao } from '../pneus-layouts.js';
import { limitesDoVeiculo } from '../limites.js';

const RANK_STATUS = { critico: 0, alerta: 1, ok: 2, sem_dado: 3 };

export function filtroTipoAtivo(tipo) {
  const t = String(tipo || '').trim();
  return t || null;
}

export function veiculoCombinaTipo(tipoVeiculo, filtro) {
  const alvo = filtroTipoAtivo(filtro);
  if (!alvo) return true;
  const want = resolverTipoEquipamento(alvo);
  const got = resolverTipoEquipamento(tipoVeiculo);
  if (want && got) return want.codigo === got.codigo;
  return String(tipoVeiculo || '').trim().toLowerCase() === alvo.toLowerCase();
}

export function unidadeUsoVeiculo(tipo, layout) {
  return especificacaoMedicao(tipo, layout).unidade === 'horas' ? 'horas' : 'km';
}

function numeroUso(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

export function avaliarPneuPainel(p, { limites, candidatos } = {}) {
  const tipo = p.tipo || p.veiculo_tipo || null;
  const layout = p.layout_pneus || p.layout || null;
  const entrada = {
    sulco_externo: p.sulco_externo ?? p.ult_sulco_ext ?? null,
    sulco_central: p.sulco_central ?? p.ult_sulco_cent ?? null,
    sulco_interno: p.sulco_interno ?? p.ult_sulco_int ?? null,
    sulco_auxiliar: p.sulco_auxiliar ?? p.ult_sulco_aux ?? null,
    sulco_mm: p.sulco_mm ?? p.ult_sulco_mm ?? null,
    inspecao_danos: p.inspecao_danos ?? p.ult_inspecao_danos ?? null,
  };
  return avaliarAlertaPerfil(entrada, {
    tipo,
    layout,
    limites: limites || limitesDoVeiculo({ tipo, layout_pneus: layout }),
    vidaRecap: p.vida_recap || 0,
    candidatos: candidatos || [],
    posicao: p.posicao || null,
    papel: p.posicao ? papelPosicao(p.posicao) : null,
    km_veiculo: p.km_veiculo ?? p.km_atual ?? null,
    hr_veiculo: p.hr_veiculo ?? p.hr_atual ?? null,
  });
}

/** OK | monitorar | critico | sem_dado — a partir da classe do motor. */
export function bucketKpi(aval) {
  const classe = classeAlerta(aval);
  if (classe === 'critico') return 'critico';
  if (classe === 'alerta') return 'monitorar';
  if (classe === 'ok') return 'ok';
  if (aval?.status_sulco === 'critico') return 'critico';
  if (aval?.status_sulco === 'alerta') return 'monitorar';
  if (aval?.status_sulco === 'ok') return 'ok';
  return 'sem_dado';
}

/** Códigos do motor → contadores já usados na UI (troca, recap, monitorar, rodizio). */
export function contarAcaoLegada(codigo) {
  if (codigo === 'troca' || codigo === 'substituir' || codigo === 'corte' || codigo === 'dano_lateral') {
    return 'troca';
  }
  if (codigo === 'recap') return 'recap';
  if (
    codigo === 'monitorar'
    || codigo === 'reinspecionar'
    || codigo === 'verificar_desgaste'
    || codigo === 'avaliar'
    || codigo === 'desgaste_irregular'
  ) return 'monitorar';
  if (codigo === 'rodizio') return 'rodizio';
  return null;
}

export function statusPainel(aval) {
  const kpi = bucketKpi(aval);
  if (kpi === 'monitorar') return 'alerta';
  if (kpi === 'critico') return 'critico';
  if (kpi === 'ok') return 'ok';
  return 'sem_dado';
}

export function piorStatus(atual, proximo) {
  if (!proximo) return atual || 'sem_dado';
  if (!atual) return proximo;
  return (RANK_STATUS[atual] ?? 9) <= (RANK_STATUS[proximo] ?? 9) ? atual : proximo;
}

export function novoAcumulador() {
  return {
    ok: 0, monitorar: 0, critico: 0, sem_dado: 0,
    troca: 0, recap: 0, acao_monitorar: 0, rodizio: 0,
  };
}

export function acumularAlerta(acc, aval) {
  const kpi = bucketKpi(aval);
  if (kpi === 'ok') acc.ok += 1;
  else if (kpi === 'monitorar') acc.monitorar += 1;
  else if (kpi === 'critico') acc.critico += 1;
  else acc.sem_dado += 1;
  const leg = contarAcaoLegada(aval?.acao?.codigo);
  if (leg === 'troca') acc.troca += 1;
  else if (leg === 'recap') acc.recap += 1;
  else if (leg === 'monitorar') acc.acao_monitorar += 1;
  else if (leg === 'rodizio') acc.rodizio += 1;
  return kpi;
}

/** Média só dentro da unidade do tipo. KM e horas nunca entram no mesmo cálculo. */
export function mediaUso(veiculos) {
  let somaKm = 0;
  let nKm = 0;
  let somaHr = 0;
  let nHr = 0;
  for (const v of veiculos || []) {
    const u = unidadeUsoVeiculo(v.tipo || v.veiculo_tipo, v.layout_pneus || v.layout);
    if (u === 'horas') {
      const h = numeroUso(v.hr_atual ?? v.hr_veiculo);
      if (h == null) continue;
      somaHr += h;
      nHr += 1;
    } else {
      const k = numeroUso(v.km_atual ?? v.km_veiculo);
      if (k == null) continue;
      somaKm += k;
      nKm += 1;
    }
  }
  const media = (soma, n) => (n ? Math.round((soma / n) * 10) / 10 : null);
  return {
    km: { veiculos: nKm, media: media(somaKm, nKm) },
    horas: { veiculos: nHr, media: media(somaHr, nHr) },
  };
}

export function indicadoresUso(veiculos, accKm, accHoras) {
  const uso = mediaUso(veiculos);
  const fatia = (acc) => ({
    ok: acc?.ok || 0,
    monitorar: acc?.monitorar || 0,
    critico: acc?.critico || 0,
    sem_dado: acc?.sem_dado || 0,
  });
  return {
    km: { unidade: 'km', ...uso.km, ...fatia(accKm) },
    horas: { unidade: 'horas', ...uso.horas, ...fatia(accHoras) },
  };
}
