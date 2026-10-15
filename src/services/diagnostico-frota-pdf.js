/**
 * PDF do diagnóstico da frota. Só veículos com pendência que tira a conformidade.
 */
import PDFDocument from 'pdfkit';
import { labelDiaMedicao } from '../dia-medicao.js';

const NAVY = '#0B3A5B';
const INK = '#1C2833';
const MUTED = '#5D6D7E';
const LINE = '#D5DDE5';
const RED = '#9B2C2C';
const AMBER = '#9A6700';
const BLUE = '#1D4E89';

function fmtData(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return '—';
  return `${d}/${m}/${y}`;
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function labelSeveridade(s) {
  if (s === 'critica') return 'Crítica';
  if (s === 'atencao') return 'Atenção';
  if (s === 'cadastral') return 'Cadastral';
  return s || '—';
}

function corSeveridade(s) {
  if (s === 'critica') return RED;
  if (s === 'atencao') return AMBER;
  if (s === 'cadastral') return BLUE;
  return INK;
}

function textoFiltros(filtros, filiais) {
  const partes = [];
  if (filtros?.filial_id) {
    const f = (filiais || []).find((x) => Number(x.id) === Number(filtros.filial_id));
    partes.push(f ? `Filial ${f.nome} (${f.codigo})` : `Filial ${filtros.filial_id}`);
  } else partes.push('Todas as filiais do acesso');
  if (filtros?.placa) partes.push(`Placa contém ${filtros.placa}`);
  if (filtros?.tipo) partes.push(`Tipo ${filtros.tipo}`);
  if (filtros?.pendencia) partes.push(`Pendência ${labelSeveridade(filtros.pendencia)}`);
  if (filtros?.periodo_inicio || filtros?.periodo_fim) {
    partes.push(`Medições exibidas de ${fmtData(filtros.periodo_inicio)} a ${fmtData(filtros.periodo_fim)}`);
  }
  return partes.join(' · ');
}

export function gerarPdfDiagnosticoFrota(relatorio) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      bufferPages: true,
      margins: { top: 36, bottom: 36, left: 32, right: 32 },
      info: {
        Title: 'Diagnóstico da frota',
        Author: 'Pneusistemma',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 64;
    const fundo = () => doc.page.height - 32;
    const resumo = relatorio.resumo || {};
    const filtrosTxt = textoFiltros(relatorio.filtros, relatorio.filiais);
    const quando = fmtData(String(relatorio.gerado_em || '').slice(0, 10))
      || new Date().toLocaleDateString('pt-BR');

    const cabecalho = (titulo) => {
      doc.rect(0, 0, doc.page.width, 26).fill(NAVY);
      doc.font('Helvetica').fontSize(8).fillColor('#FFFFFF')
        .text('Diagnóstico da frota', 32, 9, { width: W * 0.6, lineBreak: false });
      doc.text(quando, 32, 9, { width: W, align: 'right', lineBreak: false });
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(titulo, 32, 36, { width: W });
      doc.y = 56;
    };

    const ensure = (h) => {
      if (doc.y + h <= fundo()) return;
      doc.addPage();
      cabecalho('Continuação');
    };

    const paragrafo = (texto) => {
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(texto, 32, doc.y, { width: W });
      doc.moveDown(0.3);
    };

    doc.rect(0, 0, doc.page.width, doc.page.height).fill(NAVY);
    doc.rect(0, 0, 8, doc.page.height).fill('#C45C26');
    doc.fillColor('#F4C7A8').font('Helvetica').fontSize(10).text('PNEUSISTEMMA', 40, 70);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(26).text('Diagnóstico da frota', 40, 98, { width: 640 });
    doc.fillColor('#D6E4F0').font('Helvetica').fontSize(11)
      .text('Pendências de cadastro, montagem e medição para cobrança operacional', 40, 142, { width: 620 });
    doc.fillColor('#FFFFFF').font('Helvetica').fontSize(11);
    const capa = [
      ['Gerado em', quando],
      ['Semana de medição', `${fmtData(relatorio.semana?.inicio)} a ${fmtData(relatorio.semana?.fim)} (${relatorio.semana?.dia_hoje_label || ''})`],
      ['Filtros', filtrosTxt],
      ['Conformidade', fmtPct(resumo.conformidade_pct)],
    ];
    capa.forEach((par, i) => {
      const y = 200 + i * 26;
      doc.font('Helvetica').fontSize(8).fillColor('#9FB6C9').text(par[0].toUpperCase(), 40, y);
      doc.font('Helvetica').fontSize(11).fillColor('#FFFFFF').text(par[1], 190, y - 2, { width: 520 });
    });

    doc.addPage();
    cabecalho('Resumo geral');
    paragrafo('A conformidade é a parcela dos veículos ativos com cadastro completo que não têm pendência crítica, de atenção ou cadastral. Cadastros incompletos ficam fora dessa conta. Estepe vazio, aviso de montagem e layout personalizado sem posições conhecidas aparecem na tela e não reprovam o veículo.');
    paragrafo(`Semana de referência do atraso: ${fmtData(relatorio.semana?.inicio)} a ${fmtData(relatorio.semana?.fim)}. O período dos filtros não altera essa regra. Medição prevista para hoje não é atraso. Filtros: ${filtrosTxt}.`);

    const cards = [
      ['Analisados', String(resumo.veiculos_analisados ?? 0)],
      ['Conformes', String(resumo.veiculos_conformes ?? 0)],
      ['Com pendência', String(resumo.veiculos_com_pendencia ?? 0)],
      ['Conformidade', fmtPct(resumo.conformidade_pct)],
      ['Sem fogo', String(resumo.pneus_sem_fogo ?? 0)],
      ['Sem medição', String(resumo.pneus_sem_medicao ?? 0)],
      ['Atrasadas', String(resumo.medicoes_atrasadas ?? 0)],
      ['Posição vazia', String(resumo.posicoes_sem_pneu ?? 0)],
    ];
    const cardW = W / cards.length;
    const y0 = doc.y;
    cards.forEach((c, i) => {
      const x = 32 + i * cardW;
      doc.roundedRect(x + 2, y0, cardW - 5, 46, 3).fill('#F4F7FA');
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(c[0].toUpperCase(), x + 6, y0 + 7, { width: cardW - 12 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(c[1], x + 6, y0 + 22, { width: cardW - 12 });
    });
    doc.y = y0 + 58;
    paragrafo(`Cadastros incompletos, fora da conformidade: ${resumo.cadastros_incompletos_veiculos ?? 0} veículo(s) e ${resumo.cadastros_incompletos_pneus ?? 0} pneu(s) montado(s).`);

    const porFilial = relatorio.por_filial || [];
    if (porFilial.length) {
      ensure(40);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Indicadores por filial', 32, doc.y);
      doc.moveDown(0.4);
      const cols = [
        { t: 'Filial', w: 150 },
        { t: 'Código', w: 60 },
        { t: 'Analisados', w: 70, a: 'right' },
        { t: 'Conformes', w: 70, a: 'right' },
        { t: 'Pendências', w: 70, a: 'right' },
        { t: 'Sem fogo', w: 60, a: 'right' },
        { t: 'Sem medição', w: 75, a: 'right' },
        { t: 'Atrasadas', w: 65, a: 'right' },
        { t: 'Pos. vazia', w: 65, a: 'right' },
        { t: 'Conformidade', w: W - 685, a: 'right' },
      ];
      const header = () => {
        ensure(32);
        const y = doc.y;
        doc.rect(32, y, W, 16).fill(NAVY);
        let x = 32;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF');
        for (const c of cols) {
          doc.text(c.t, x + 3, y + 4, { width: c.w - 6, align: c.a || 'left', lineBreak: false });
          x += c.w;
        }
        doc.y = y + 16;
      };
      header();
      porFilial.forEach((f, i) => {
        if (doc.y + 15 > fundo()) header();
        const y = doc.y;
        if (i % 2 === 0) doc.rect(32, y, W, 15).fill('#F4F7FA');
        const vals = [
          f.filial, f.codigo, f.veiculos_analisados, f.veiculos_conformes, f.veiculos_com_pendencia,
          f.pneus_sem_fogo, f.pneus_sem_medicao, f.medicoes_atrasadas, f.posicoes_sem_pneu, fmtPct(f.conformidade_pct),
        ];
        let x = 32;
        doc.font('Helvetica').fontSize(7.5).fillColor(INK);
        vals.forEach((valor, idx) => {
          doc.text(String(valor ?? ''), x + 3, y + 3, { width: cols[idx].w - 6, align: cols[idx].a || 'left', lineBreak: false });
          x += cols[idx].w;
        });
        doc.y = y + 15;
      });
      doc.moveDown(0.6);
    }

    const grupos = new Map();
    for (const v of relatorio.veiculos || []) {
      const itens = (v.pendencias || []).filter((p) => p.reprova);
      if (!itens.length) continue;
      const key = String(v.filial_id);
      if (!grupos.has(key)) grupos.set(key, { nome: v.filial, codigo: v.codigo, veiculos: [] });
      grupos.get(key).veiculos.push({ ...v, itens });
    }

    doc.addPage();
    cabecalho('Veículos com pendências');
    if (!grupos.size) {
      paragrafo('Nenhum veículo analisado tem pendência que tire a conformidade com os filtros atuais.');
    }

    const colsP = [
      { t: 'Posição', w: 145 },
      { t: 'Fogo', w: 90 },
      { t: 'Última medição', w: 80 },
      { t: 'Classe', w: 60 },
      { t: 'O que falta', w: W - 375 },
    ];

    for (const grupo of grupos.values()) {
      ensure(36);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
        .text(`${grupo.nome} (${grupo.codigo})`, 32, doc.y, { width: W });
      doc.moveDown(0.25);
      for (const v of grupo.veiculos) {
        ensure(32);
        const dia = v.dia_medicao_label || labelDiaMedicao(v.dia_medicao) || 'sem dia';
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
          .text(`${v.placa}  ·  ${v.tipo || 'sem tipo'}  ·  dia ${dia}  ·  última ${fmtData(v.ultima_medicao)}`, 32, doc.y, { width: W });
        doc.moveDown(0.15);
        const drawHead = () => {
          ensure(28);
          const y = doc.y;
          doc.rect(32, y, W, 14).fill('#E6EEF5');
          let x = 32;
          doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
          for (const c of colsP) {
            doc.text(c.t, x + 3, y + 3, { width: c.w - 6, lineBreak: false });
            x += c.w;
          }
          doc.y = y + 14;
        };
        drawHead();
        for (const item of v.itens) {
          const falta = `${item.descricao} ${item.orientacao}`;
          const h = Math.max(14, doc.heightOfString(falta, { width: colsP[4].w - 6 }) + 4);
          if (doc.y + h > fundo()) drawHead();
          const y = doc.y;
          doc.font('Helvetica').fontSize(7.5).fillColor(INK);
          const vals = [
            item.posicao_label || item.posicao || '—',
            item.numero_fogo || '—',
            fmtData(item.data_medicao),
            labelSeveridade(item.severidade),
            falta,
          ];
          let x = 32;
          vals.forEach((valor, idx) => {
            doc.fillColor(idx === 3 ? corSeveridade(item.severidade) : INK)
              .text(String(valor), x + 3, y + 2, { width: colsP[idx].w - 6, height: h });
            x += colsP[idx].w;
          });
          doc.y = y + h;
          doc.moveTo(32, doc.y).lineTo(32 + W, doc.y).strokeColor(LINE).stroke();
        }
        doc.moveDown(0.35);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      if (i === 0) continue;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`${i + 1} / ${range.count}`, 32, doc.page.height - 22, { width: W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
