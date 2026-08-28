/**
 * Gravação de movimentações do pneu (montar / retirar / recap).
 */

async function ultimaMovimentacaoVeiculo(db, pneuId, veiculoId) {
  const row = await db.prepare(`
    SELECT * FROM movimentacoes
    WHERE pneu_id = ? AND veiculo_id = ?
      AND tipo IN ('montagem', 'retirada', 'mudanca_posicao', 'desmontagem')
    ORDER BY data_evento DESC, id DESC
    LIMIT 1
  `).get(pneuId, veiculoId);
  return row || null;
}

function deltaKmHr(anterior, kmAtual, hrAtual) {
  let kmRodado = null;
  let hrRodado = null;
  if (anterior?.km_veiculo != null && kmAtual != null) {
    const d = Number(kmAtual) - Number(anterior.km_veiculo);
    if (d >= 0) kmRodado = d;
  }
  if (anterior?.hr_veiculo != null && hrAtual != null) {
    const d = Number(hrAtual) - Number(anterior.hr_veiculo);
    if (d >= 0) hrRodado = Math.round(d * 10) / 10;
  }
  return { kmRodado, hrRodado };
}

export async function registrarMovimentacao(db, {
  pneuId,
  veiculoId,
  tipo,
  data,
  km,
  hr,
  posicao,
  posicaoAnterior = null,
  detalhes = null,
  sulcoMm = null,
  placa = null,
}) {
  const anterior = veiculoId
    ? await ultimaMovimentacaoVeiculo(db, pneuId, veiculoId)
    : null;
  const { kmRodado, hrRodado } = deltaKmHr(anterior, km, hr);
  let placaFinal = placa || null;
  if (!placaFinal && veiculoId) {
    const v = await db.prepare('SELECT placa FROM veiculos WHERE id = ?').get(veiculoId);
    placaFinal = v?.placa || null;
  }

  return db.prepare(`
    INSERT INTO movimentacoes (
      pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
      posicao, posicao_anterior, sulco_mm, detalhes, km_rodado, hr_rodado, veiculo_placa
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pneuId,
    veiculoId,
    tipo,
    data,
    km,
    hr,
    posicao,
    posicaoAnterior,
    sulcoMm,
    detalhes,
    kmRodado,
    hrRodado,
    placaFinal
  );
}

export async function atualizarKmHrVeiculo(db, veiculoId, filialId, km, hr) {
  if (km != null) {
    await db.prepare(`
      UPDATE veiculos SET km_atual = MAX(COALESCE(km_atual, 0), ?), updated_at = NOW()
      WHERE id = ? AND filial_id = ?
    `).run(km, veiculoId, filialId);
  }
  if (hr != null) {
    await db.prepare(`
      UPDATE veiculos SET hr_atual = MAX(COALESCE(hr_atual, 0), ?), updated_at = NOW()
      WHERE id = ? AND filial_id = ?
    `).run(hr, veiculoId, filialId);
  }
}
