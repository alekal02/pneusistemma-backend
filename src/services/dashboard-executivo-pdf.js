/**
 * PDF da visão executiva. Somente leitura. Sem valores financeiros.
 */
import PDFDocument from 'pdfkit';
import { HISTORICO_INDISPONIVEL } from './dashboard-executivo.js';

const CORES = {
  ok: '#15803d',
  atencao: '#a16207',
  critico: '#b91c1c',
  cinza: '#64748b',
  neutro: '#1b5e2a',
  verde: '#15803d',
  amarelo: '#a16207',
  vermelho: '#b91c1c',
};

function dataHoraBr(iso) {
  const dt = iso ? new Date(iso) : new Date();
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function ensure(doc, altura = 36) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - altura) doc.addPage();
}

function barraDistribuicao(doc, filial) {
  const largura = 220;
  const y = doc.y;
  const partes = [
    [Number(filial.pneus_sem_alerta) || 0, '#15803d'],
    [Number(filial.pneus_atencao) || 0, '#a16207'],
    [Number(filial.pneus_criticos) || 0, '#b91c1c'],
    [Number(filial.pneus_sem_dados) || 0, '#94a3b8'],
  ];
  const total = partes.reduce((soma, item) => soma + item[0], 0);
  doc.save();
  doc.roundedRect(doc.x, y, largura, 8, 2).fill('#e5ece6');
  if (total > 0) {
    let x = doc.x;
    for (const [valor, cor] of partes) {
      if (!valor) continue;
      const w = (valor / total) * largura;
      doc.rect(x, y, w, 8).fill(cor);
      x += w;
    }
  }
  doc.restore();
  doc.y = y + 12;
}

