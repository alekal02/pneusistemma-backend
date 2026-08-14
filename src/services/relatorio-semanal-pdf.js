/**
 * Relatório PDF semanal gerencial da unidade (frota + pneus).
 */
import PDFDocument from 'pdfkit';
import { getDb } from '../database.js';
import { classificarSulco, getLimites, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao } from '../diagnostico.js';
import {
  labelPosicao,
  labelTipoPneu,
  labelTratamentoDescarte,
  sqlOrderPosicao,
} from '../pneus-layouts.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Data YYYY-MM-DD no fuso local do servidor */
function dataISO(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatBr(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

function formatMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNum(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('pt-BR');
}

/** Segunda-feira da semana corrente até hoje */
export function periodoSemanaCorrente(agora = new Date()) {
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const dia = hoje.getDay(); // 0=dom
  const diffSeg = dia === 0 ? -6 : 1 - dia;
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() + diffSeg);
  return {
    inicio: dataISO(inicio),
    fim: dataISO(hoje),
    label: `${formatBr(dataISO(inicio))} a ${formatBr(dataISO(hoje))}`,
  };
}

function labelStatusSulco(s) {
  return ({
    ok: 'OK',
    alerta: 'Monitorar',
    critico: 'Crítico',
    sem_dado: 'Sem medição',
  })[s] || s || '—';
}

function mm(v) {
  return v == null ? '—' : `${Number(v)} mm`;
}

/**
 * Monta o snapshot gerencial da filial para a semana corrente.
 */
export async function montarDadosRelatorioSemanal(filialId, { geradoPor = null } = {}) {
  const db = getDb();
  const limites = getLimites();
  const periodo = periodoSemanaCorrente();

  const filial = await db.prepare(`
    SELECT id, nome, codigo, contrato FROM filiais WHERE id = ?
  `).get(filialId);
  if (!filial) {
    const err = new Error('Filial não encontrada');
    err.status = 404;
    throw err;
  }

  const veiculos = await db.prepare(`
    SELECT id, placa, apelido, tipo, marca, modelo, ano, layout_pneus,
           km_atual, hr_atual, ativo
    FROM veiculos
    WHERE filial_id = ? AND ativo = 1
    ORDER BY placa
  `).all(filialId);

  const orderPos = sqlOrderPosicao('p.posicao');

  const frota = [];
  let totOk = 0;
  let totAlerta = 0;
  let totCritico = 0;
  let totSemDado = 0;
  let totTroca = 0;
  let totRecap = 0;
  let totMonitorar = 0;
  let totRodizio = 0;
  let totMontados = 0;
  let custoMontado = 0;
  let veiculosAtrasados = 0;

  const prioridadesTroca = [];
  const prioridadesMonitorar = [];
  const prioridadesRodizio = [];

  for (const v of veiculos) {
    const pneus = await db.prepare(`
      SELECT
        p.*,
        m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar,
        m.data_medicao, m.pressao_psi, m.diagnostico as med_diagnostico,
        m.acao_sugerida as med_acao
      FROM pneus p
      LEFT JOIN medicoes m ON m.pneu_id = p.id
        AND m.id = (
          SELECT id FROM medicoes
          WHERE pneu_id = p.id
          ORDER BY data_medicao DESC, id DESC
          LIMIT 1
        )
      WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
      ORDER BY ${orderPos}, p.id
    `).all(v.id);

    const candidatos = pneus.map((p) => ({
      id: p.id,
      posicao: p.posicao,
      sulco_externo: p.sulco_externo,
      sulco_central: p.sulco_central,
      sulco_interno: p.sulco_interno,
      sulco_auxiliar: p.sulco_auxiliar,
    }));

    let ultimaMedicaoVeiculo = null;
    let piorStatus = 'ok';
    const ordemStatus = { critico: 0, alerta: 1, sem_dado: 2, ok: 3 };
    const pneusDetalhe = [];

    for (const p of pneus) {
      totMontados += 1;
      if (p.custo != null) custoMontado += Number(p.custo);

      const pontos = {
        sulco_externo: p.sulco_externo,
        sulco_central: p.sulco_central,
        sulco_interno: p.sulco_interno,
        sulco_auxiliar: p.sulco_auxiliar,
        externo: p.sulco_externo,
        central: p.sulco_central,
        interno: p.sulco_interno,
        auxiliar: p.sulco_auxiliar,
      };
      const menor = menorSulco(pontos);
      const status = classificarSulco(menor);
      const diag = diagnosticarPerfil(pontos, limites.diagnostico_tolerancia_mm, {
        limites,
        posicao: p.posicao,
      });
      const acao = sugerirAcao(menor, limites, p.vida_recap || 0, {
        pontos,
        candidatos,
        posicaoAtual: p.posicao,
      });

      if (status === 'ok') totOk += 1;
      else if (status === 'alerta') totAlerta += 1;
      else if (status === 'critico') totCritico += 1;
      else totSemDado += 1;

      if (acao.codigo === 'troca') totTroca += 1;
      else if (acao.codigo === 'recap') totRecap += 1;
      else if (acao.codigo === 'monitorar') totMonitorar += 1;
      else if (acao.codigo === 'rodizio') totRodizio += 1;

      if (ordemStatus[status] < ordemStatus[piorStatus]) piorStatus = status;
      if (p.data_medicao && (!ultimaMedicaoVeiculo || p.data_medicao > ultimaMedicaoVeiculo)) {
        ultimaMedicaoVeiculo = p.data_medicao;
      }

      const item = {
        fogo: p.numero_fogo || `ID ${p.id}`,
        posicao: p.posicao,
        posicao_label: labelPosicao(p.posicao),
        padrao: labelTipoPneu(p.tipo_pneu),
        marca: p.marca || null,
        modelo: p.modelo || null,
        vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
        sulcos: {
          ext: p.sulco_externo,
          cent: p.sulco_central,
          int: p.sulco_interno,
          aux: p.sulco_auxiliar,
        },
        menor_sulco: menor,
        status_sulco: status,
        status_label: labelStatusSulco(status),
        diagnostico: diag.label || '—',
        acao: acao.label || acao.codigo,
        acao_codigo: acao.codigo,
        motivo: acao.motivo || null,
        data_medicao: p.data_medicao,
        custo: p.custo,
        nota_fiscal: p.nota_fiscal,
        placa: v.placa,
        apelido: v.apelido,
      };
      pneusDetalhe.push(item);

      if (acao.codigo === 'troca' || status === 'critico') {
        prioridadesTroca.push(item);
      } else if (acao.codigo === 'monitorar' || acao.codigo === 'recap' || status === 'alerta') {
        prioridadesMonitorar.push(item);
      } else if (acao.codigo === 'rodizio') {
        prioridadesRodizio.push(item);
      }
    }

    let diasSemMedicao = null;
    if (ultimaMedicaoVeiculo) {
      const diff = Date.now() - new Date(`${ultimaMedicaoVeiculo}T12:00:00`).getTime();
      diasSemMedicao = Math.floor(diff / (1000 * 60 * 60 * 24));
    }
    const atrasado = pneus.length > 0 && (diasSemMedicao == null || diasSemMedicao >= 7);
    if (atrasado) veiculosAtrasados += 1;

    frota.push({
      id: v.id,
      placa: v.placa,
      apelido: v.apelido,
      tipo: v.tipo,
      marca: v.marca,
      modelo: v.modelo,
      layout: v.layout_pneus,
      km_atual: v.km_atual,
      hr_atual: v.hr_atual,
      total_pneus: pneus.length,
      status_sulco: pneus.length ? piorStatus : 'sem_dado',
      status_label: pneus.length ? labelStatusSulco(piorStatus) : 'Sem pneus',
      ultima_medicao: ultimaMedicaoVeiculo,
      dias_sem_medicao: diasSemMedicao,
      atrasado_semana: atrasado,
      pneus: pneusDetalhe,
    });
  }

  const estoque = await db.prepare(`
    SELECT id, numero_fogo, marca, modelo, medida, tipo_pneu, condicao, vida_recap,
           custo, nota_fiscal, sulco_inicial_mm, observacoes
    FROM pneus
    WHERE filial_id = ? AND ativo = 1 AND status_pneu IN ('estoque', 'recapagem')
    ORDER BY numero_fogo NULLS LAST, id DESC
  `).all(filialId);

  let custoEstoque = 0;
  for (const p of estoque) {
    if (p.custo != null) custoEstoque += Number(p.custo);
  }

  const descarte = await db.prepare(`
    SELECT id, numero_fogo, marca, modelo, tipo_pneu, vida_recap, custo, nota_fiscal,
           tratamento_descarte, tratamento_descarte_obs, tratamento_descarte_em, observacoes
    FROM pneus
    WHERE filial_id = ? AND status_pneu = 'descarte'
    ORDER BY tratamento_descarte_em DESC NULLS LAST, id DESC
  `).all(filialId);

  const descartePendentes = descarte.filter(
    (p) => !p.tratamento_descarte || p.tratamento_descarte === 'pendente'
  );

  const medicoesSemana = Number((await db.prepare(`
    SELECT COUNT(*) as n
    FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id
    WHERE p.filial_id = ?
      AND m.data_medicao >= ?
      AND m.data_medicao <= ?
  `).get(filialId, periodo.inicio, periodo.fim)).n);

  return {
    titulo: 'Relatório semanal gerencial — Controle de Pneus',
    gerado_em: new Date().toISOString(),
    gerado_por: geradoPor,
    periodo,
    filial: {
      id: filial.id,
      nome: filial.nome,
      codigo: filial.codigo,
      contrato: filial.contrato || null,
    },
    limites: {
      critico_mm: limites.sulco_critico_mm,
      monitorar_ate_mm: limites.sulco_alerta_mm,
      prazo_recap_dias: limites.prazo_recap_dias,
    },
    resumo: {
      veiculos: veiculos.length,
      pneus_montados: totMontados,
      pneus_estoque: estoque.length,
      pneus_descarte: descarte.length,
      sulco_ok: totOk,
      sulco_monitorar: totAlerta,
      sulco_critico: totCritico,
      sem_medicao: totSemDado,
      acao_trocar: totTroca,
      acao_recap: totRecap,
      acao_monitorar: totMonitorar,
      acao_rodizio: totRodizio,
      medicoes_semana: medicoesSemana,
      veiculos_atrasados_medicao: veiculosAtrasados,
      custo_montado: Math.round(custoMontado * 100) / 100,
      custo_estoque: Math.round(custoEstoque * 100) / 100,
      descarte_aguardando: descartePendentes.length,
    },
    prioridades: {
      troca: prioridadesTroca,
      monitorar: prioridadesMonitorar,
      rodizio: prioridadesRodizio,
      descarte_pendente: descartePendentes.map((p) => ({
        fogo: p.numero_fogo || `ID ${p.id}`,
        marca: p.marca,
        modelo: p.modelo,
        tratamento: labelTratamentoDescarte(p.tratamento_descarte || 'pendente'),
        obs: p.tratamento_descarte_obs,
      })),
    },
    frota,
    estoque: estoque.map((p) => ({
      fogo: p.numero_fogo || `ID ${p.id}`,
      marca: p.marca,
      modelo: p.modelo,
      medida: p.medida,
      padrao: labelTipoPneu(p.tipo_pneu),
      vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
      custo: p.custo,
      nota_fiscal: p.nota_fiscal,
      status: p.status_pneu,
    })),
    descarte: descarte.map((p) => ({
      fogo: p.numero_fogo || `ID ${p.id}`,
      marca: p.marca,
      modelo: p.modelo,
      padrao: labelTipoPneu(p.tipo_pneu),
      vida: p.vida_recap > 0 ? `${p.vida_recap}ª recap` : '—',
      tratamento: labelTratamentoDescarte(p.tratamento_descarte || 'pendente'),
      tratamento_em: p.tratamento_descarte_em,
      obs: p.tratamento_descarte_obs,
      custo: p.custo,
    })),
  };
}

function ensureSpace(doc, need = 60) {
  if (doc.y + need > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function h1(doc, text) {
  ensureSpace(doc, 36);
  doc.fontSize(16).fillColor('#0f172a').font('Helvetica-Bold').text(text, { continued: false });
  doc.moveDown(0.4);
}

function h2(doc, text) {
  ensureSpace(doc, 28);
  doc.fontSize(12).fillColor('#1e293b').font('Helvetica-Bold').text(text);
  doc.moveDown(0.25);
}

function body(doc, text, opts = {}) {
  doc.fontSize(9).fillColor('#334155').font('Helvetica').text(text, {
    lineGap: 1.5,
    ...opts,
  });
}

function kv(doc, label, value) {
  ensureSpace(doc, 14);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#0f172a').text(`${label}: `, { continued: true });
  doc.font('Helvetica').fillColor('#334155').text(String(value ?? '—'));
}

function linhaPrioridade(doc, item) {
  ensureSpace(doc, 18);
  const veiculo = item.placa || item.apelido || '';
  const linha = `${veiculo} · ${item.posicao || '—'} · Fogo ${item.fogo} · ${mm(item.menor_sulco)} · ${item.status_label} · ${item.acao}${item.diagnostico && item.diagnostico !== '—' ? ` · ${item.diagnostico}` : ''}`;
  body(doc, `• ${linha}`);
}

/**
 * Gera Buffer PDF a partir dos dados montados.
 */
export function gerarPdfRelatorioSemanal(dados) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 48, left: 48, right: 48 },
      info: {
        Title: dados.titulo,
        Author: 'PneuSistemma',
        Subject: `Unidade ${dados.filial.nome} — ${dados.periodo.label}`,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const r = dados.resumo;

    // Capa / cabeçalho
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#0f172a')
      .text('Relatório semanal gerencial');
    doc.moveDown(0.2);
    doc.fontSize(11).font('Helvetica').fillColor('#475569')
      .text('Controle de desgaste de pneus — decisão da unidade');
    doc.moveDown(0.6);
    kv(doc, 'Unidade', `${dados.filial.nome} (${dados.filial.codigo})`);
    if (dados.filial.contrato) kv(doc, 'Contrato', dados.filial.contrato);
    kv(doc, 'Período da semana', dados.periodo.label);
    kv(doc, 'Gerado em', new Date(dados.gerado_em).toLocaleString('pt-BR'));
    if (dados.gerado_por) kv(doc, 'Gerado por', dados.gerado_por);
    kv(doc, 'Limites', `crítico ≤ ${dados.limites.critico_mm} mm · monitorar ≤ ${dados.limites.monitorar_ate_mm} mm · prazo recap ${dados.limites.prazo_recap_dias} dias`);
    doc.moveDown(0.5);

    // Resumo executivo
    h1(doc, '1. Resumo executivo');
    body(doc, `Veículos: ${r.veiculos} · Montados: ${r.pneus_montados} · Estoque: ${r.pneus_estoque} · Descarte: ${r.pneus_descarte}`);
    body(doc, `Sulco — OK: ${r.sulco_ok} · Monitorar: ${r.sulco_monitorar} · Crítico: ${r.sulco_critico} · Sem medição: ${r.sem_medicao}`);
    body(doc, `Ações — Trocar: ${r.acao_trocar} · Recap: ${r.acao_recap} · Monitorar: ${r.acao_monitorar} · Rodízio: ${r.acao_rodizio}`);
    body(doc, `Semana — medições registradas: ${r.medicoes_semana} · veículos atrasados (≥7 dias sem medição): ${r.veiculos_atrasados_medicao}`);
    body(doc, `Custos — montados: ${formatMoney(r.custo_montado)} · estoque: ${formatMoney(r.custo_estoque)}`);
    body(doc, `Descarte aguardando destino: ${r.descarte_aguardando}`);
    doc.moveDown(0.4);

    // Prioridades
    h1(doc, '2. Prioridades da semana (decisão)');
    h2(doc, `2.1 Trocar / crítico (${dados.prioridades.troca.length})`);
    if (!dados.prioridades.troca.length) body(doc, 'Nenhum pneu crítico/troca no momento.');
    else dados.prioridades.troca.forEach((i) => linhaPrioridade(doc, i));

    h2(doc, `2.2 Monitorar / recap (${dados.prioridades.monitorar.length})`);
    if (!dados.prioridades.monitorar.length) body(doc, 'Nenhum pneu em monitorar/recap.');
    else dados.prioridades.monitorar.forEach((i) => linhaPrioridade(doc, i));

    h2(doc, `2.3 Rodízio (${dados.prioridades.rodizio.length})`);
    if (!dados.prioridades.rodizio.length) body(doc, 'Nenhum rodízio sugerido.');
    else dados.prioridades.rodizio.forEach((i) => linhaPrioridade(doc, i));

    h2(doc, `2.4 Descarte aguardando destino (${dados.prioridades.descarte_pendente.length})`);
    if (!dados.prioridades.descarte_pendente.length) body(doc, 'Nenhum descarte pendente de tratamento.');
    else {
      dados.prioridades.descarte_pendente.forEach((p) => {
        body(doc, `• Fogo ${p.fogo}${p.marca ? ` · ${p.marca}` : ''}${p.modelo ? ` ${p.modelo}` : ''} — ${p.tratamento}`);
      });
    }
    doc.moveDown(0.3);

    // Frota
    h1(doc, '3. Frota — veículo a veículo');
    if (!dados.frota.length) body(doc, 'Nenhum veículo ativo nesta unidade.');
    for (const v of dados.frota) {
      ensureSpace(doc, 70);
      h2(doc, `${v.placa}${v.apelido ? ` — ${v.apelido}` : ''}`);
      body(doc, [
        v.tipo || null,
        v.marca || v.modelo ? [v.marca, v.modelo].filter(Boolean).join(' ') : null,
        `KM ${formatNum(v.km_atual)}`,
        v.hr_atual != null ? `HR ${formatNum(v.hr_atual)}` : null,
        `${v.total_pneus} pneus`,
        `status ${v.status_label}`,
        `última medição ${formatBr(v.ultima_medicao)}`,
        v.atrasado_semana ? 'ATRASADO (≥7 dias)' : null,
      ].filter(Boolean).join(' · '));

      if (!v.pneus.length) {
        body(doc, '  (sem pneus montados)');
        continue;
      }
      for (const p of v.pneus) {
        ensureSpace(doc, 36);
        body(doc, `  ${p.posicao} · Fogo ${p.fogo} · ${p.padrao} · ${p.vida}`);
        body(doc, `    Sulcos Ext/Cent/Int/Aux: ${mm(p.sulcos.ext)} / ${mm(p.sulcos.cent)} / ${mm(p.sulcos.int)} / ${mm(p.sulcos.aux)} → menor ${mm(p.menor_sulco)} (${p.status_label})`);
        body(doc, `    Diagnóstico: ${p.diagnostico} · Ação: ${p.acao}`);
        if (p.motivo) body(doc, `    Motivo: ${p.motivo}`);
        const extras = [
          p.data_medicao ? `medido ${formatBr(p.data_medicao)}` : null,
          p.custo != null ? formatMoney(p.custo) : null,
          p.nota_fiscal ? `NF ${p.nota_fiscal}` : null,
        ].filter(Boolean);
        if (extras.length) body(doc, `    ${extras.join(' · ')}`);
      }
    }
    doc.moveDown(0.3);

    // Estoque
    h1(doc, '4. Estoque');
    if (!dados.estoque.length) body(doc, 'Nenhum pneu em estoque.');
    else {
      dados.estoque.forEach((p) => {
        body(doc, `• Fogo ${p.fogo} · ${[p.marca, p.modelo, p.medida].filter(Boolean).join(' ')} · ${p.padrao} · ${p.vida} · ${formatMoney(p.custo)}${p.nota_fiscal ? ` · NF ${p.nota_fiscal}` : ''}`);
      });
    }
    doc.moveDown(0.3);

    // Descarte
    h1(doc, '5. Descarte');
    if (!dados.descarte.length) body(doc, 'Nenhum pneu no estoque de descarte.');
    else {
      dados.descarte.forEach((p) => {
        body(doc, `• Fogo ${p.fogo} · ${[p.marca, p.modelo].filter(Boolean).join(' ')} · ${p.padrao} · ${p.vida} · ${p.tratamento}${p.tratamento_em ? ` em ${formatBr(p.tratamento_em)}` : ''}${p.obs ? ` — ${p.obs}` : ''}`);
      });
    }

    doc.moveDown(1);
    body(doc, 'Documento gerado pelo PneuSistemma para apoio à decisão do gerente da unidade.');
    doc.end();
  });
}

export async function gerarRelatorioSemanalPdfBuffer(filialId, opts = {}) {
  const dados = await montarDadosRelatorioSemanal(filialId, opts);
  const buffer = await gerarPdfRelatorioSemanal(dados);
  const nome = `relatorio-semanal-${dados.filial.codigo || filialId}-${dados.periodo.inicio}.pdf`
    .replace(/[^\w.\-]+/g, '_');
  return { buffer, filename: nome, dados };
}
