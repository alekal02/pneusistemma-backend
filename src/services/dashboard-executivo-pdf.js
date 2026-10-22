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

function barra(doc, valor, max, cor) {
  const largura = 220;
  const y = doc.y;
  doc.save();
  doc.roundedRect(doc.x, y, largura, 8, 2).fill('#e5ece6');
  const pct = max > 0 && valor != null ? Math.max(0, Math.min(1, valor / max)) : 0;
  if (pct > 0) doc.roundedRect(doc.x, y, Math.max(2, largura * pct), 8, 2).fill(cor);
  doc.restore();
  doc.y = y + 12;
}

export function nomeArquivoExecutivo(iso) {
  const dia = dataHoraBr(iso).slice(0, 10).split('/').reverse().join('-');
  return `visao-executiva-${dia || 'presidente'}.pdf`;
}

export function gerarPdfExecutivoBuffer({ snapshot, evolucao }) {
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
    const filiais = snapshot?.filiais || [];
    const maxMont = Math.max(1, ...filiais.map((f) => f.montados || 0));
    if (!filiais.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#5a6e60').text('Sem filiais neste recorte.');
    }
    for (const f of filiais) {
      ensure(doc, 32);
      const pct = f.percentual_atualizado == null ? '—' : `${f.percentual_atualizado}% no mês`;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#14261a')
        .text(`${f.nome}  ·  ${f.situacao?.label || '—'}  ·  ${pct}`, { continued: false });
      doc.font('Helvetica').fontSize(8).fillColor('#5a6e60')
        .text(`Críticos ${f.criticos} · Fora do mês ${f.atrasados} · Montados ${f.montados}`);
      barra(doc, f.montados, maxMont, CORES[f.situacao?.cor] || CORES.cinza);
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
      ['criticos', 'Pneus críticos'],
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
