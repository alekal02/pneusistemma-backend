/**
 * PDF executivo de saúde e desgaste. Não altera dados.
 */
import PDFDocument from 'pdfkit';

function dataBr(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return '—';
  return `${d}/${m}/${y}`;
}

function dataHoraBr(iso) {
  const dt = iso ? new Date(iso) : new Date();
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function n(v) {
  return v == null || Number.isNaN(Number(v)) ? '—' : String(v);
}

function ensure(doc, altura = 40) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - altura) doc.addPage();
}

function titulo(doc, texto) {
  ensure(doc, 36);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#145223').text(texto);
  doc.fillColor('#111');
  doc.moveDown(0.3);
}

function linha(doc, texto, { bold = false, size = 9 } = {}) {
  ensure(doc, 16);
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor('#111').text(texto);
}

export function gerarPdfSaudeBuffer(relatorio) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const c = relatorio.consolidado || {};
    const f = c.faixas || {};
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#145223')
      .text('Sistemma Pneus — Saúde e desgaste');
    doc.font('Helvetica').fontSize(10).fillColor('#333')
      .text('Relatório executivo do perfil presidente');
    doc.text(`Gerado em ${dataHoraBr(relatorio.gerado_em)}. Somente leitura: o histórico gravado não é alterado.`);
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor('#333').text(
      'Régua de recapagem do caminhão, pelo menor sulco entre externo, central e interno: '
      + 'acima de 8 mm acompanhamento normal; acima de 5 até 8 mm monitoramento preventivo; '
      + 'acima de 3 até 5 mm programar recapagem; 3 mm ou menos crítico, com retirada e avaliação urgente. '
      + 'Pneu crítico não é apto automaticamente para recapagem.'
    );

    titulo(doc, 'Consolidado');
    linha(doc, `Unidades: ${n(c.filiais)} · Veículos: ${n(c.veiculos)} · Pneus montados: ${n(c.pneus_montados)}`);
    linha(doc, `Acompanhamento normal: ${n(f.acompanhamento_normal)} · Monitoramento preventivo: ${n(f.monitoramento_preventivo)}`);
    linha(doc, `Programar recapagem: ${n(f.programar_recapagem)} · Crítico: ${n(f.critico)}`);
    linha(doc, `Desgaste uniforme: ${n(c.uniformes)} · Irregular (hipótese, não diagnóstico): ${n(c.irregulares)}`);
    linha(doc, `Candidatos a programar recapagem, ainda sem envio automático: ${n(c.candidatos_recap)}`);
    linha(doc, `Críticos encaminhados só para avaliação urgente: ${n(c.avaliacao_urgente)}`);
    linha(doc, `Consumo acima da média de grupo comparável: ${n(c.acima_da_media)}`);
    linha(doc, `Caminhões sem projeção por falta de histórico confiável: ${n(c.sem_projecao_caminhao)}`);

    titulo(doc, 'Por unidade');
    for (const u of relatorio.por_unidade || []) {
      const fx = u.faixas || {};
      linha(
        doc,
        `${u.filial}: ${u.veiculos} veículo(s), ${u.pneus_montados} pneu(s) · `
        + `normal ${fx.acompanhamento_normal || 0} · preventivo ${fx.monitoramento_preventivo || 0} · `
        + `programar ${fx.programar_recapagem || 0} · crítico ${fx.critico || 0} · `
        + `irregular ${u.irregulares || 0} · acima da média ${u.acima_da_media || 0}`,
      );
    }

    titulo(doc, 'Veículos em situação mais exigente');
    const veiculos = (relatorio.por_veiculo || []).slice(0, 25);
    if (!veiculos.length) linha(doc, 'Nenhum veículo com pneu montado no recorte.');
    for (const v of veiculos) {
      linha(
        doc,
        `${v.filial || '—'} · ${v.placa || 'sem placa'}${v.apelido ? ` (${v.apelido})` : ''} · `
        + `${v.pior_faixa_label || '—'} · menor sulco ${n(v.menor_sulco)} mm · `
        + `${v.pneus} pneu(s) · irregulares ${v.irregulares}`,
      );
    }

    titulo(doc, 'Críticos — não aptos para recapagem automática');
    const criticos = (relatorio.pneus || []).filter((p) => p.status_pneu === 'montado' && (p.faixa === 'critico' || p.faixa === 'critico_equipamento'));
    if (!criticos.length) linha(doc, 'Nenhum pneu montado na faixa crítica.');
    for (const p of criticos.slice(0, 40)) {
      linha(
        doc,
        `${p.filial || '—'} · ${p.placa || 'estoque'} · fogo ${p.numero_fogo || p.id} · `
        + `${p.posicao || '—'} · ${n(p.menor_sulco)} mm · ${p.elegibilidade?.motivo || ''}`,
      );
    }
    if (criticos.length > 40) linha(doc, `Mais ${criticos.length - 40} pneu(s) críticos na consulta completa.`);

    titulo(doc, 'Recapagem, estoque e previsão por filial');
    const alertaCompra = relatorio.compras_alerta;
    if (alertaCompra && alertaCompra.definitivo === false) {
      linha(doc, alertaCompra.texto, { bold: true, size: 9 });
    }
    const excluidas = relatorio.unidades_excluidas || [];
    if (excluidas.length) {
      linha(
        doc,
        `Fora deste consolidado, com cadastro preservado: ${excluidas.map((u) => u.codigo).join(', ')}.`,
        { size: 8.5 },
      );
    }
    const compras = relatorio.compras_por_filial || [];
    if (!compras.length) linha(doc, 'Sem movimento de estoque ou demanda no recorte.');
    for (const item of compras) {
      const compra = item.recomendacao_definitiva === false
        ? `${item.comprar_novo} (não definitivo)`
        : String(item.comprar_novo);
      linha(
        doc,
        `${item.filial || item.filial_id}: estoque novo ${item.estoque_novo} · estoque recapado ${item.estoque_recapado} · `
        + `em recapagem ${item.em_recapagem} · comprar novo ${compra} · `
        + `candidatos a recap ${item.candidatos_recap} · avaliação urgente ${item.avaliacao_urgente} · `
        + `projeção 90 dias novo ${item.previsao_novo_90d} / recap ${item.previsao_recap_90d}`,
        { size: 8.5 },
      );
    }
    linha(doc, 'Compra de pneu novo cobre dianteira e equipamento sem recapagem. Crítico de tração não entra como recap aprovada. Medidas com vírgula ou ponto entram na mesma conta.', { size: 8.5 });

    titulo(doc, 'Consumo acima da média');
    const acima = (relatorio.pneus || []).filter((p) => p.comparacao?.acima);
    if (!acima.length) linha(doc, 'Nenhum pneu acima da média de um grupo comparável com amostra suficiente.');
    for (const p of acima.slice(0, 30)) {
      const taxa = p.consumo?.unidade === 'horas' ? p.consumo.mm_por_100_h : p.consumo?.mm_por_1000_km;
      const und = p.consumo?.unidade === 'horas' ? 'mm/100 h' : 'mm/1.000 km';
      linha(
        doc,
        `${p.filial || '—'} · ${p.placa || '—'} · fogo ${p.numero_fogo || p.id} · `
        + `${n(taxa)} ${und} · média do grupo ${n(p.comparacao.media)} (${p.comparacao.amostras} pneus)`,
      );
    }

    titulo(doc, 'Limitações dos dados');
    for (const texto of relatorio.limitacoes || []) linha(doc, `• ${texto}`, { size: 8 });

    doc.end();
  });
}

export function nomeArquivoSaude(geradoEm) {
  const dia = dataBr(geradoEm || new Date().toISOString()).replace(/\//g, '-');
  return `saude-desgaste-pneus-${dia}.pdf`;
}