function textoPct(valor) {
  if (valor == null || valor === '') return '—';
  return `${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function nomeArquivoExecutivo(iso) {
  const dia = dataHoraBr(iso).slice(0, 10).split('/').reverse().join('-');
  return `visao-executiva-${dia || 'presidente'}.pdf`;
}

export function gerarPdfExecutivoBuffer({ snapshot, evolucao, diagnostico = null }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#145223').text('Sistemma Pneus');
    doc.font('Helvetica').fontSize(10).fillColor('#3d5244')
      .text(`Visão executiva · ${dataHoraBr(snapshot?.gerado_em)}`);
    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Resumo');
    doc.moveDown(0.3);
    for (const card of snapshot?.resumo?.cards || []) {
      ensure(doc, 28);
      doc.font('Helvetica').fontSize(9).fillColor('#3d5244').text(card.rotulo, { continued: false });
      doc.font('Helvetica-Bold').fontSize(14).fillColor(CORES[card.cor] || '#14261a').text(String(card.valor ?? '—'));
      if (card.comparacao) {
        const delta = card.comparacao.delta;
        const sinal = delta > 0 ? '+' : '';
        doc.font('Helvetica').fontSize(8).fillColor('#5a6e60').text(`Variação no conjunto com histórico: ${sinal}${delta}`);
      }
      doc.moveDown(0.2);
    }

    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Filiais');
    doc.moveDown(0.25);
    const porDiagnostico = new Map((diagnostico?.filiais || []).map((f) => [Number(f.id), f]));
    const filiais = (diagnostico?.filiais?.length ? diagnostico.filiais : (snapshot?.filiais || []));
    if (!filiais.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#5a6e60').text('Sem filiais neste recorte.');
    }
    for (const bruto of filiais) {
      ensure(doc, 48);
      const diag = porDiagnostico.get(Number(bruto.id)) || bruto;
      const nome = diag.nome || bruto.nome || '—';
      if (diag.sem_frota || (diag.veiculos_ativos === 0 && diag.pneus_montados == null && !diag.montados)) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#14261a').text(`${nome}  ·  Sem frota cadastrada`);
        doc.font('Helvetica').fontSize(8).fillColor('#5a6e60').text('Dados insuficientes. Sem frota cadastrada. Sem percentual de pneus.');
        doc.moveDown(0.3);
        continue;
      }
      const rotulo = diag.situacao_label || diag.situacao_executiva_label || bruto.situacao?.label || '—';
      const criticos = diag.pneus_criticos ?? bruto.criticos ?? 0;
      const montados = diag.pneus_montados ?? bruto.montados ?? 0;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#14261a')
        .text(`${nome}  ·  ${rotulo}  ·  ${criticos} substituição prioritária (${textoPct(diag.pct_critico)})`);
      doc.font('Helvetica').fontSize(8).fillColor('#5a6e60')
        .text(`Boa condição ${diag.pneus_sem_alerta ?? '—'} (${textoPct(diag.pct_sem_alerta)}) · Acompanhamento ${diag.pneus_atencao ?? '—'} (${textoPct(diag.pct_atencao)}) · Sem medição ${diag.pneus_sem_dados ?? '—'} (${textoPct(diag.pct_sem_dados)}) · Montados ${montados}`);
      if (diag.riscos_imediatos > 0) {
        doc.fillColor('#b91c1c').text(`Intervenção imediata: ${diag.riscos_imediatos} pneu(s) em posição direcional.`);
      }
      barraDistribuicao(doc, diag.pneus_montados != null ? diag : {
        pneus_sem_alerta: bruto.pneus_ok,
        pneus_atencao: bruto.monitorar,
        pneus_criticos: bruto.criticos,
        pneus_sem_dados: bruto.sem_medicao,
      });
    }

    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Condição física');
    doc.moveDown(0.2);
    desenharFatia(doc, snapshot?.saude?.condicao || []);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Onde estão');
    doc.moveDown(0.2);
    desenharFatia(doc, snapshot?.saude?.localizacao || []);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Validade no mês');
    doc.moveDown(0.2);
    desenharFatia(doc, snapshot?.saude?.atualizacao || []);

    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Evolução');
    doc.moveDown(0.2);
    const series = evolucao?.series || {};
    const nomes = [
      ['medicoes', 'Medições'],
      ['criticos', 'Substituição prioritária'],
      ['filiais', 'Filiais com medição'],
      ['recapagens', 'Recapagens'],
      ['descartes', 'Descartes'],
      ['conformidade', 'Conformidade'],
    ];
    for (const [id, nome] of nomes) {
      ensure(doc, 20);
      const serie = series[id];
      const cor = serie?.disponivel ? '#14261a' : '#5a6e60';
      doc.font('Helvetica').fontSize(9).fillColor(cor).text(textoSerie(nome, id, serie));
    }

    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#145223').text('Prioridades');
    doc.moveDown(0.2);
    const grupos = (snapshot?.alertas?.grupos || []).filter((g) => g.total > 0);
    if (!grupos.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#5a6e60').text('Nenhuma pendência neste recorte.');
    }
    for (const g of grupos) {
      ensure(doc, 18);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#14261a').text(`${g.titulo} · ${g.total}`);
      for (const item of (g.itens || []).slice(0, 3)) {
        ensure(doc, 14);
        doc.font('Helvetica').fontSize(8).fillColor('#3d5244')
          .text(`${item.filial || '—'} · ${item.titulo}`);
      }
    }

    doc.end();
  });
}

function textoSerie(nome, id, serie) {
  if (!serie?.disponivel) return `${nome}: ${serie?.motivo || HISTORICO_INDISPONIVEL}`;
  const pontos = (serie.pontos || []).filter((p) => p.valor != null);
  if (id === 'criticos') {
    const ultimo = [...pontos].reverse().find((p) => p.valor != null);
    return `${nome}: ${ultimo?.valor ?? '—'} no fim do período`;
  }
  if (id === 'filiais') {
    const intervalos = pontos.filter((p) => Number(p.valor) > 0).length;
    return `${nome}: ${intervalos} intervalos com medição`;
  }
  const soma = pontos.reduce((s, p) => s + (Number(p.valor) || 0), 0);
  return `${nome}: ${soma} no período`;
}

function desenharFatia(doc, itens) {
  const max = Math.max(1, ...itens.map((i) => Number(i.valor) || 0));
  if (!itens.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#5a6e60').text('Sem dados.');
    return;
  }
  for (const item of itens) {
    ensure(doc, 22);
    doc.font('Helvetica').fontSize(9).fillColor('#14261a').text(`${item.label}  ${item.valor}`);
    barra(doc, item.valor, max, CORES[item.cor] || CORES.neutro);
  }
}
