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

export function textoConsolidadoFrota(consolidado) {
  const c = consolidado || {};
  if (c.veiculos_cadastrados == null) {
    return `Unidades: ${n(c.filiais)} · Veículos com pneu montado: ${n(c.veiculos)} · Pneus montados: ${n(c.pneus_montados)}`;
  }
  return `Unidades: ${n(c.filiais)} · Veículos cadastrados: ${n(c.veiculos_cadastrados)} · Com pneu montado: ${n(c.veiculos)} · Pneus montados: ${n(c.pneus_montados)}`;
}

export function textoVeiculosUnidade(unidade) {
  if (unidade?.veiculos_cadastrados == null) return `${unidade?.veiculos} com pneu montado`;
  return `${unidade.veiculos_cadastrados} cadastrado(s), ${unidade.veiculos} com pneu montado`;
}

/** Quantidade só quando a medida está especificada e o estoque dessa medida foi conferido. */
export function textoCompraNova(item) {
  if (item?.recomendacao_definitiva === false || Number(item?.montados_sem_medida) > 0) return 'não definitiva';
  return String(item?.comprar_novo);
}

export function textoLeituraSulco(unidade) {
  const leitura = unidade?.leitura_sulco || {};
  const parcial = (Number(leitura.parcial) || 0) + (Number(leitura.invalida) || 0);
  return `sem histórico ${Number(leitura.sem_historico) || 0}`
    + ` · neste mês ${Number(leitura.no_ciclo) || 0}`
    + ` · mês anterior no prazo ${Number(leitura.ciclo_anterior) || 0}`
    + ` · medição mensal vencida ${Number(leitura.vencida) || 0}`
    + ` · parcial ou inválida ${parcial}`
    + ` · primeira medição ainda não exigível ${Number(leitura.nao_exigivel) || 0}`;
}

export function textoParecer(parecer) {
  if (!parecer) return 'Parecer indisponível neste recorte.';
  const recomendacao = (parecer.recomendacoes || []).join(' · ') || 'Sem recomendação fechada';
  const quantidade = parecer.quantidade_compra == null
    ? 'quantidade de compra não fechada'
    : `quantidade conferida ${parecer.quantidade_compra}`;
  return [
    recomendacao,
    parecer.frota,
    parecer.atencao_texto,
    parecer.substituicao,
    `${parecer.compra} ${quantidade}.`,
    parecer.recapagem,
    parecer.prioridade_texto,
  ].filter(Boolean).join(' ');
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
      'Régua de recapagem do caminhão, pelo menor sulco entre as leituras individuais, incluindo a quarta quando existe: '
      + 'acima de 8 mm acompanhamento normal; acima de 5 até 8 mm monitoramento preventivo; '
      + 'acima de 3 até 5 mm programar recapagem; 3 mm ou menos crítico, com retirada e avaliação urgente. '
      + 'Pneu crítico não é apto automaticamente para recapagem. '
      + 'A medição dos sulcos é mensal. Este relatório só recomenda: não abre compra nem aprova recapagem.'
    );

    titulo(doc, 'Consolidado');
    linha(doc, textoConsolidadoFrota(c));
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
      const frota = textoVeiculosUnidade(u);
      linha(
        doc,
        `${u.filial}: ${frota}, ${u.pneus_montados} pneu(s) · `
        + `bom estado ${fx.acompanhamento_normal || 0} · atenção ${fx.monitoramento_preventivo || 0} · `
        + `recapagem a avaliar ${fx.programar_recapagem || 0} · crítico ${fx.critico || 0} · `
        + textoLeituraSulco(u),
      );
    }

    titulo(doc, 'Parecer por filial');
    const unidadesParecer = relatorio.por_unidade || [];
    if (!unidadesParecer.length) linha(doc, 'Nenhuma filial neste recorte.');
    for (const u of unidadesParecer) {
      linha(doc, `${u.filial}: ${textoParecer(u.parecer)}`, { size: 8.5 });
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
      const compra = textoCompraNova(item);
      linha(
        doc,
        `${item.filial || item.filial_id}: necessidade técnica ${item.necessidade_pneu_novo || 0} · `
        + `estoque novo ${item.estoque_novo} · estoque recapado ${item.estoque_recapado} · `
        + `em recapagem ${item.em_recapagem} · comprar novo ${compra} · `
        + `candidatos a recap ${item.candidatos_recap} · avaliação urgente ${item.avaliacao_urgente}`,
        { size: 8.5 },
      );
    }
    linha(doc, 'Compra de pneu novo cobre dianteira e equipamento sem recapagem. Crítico de tração não entra como recap aprovada. Candidato à recapagem depende da inspeção da carcaça. Medidas com vírgula ou ponto entram na mesma conta. Não há prazo de substituição neste parecer.', { size: 8.5 });

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
