/**
 * Integridade do histórico: exclusão, imutabilidade, recapagem, idempotência e índices.
 */
import { initDatabase, getDb, closePool } from '../src/database.js';
import { enviarPneuParaRecap, receberRecapPneu } from '../src/services/pneu-recap.js';
import { excluirVeiculoCompleto } from '../src/services/limpar-filial.js';
import { calcularCiclos } from '../src/services/pneu-ciclo.js';

const erros = [];
function assert(cond, msg) {
  if (!cond) erros.push(msg);
}

const tag = `IH${Date.now().toString().slice(-8)}`;
let filialId;
let veiculoId;
let pneuId;
let medicaoId;

try {
  await initDatabase();
  const db = getDb();
  const filial = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get();
  filialId = filial.id;
  const placa = `Z${tag.slice(-6)}`;

  const veiculo = await db.prepare(`
    INSERT INTO veiculos (placa, apelido, tipo, layout_pneus, km_atual, filial_id)
    VALUES (?, 'Toco Original', 'Truck / Tracao', 'truck_6x2', 10000, ?)
    RETURNING id
  `).get(placa, filialId);
  veiculoId = veiculo.id;

  const pneu = await db.prepare(`
    INSERT INTO pneus (
      filial_id, veiculo_id, posicao, modelo, numero_fogo, status_pneu,
      vida_recap, custo, ativo, condicao
    ) VALUES (?, ?, '1E', 'Integridade', ?, 'montado', 0, 500, 1, 'novo')
    RETURNING id
  `).get(filialId, veiculoId, tag);
  pneuId = pneu.id;

  const med = await db.prepare(`
    INSERT INTO medicoes (
      pneu_id, data_medicao, km_veiculo, sulco_externo, sulco_central, sulco_interno,
      veiculo_id, veiculo_placa, veiculo_apelido, posicao, ciclo
    ) VALUES (?, '2026-01-02', 10000, 14, 14, 14, ?, ?, 'Toco Original', '1E', 0)
    RETURNING id
  `).get(pneuId, veiculoId, placa);
  medicaoId = med.id;

  await db.prepare(`
    INSERT INTO movimentacoes (
      pneu_id, veiculo_id, tipo, data_evento, km_veiculo, posicao,
      veiculo_placa, veiculo_apelido, ciclo, custo, usuario
    ) VALUES (?, ?, 'montagem', '2026-01-02', 10000, '1E', ?, 'Toco Original', 0, 500, 'teste')
  `).run(pneuId, veiculoId, placa);

  await db.prepare(`
    UPDATE veiculos SET placa = ?, apelido = 'MUDOU' WHERE id = ?
  `).run(`Y${tag.slice(-6)}`, veiculoId);
  await db.prepare(`
    UPDATE pneus SET posicao = '2EE', veiculo_id = ?, custo = 999 WHERE id = ?
  `).run(veiculoId, pneuId);

  const medDepois = await db.prepare(`SELECT * FROM medicoes WHERE id = ?`).get(medicaoId);
  const movDepois = await db.prepare(`
    SELECT * FROM movimentacoes WHERE pneu_id = ? AND tipo = 'montagem'
  `).get(pneuId);
  assert(medDepois.veiculo_placa === placa, `placa da medicao mudou: ${medDepois.veiculo_placa}`);
  assert(medDepois.veiculo_apelido === 'Toco Original', `apelido da medicao mudou: ${medDepois.veiculo_apelido}`);
  assert(medDepois.posicao === '1E', `posicao da medicao mudou: ${medDepois.posicao}`);
  assert(Number(medDepois.sulco_externo) === 14, `sulco regravado: ${medDepois.sulco_externo}`);
  assert(Number(medDepois.km_veiculo) === 10000, `km da medicao regravado: ${medDepois.km_veiculo}`);
  assert(movDepois.veiculo_placa === placa, `placa do evento mudou: ${movDepois.veiculo_placa}`);
  assert(movDepois.veiculo_apelido === 'Toco Original', `apelido do evento mudou: ${movDepois.veiculo_apelido}`);
  assert(movDepois.posicao === '1E', `posicao do evento mudou: ${movDepois.posicao}`);
  assert(Number(movDepois.custo) === 500, `custo historico mudou: ${movDepois.custo}`);

  await db.prepare(`
    INSERT INTO medicoes (
      pneu_id, data_medicao, km_veiculo, sulco_externo, sulco_central, sulco_interno,
      veiculo_id, veiculo_placa, veiculo_apelido, posicao, ciclo
    ) VALUES (?, '2026-01-02', 12000, 14, 14, 14, ?, ?, 'Toco Original', '1E', 0)
  `).run(pneuId, veiculoId, placa);
  const nMed = await db.prepare(`SELECT COUNT(*) AS n FROM medicoes WHERE pneu_id = ?`).get(pneuId);
  const primeira = await db.prepare(`SELECT km_veiculo, sulco_externo FROM medicoes WHERE id = ?`).get(medicaoId);
  assert(Number(nMed.n) === 2, `medicao nova nao criou registro: ${nMed.n}`);
  assert(Number(primeira.km_veiculo) === 10000 && Number(primeira.sulco_externo) === 14, 'medicao anterior foi atualizada');

  const atual = await db.prepare(`SELECT * FROM pneus WHERE id = ?`).get(pneuId);
  const corrida = await Promise.allSettled([
    enviarPneuParaRecap(db, { pneu: atual, filialId, fornecedor: 'Bandag' }),
    enviarPneuParaRecap(db, { pneu: { ...atual }, filialId, fornecedor: 'Bandag' }),
  ]);
  const falhaEnvio = corrida.filter((r) => r.status === 'rejected').map((r) => r.reason?.message).join(' | ');
  assert(/j[aá] est[aá] em recapagem/i.test(falhaEnvio), `repeticao nao foi recusada: ${falhaEnvio}`);
  const nEnvio = await db.prepare(`
    SELECT COUNT(*) AS n FROM movimentacoes WHERE pneu_id = ? AND tipo = 'enviar_recap'
  `).get(pneuId);
  assert(Number(nEnvio.n) === 1, `duas recapagens: ${nEnvio.n}`);
  const vida1 = await db.prepare(`SELECT vida_recap, status_pneu, sulco_inicial_mm FROM pneus WHERE id = ?`).get(pneuId);
  assert(vida1.status_pneu === 'recapagem', `status apos envio ${vida1.status_pneu}`);
  assert(Number(vida1.vida_recap) === 0, `envio zerou ou avancou vida: ${vida1.vida_recap}`);

  const emRecap = await db.prepare(`SELECT * FROM pneus WHERE id = ?`).get(pneuId);
  await receberRecapPneu(db, { pneu: emRecap, filialId });
  const apos1 = await db.prepare(`SELECT vida_recap, status_pneu, sulco_inicial_mm FROM pneus WHERE id = ?`).get(pneuId);
  const rec1 = await db.prepare(`
    SELECT sulco_depois, ciclo FROM movimentacoes
    WHERE pneu_id = ? AND tipo = 'recap' AND detalhes ILIKE '%recebid%'
    ORDER BY id DESC LIMIT 1
  `).get(pneuId);
  assert(Number(apos1.vida_recap) === 1, `vida R1 ${apos1.vida_recap}`);
  assert(rec1.sulco_depois == null, `sulco inventado no retorno: ${rec1.sulco_depois}`);
  assert(apos1.sulco_inicial_mm == null, `sulco inicial inventado: ${apos1.sulco_inicial_mm}`);
  let repetiu = false;
  try {
    await receberRecapPneu(db, { pneu: apos1, filialId, sulco_mm: 13 });
  } catch {
    repetiu = true;
  }
  assert(repetiu, 'segundo retorno criou outro ciclo');
  const nRet = await db.prepare(`
    SELECT COUNT(*) AS n FROM movimentacoes
    WHERE pneu_id = ? AND tipo = 'recap' AND detalhes ILIKE '%recebid%'
  `).get(pneuId);
  assert(Number(nRet.n) === 1, `retornos duplicados: ${nRet.n}`);
  const vidaAinda = await db.prepare(`SELECT vida_recap FROM pneus WHERE id = ?`).get(pneuId);
  assert(Number(vidaAinda.vida_recap) === 1, `vida apos repetir retorno: ${vidaAinda.vida_recap}`);

  for (const vidaEsperada of [2, 3]) {
    const row = await db.prepare(`SELECT * FROM pneus WHERE id = ?`).get(pneuId);
    await enviarPneuParaRecap(db, { pneu: row, filialId, fornecedor: 'Bandag', sulco_mm: 8 });
    const meio = await db.prepare(`SELECT * FROM pneus WHERE id = ?`).get(pneuId);
    await receberRecapPneu(db, { pneu: meio, filialId, sulco_mm: 13 });
    const fim = await db.prepare(`SELECT vida_recap FROM pneus WHERE id = ?`).get(pneuId);
    assert(Number(fim.vida_recap) === vidaEsperada, `vida esperada ${vidaEsperada}, veio ${fim.vida_recap}`);
  }

  const ainda = await db.prepare(`SELECT sulco_externo, km_veiculo FROM medicoes WHERE id = ?`).get(medicaoId);
  assert(Number(ainda.sulco_externo) === 14 && Number(ainda.km_veiculo) === 10000, 'recapagem zerou medicao antiga');
  const histMed = await db.prepare(`SELECT * FROM medicoes WHERE pneu_id = ?`).all(pneuId);
  const histMov = await db.prepare(`SELECT * FROM movimentacoes WHERE pneu_id = ? ORDER BY id`).all(pneuId);
  assert(histMov[0].pneu_id === pneuId && histMov.at(-1).pneu_id === pneuId, 'movimentacao trocou de pneu');
  for (let i = 1; i < histMov.length; i += 1) {
    const ant = histMov[i - 1];
    const atu = histMov[i];
    const ordem = String(ant.data_evento) < String(atu.data_evento)
      || (String(ant.data_evento) === String(atu.data_evento) && Number(ant.id) < Number(atu.id));
    assert(ordem && Number(atu.pneu_id) === pneuId, `movimento fora de ordem ou de outro pneu: ${atu.tipo}`);
  }
  const ciclos = calcularCiclos({ movimentacoes: histMov, medicoes: histMed });
  assert(ciclos.some((c) => c.ciclo === 0), 'ciclo original sumiu');
  assert(ciclos.some((c) => c.ciclo_label === 'R1'), `sem R1: ${ciclos.map((c) => c.ciclo_label)}`);
  assert(ciclos.some((c) => c.ciclo_label === 'R2'), `sem R2: ${ciclos.map((c) => c.ciclo_label)}`);
  assert(ciclos.some((c) => c.ciclo_label === 'R3'), `sem R3: ${ciclos.map((c) => c.ciclo_label)}`);

  const nMedAntes = Number((await db.prepare(`SELECT COUNT(*) AS n FROM medicoes WHERE pneu_id = ?`).get(pneuId)).n);
  const nMovAntes = Number((await db.prepare(`SELECT COUNT(*) AS n FROM movimentacoes WHERE pneu_id = ?`).get(pneuId)).n);
  await excluirVeiculoCompleto(db, filialId, veiculoId);
  veiculoId = null;
  const nMedExc = Number((await db.prepare(`SELECT COUNT(*) AS n FROM medicoes WHERE pneu_id = ?`).get(pneuId)).n);
  const nMovExc = Number((await db.prepare(`SELECT COUNT(*) AS n FROM movimentacoes WHERE pneu_id = ?`).get(pneuId)).n);
  const pneuVivo = await db.prepare(`SELECT id FROM pneus WHERE id = ?`).get(pneuId);
  assert(nMedExc === nMedAntes, `exclusao do veiculo apagou medicoes ${nMedAntes}->${nMedExc}`);
  assert(nMovExc === nMovAntes, `exclusao do veiculo apagou movimentacoes ${nMovAntes}->${nMovExc}`);
  assert(pneuVivo?.id === pneuId, 'exclusao do veiculo apagou o pneu');
  const snap = await db.prepare(`SELECT veiculo_apelido, custo FROM movimentacoes WHERE pneu_id = ? AND tipo = 'montagem'`).get(pneuId);
  assert(snap.veiculo_apelido === 'Toco Original' && Number(snap.custo) === 500, 'snapshot sumiu com o veiculo');

  let bloqueou = false;
  try {
    await db.prepare(`DELETE FROM pneus WHERE id = ?`).run(pneuId);
  } catch {
    bloqueou = true;
  }
  assert(bloqueou, 'exclusao do pneu apagou o historico em cascata');
  const nMedFim = Number((await db.prepare(`SELECT COUNT(*) AS n FROM medicoes WHERE pneu_id = ?`).get(pneuId)).n);
  assert(nMedFim === nMedAntes, `historico apos delete do pneu: ${nMedFim}`);

  const idxs = await db.prepare(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'idx_medicoes_pneu_recente',
        'idx_movimentacoes_pneu_data',
        'idx_medicoes_pneu_ciclo',
        'idx_movimentacoes_pneu_ciclo',
        'idx_movimentacoes_veiculo_periodo',
        'idx_medicoes_veiculo_periodo'
      )
  `).all();
  assert(idxs.length === 6, `indices faltando: ${idxs.map((i) => i.indexname).join(',')}`);

  const fks = await db.prepare(`
    SELECT c.confdeltype::text AS tipo
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE f.relname = 'pneus' AND c.contype = 'f' AND a.attname = 'pneu_id'
      AND t.relname IN ('medicoes', 'movimentacoes')
  `).all();
  assert(fks.length === 2 && fks.every((f) => f.tipo === 'r'), `fk historico: ${fks.map((f) => f.tipo).join(',')}`);
} catch (err) {
  erros.push(err.stack || err.message || String(err));
} finally {
  try {
    const db = getDb();
    if (pneuId) {
      await db.prepare(`DELETE FROM medicoes WHERE pneu_id = ?`).run(pneuId);
      await db.prepare(`DELETE FROM movimentacoes WHERE pneu_id = ?`).run(pneuId);
      await db.prepare(`DELETE FROM pneus WHERE id = ?`).run(pneuId);
    }
    if (veiculoId) await db.prepare(`DELETE FROM veiculos WHERE id = ?`).run(veiculoId);
  } catch (err) {
    erros.push(`limpeza: ${err.message}`);
  }
  await closePool();
}

if (erros.length) {
  console.error(erros.join('\n'));
  process.exit(1);
}
console.log('OK integridade do historico');
