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

export async function travarPneu(db, pneuId) {
  return db.prepare(`SELECT * FROM pneus WHERE id = ? FOR UPDATE`).get(pneuId);
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
  apelido = null,
  ciclo = undefined,
  usuario = null,
  custo = null,
  sulcoAntes = null,
  sulcoDepois = null,
  motivo = null,
}) {
  const anterior = veiculoId
    ? await ultimaMovimentacaoVeiculo(db, pneuId, veiculoId)
    : null;
  const stintEncerrado = anterior && ['retirada', 'desmontagem'].includes(anterior.tipo);
  const abreStint = tipo === 'montagem' || tipo === 'entrada_estoque';
  const { kmRodado, hrRodado } = (stintEncerrado || abreStint)
    ? { kmRodado: null, hrRodado: null }
    : deltaKmHr(anterior, km, hr);

  let placaFinal = placa || null;
  let apelidoFinal = apelido || null;
  if (veiculoId && (!placaFinal || !apelidoFinal)) {
    const v = await db.prepare('SELECT placa, apelido FROM veiculos WHERE id = ?').get(veiculoId);
    if (!placaFinal) placaFinal = v?.placa || null;
    if (!apelidoFinal) apelidoFinal = v?.apelido || null;
  }

  let cicloFinal = ciclo;
  if (cicloFinal === undefined && pneuId) {
    const p = await db.prepare('SELECT vida_recap FROM pneus WHERE id = ?').get(pneuId);
    cicloFinal = p?.vida_recap ?? null;
  }

  return db.prepare(`
    INSERT INTO movimentacoes (
      pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
      posicao, posicao_anterior, sulco_mm, detalhes, km_rodado, hr_rodado, veiculo_placa,
      veiculo_apelido, ciclo, usuario, custo, sulco_antes, sulco_depois, motivo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    placaFinal,
    apelidoFinal,
    cicloFinal ?? null,
    usuario || null,
    custo != null && Number.isFinite(Number(custo)) ? Number(custo) : null,
    sulcoAntes != null && Number.isFinite(Number(sulcoAntes)) ? Number(sulcoAntes) : null,
    sulcoDepois != null && Number.isFinite(Number(sulcoDepois)) ? Number(sulcoDepois) : null,
    motivo || null
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
