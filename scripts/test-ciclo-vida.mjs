/**
 * Ciclo de vida: medição → retirada → estoque → recapagem → nova montagem → nova medição.
 * Não grava backfill. Apaga o pneu de teste ao final.
 */
import { initDatabase, getDb, closePool } from '../src/database.js';
import { registrarMovimentacao } from '../src/services/pneu-movimentacao.js';
import { calcularCiclos, carregarEvolucaoDesgaste } from '../src/services/pneu-ciclo.js';
import { gerarRelatorioSemanalPdfBuffer } from '../src/services/relatorio-semanal-pdf.js';

const erros = [];
function assert(cond, msg) {
  if (!cond) erros.push(msg);
}

function cenarioMemoria() {
  const mov = [
    { id: 1, tipo: 'entrada_estoque', data_evento: '2026-01-01', ciclo: 0, custo: 800 },
    { id: 2, tipo: 'montagem', data_evento: '2026-01-02', ciclo: 0, km_veiculo: 10000, veiculo_id: 1, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '1E' },
    { id: 3, tipo: 'retirada', data_evento: '2026-02-02', ciclo: 0, km_veiculo: 15000, veiculo_id: 1, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '1E' },
    { id: 4, tipo: 'recap', data_evento: '2026-02-03', ciclo: 0, detalhes: 'Enviado à recap', sulco_antes: 8, custo: 250, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '1E' },
    { id: 5, tipo: 'retorno_recap', data_evento: '2026-02-20', ciclo: 1, sulco_depois: 13, sulco_mm: 13 },
    { id: 6, tipo: 'montagem', data_evento: '2026-02-21', ciclo: 1, km_veiculo: 40000, veiculo_id: 1, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '2EE' },
  ];
  const med = [
    { id: 1, data_medicao: '2026-01-02', ciclo: 0, km_veiculo: 10000, sulco_externo: 14, sulco_central: 14, sulco_interno: 14, veiculo_id: 1, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '1E' },
    { id: 2, data_medicao: '2026-02-01', ciclo: 0, km_veiculo: 14000, sulco_externo: 8, sulco_central: 9, sulco_interno: 8, veiculo_id: 1, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '1E' },
    { id: 3, data_medicao: '2026-03-01', ciclo: 1, km_veiculo: 43000, sulco_externo: 10, sulco_central: 10, sulco_interno: 11, veiculo_id: 1, veiculo_placa: 'ABC1D23', veiculo_apelido: 'Toco', posicao: '2EE' },
  ];
  const ciclos = calcularCiclos({ movimentacoes: mov, medicoes: med });
  const original = ciclos.find((c) => c.ciclo === 0);
  const r1 = ciclos.find((c) => c.ciclo === 1);
  assert(original?.ciclo_label === 'Original', `ciclo original: ${original?.ciclo_label}`);
  assert(r1?.ciclo_label === 'R1', `ciclo R1: ${r1?.ciclo_label}`);
  assert(original?.sulco_inicial === 14, `inicial original ${original?.sulco_inicial}`);
  assert(original?.sulco_atual === 8, `atual original ${original?.sulco_atual}`);
  assert(original?.mm_consumidos === 6, `consumido original ${original?.mm_consumidos}`);
  assert(original?.km === 5000, `km original ${original?.km} (estoque nao pode entrar)`);
  assert(original?.custo === 800, `custo original ${original?.custo}`);
  assert(original?.veiculos?.[0] === 'ABC1D23/Toco', `veiculo original ${original?.veiculos}`);
  assert(r1?.sulco_inicial === 13, `inicial R1 ${r1?.sulco_inicial}`);
  assert(r1?.sulco_atual === 10, `atual R1 ${r1?.sulco_atual}`);
  assert(r1?.mm_consumidos === 3, `consumido R1 ${r1?.mm_consumidos}`);
  assert(r1?.km === 3000, `km R1 ${r1?.km} (pulo 15000→40000 em estoque nao conta)`);
  assert(r1?.custo === 250, `custo recap no R1 ${r1?.custo}`);
  assert(r1?.rendimento === 1000, `rendimento R1 ${r1?.rendimento}`);
  assert(r1?.posicoes?.includes('2EE'), `posicao R1 ${r1?.posicoes}`);

  const inferido = calcularCiclos({
    movimentacoes: [
      { id: 1, tipo: 'montagem', data_evento: '2026-01-01', km_veiculo: 1000, veiculo_id: 1, veiculo_placa: 'AAA0001' },
      { id: 2, tipo: 'retirada', data_evento: '2026-02-01', km_veiculo: 2000, veiculo_id: 1, veiculo_placa: 'AAA0001' },
      { id: 3, tipo: 'recap', data_evento: '2026-02-02', detalhes: 'Enviado à recap' },
      { id: 4, tipo: 'retorno_recap', data_evento: '2026-03-01', sulco_mm: 12 },
      { id: 5, tipo: 'montagem', data_evento: '2026-03-02', km_veiculo: 9000, veiculo_id: 1, veiculo_placa: 'AAA0001' },
    ],
    medicoes: [
      { id: 1, data_medicao: '2026-01-15', sulco_externo: 15, veiculo_id: 1, veiculo_placa: 'AAA0001' },
      { id: 2, data_medicao: '2026-03-10', km_veiculo: 9500, sulco_externo: 9, veiculo_id: 1, veiculo_placa: 'AAA0001' },
    ],
  });
  const inf0 = inferido.find((c) => c.ciclo === 0);
  const inf1 = inferido.find((c) => c.ciclo === 1);
  assert(inf0?.km === 1000, `historico sem ciclo km ${inf0?.km}`);
  assert(inf0?.mm_consumidos == null, 'historico sem sulco final nao inventa consumo');
  assert(inf1?.km === 500, `historico R1 km ${inf1?.km}`);
  assert(inf1?.sulco_inicial === 12 && inf1?.mm_consumidos === 3, `historico R1 sulco ${inf1?.sulco_inicial}/${inf1?.mm_consumidos}`);

  const incompleto = calcularCiclos({
    medicoes: [{ id: 1, data_medicao: '2026-01-01', sulco_externo: 12 }],
    movimentacoes: [],
  });
  assert(incompleto[0]?.mm_consumidos == null, 'uma medicao nao inventa consumo');
  assert(incompleto[0]?.km == null, 'sem montagem nao inventa km');
}

cenarioMemoria();

const tag = `CT${Date.now().toString().slice(-8)}`;
let pneuId = null;
let veiculoId = null;

try {
  await initDatabase();
  const db = getDb();
  const filial = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get();
  assert(filial?.id, 'filial MATRIZ');
  if (!filial?.id) throw new Error('sem filial');

  const veiculo = await db.prepare(`
    INSERT INTO veiculos (placa, apelido, tipo, layout_pneus, km_atual, filial_id)
    VALUES (?, 'Toco Teste', 'Truck / Tracao', 'truck_6x2', 10000, ?)
    RETURNING id
  `).get(`Z${tag.slice(-6)}`, filial.id);
  veiculoId = veiculo.id;

  const pneu = await db.prepare(`
    INSERT INTO pneus (
      filial_id, modelo, numero_fogo, status_pneu, vida_recap, custo, ativo, condicao
    ) VALUES (?, 'Teste Ciclo', ?, 'estoque', 0, 800, 1, 'novo')
    RETURNING id
  `).get(filial.id, tag);
  pneuId = pneu.id;

  await db.prepare(`
    INSERT INTO movimentacoes (pneu_id, tipo, data_evento, detalhes)
    VALUES (?, 'montagem', '2020-01-01', 'legado sem ciclo')
  `).run(pneuId);
  const legado = await db.prepare(`
    SELECT id, ciclo FROM movimentacoes
    WHERE pneu_id = ? AND detalhes = 'legado sem ciclo'
  `).get(pneuId);

  async function medicao({ data, km, sulco, ciclo, posicao }) {
    await db.prepare(`
      INSERT INTO medicoes (
        pneu_id, data_medicao, km_veiculo, sulco_externo, sulco_central, sulco_interno,
        veiculo_id, veiculo_placa, veiculo_apelido, posicao, ciclo, responsavel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ZPLACA', 'Toco Teste', ?, ?, 'teste')
    `).run(pneuId, data, km, sulco, sulco, sulco, veiculoId, posicao, ciclo);
  }

  await registrarMovimentacao(db, {
    pneuId, veiculoId: null, tipo: 'entrada_estoque', data: '2026-01-01',
    ciclo: 0, custo: 800, usuario: 'teste', detalhes: 'Entrada no estoque',
  });
  await registrarMovimentacao(db, {
    pneuId, veiculoId, tipo: 'montagem', data: '2026-01-02',
    km: 10000, posicao: '1E', ciclo: 0, usuario: 'teste',
    placa: `Z${tag.slice(-6)}`, apelido: 'Toco Teste',
  });
  await medicao({ data: '2026-01-02', km: 10000, sulco: 14, ciclo: 0, posicao: '1E' });
  await medicao({ data: '2026-02-01', km: 14000, sulco: 8, ciclo: 0, posicao: '1E' });
  const nMed = await db.prepare(`SELECT COUNT(*) AS n FROM medicoes WHERE pneu_id = ?`).get(pneuId);
  assert(Number(nMed.n) === 2, `medicoes preservadas ${nMed.n}`);

  await registrarMovimentacao(db, {
    pneuId, veiculoId, tipo: 'retirada', data: '2026-02-02',
    km: 15000, posicao: '1E', ciclo: 0, usuario: 'teste',
    placa: `Z${tag.slice(-6)}`, apelido: 'Toco Teste', detalhes: 'Retirou para estoque',
  });
  await db.prepare(`
    UPDATE pneus SET status_pneu = 'estoque', veiculo_id = NULL, posicao = NULL WHERE id = ?
  `).run(pneuId);

  await registrarMovimentacao(db, {
    pneuId, veiculoId, tipo: 'recap', data: '2026-02-03',
    km: 15000, posicao: '1E', ciclo: 0, sulcoAntes: 8, custo: 250, usuario: 'teste',
    placa: `Z${tag.slice(-6)}`, apelido: 'Toco Teste',
    detalhes: 'Enviado à recap (1ª vida)',
  });
  await db.prepare(`
    UPDATE pneus SET status_pneu = 'recapagem', vida_recap = 1, veiculo_id = NULL, posicao = NULL
    WHERE id = ?
  `).run(pneuId);
  await db.prepare(`
    UPDATE veiculos SET km_atual = 40000, apelido = 'MUDOU AGORA', placa = ? WHERE id = ?
  `).run(`Y${tag.slice(-6)}`, veiculoId);

  await registrarMovimentacao(db, {
    pneuId, veiculoId: null, tipo: 'retorno_recap', data: '2026-02-20',
    ciclo: 1, sulcoDepois: 13, sulcoMm: 13, usuario: 'teste',
    detalhes: 'Recap concluído · recebido da recap',
  });
  await db.prepare(`
    INSERT INTO medicoes (
      pneu_id, data_medicao, sulco_externo, sulco_central, sulco_interno, ciclo, responsavel
    ) VALUES (?, '2026-02-20', 13, 13, 13, 1, 'retorno_recap')
  `).run(pneuId);
  await db.prepare(`
    UPDATE pneus SET status_pneu = 'estoque', vida_recap = 1, sulco_inicial_mm = 13 WHERE id = ?
  `).run(pneuId);

  await registrarMovimentacao(db, {
    pneuId, veiculoId, tipo: 'montagem', data: '2026-02-21',
    km: 40000, posicao: '2EE', ciclo: 1, usuario: 'teste',
    placa: `Z${tag.slice(-6)}`, apelido: 'Toco Teste',
  });
  await db.prepare(`
    UPDATE pneus SET status_pneu = 'montado', veiculo_id = ?, posicao = '2EE' WHERE id = ?
  `).run(veiculoId, pneuId);
  await medicao({ data: '2026-03-01', km: 43000, sulco: 10, ciclo: 1, posicao: '2EE' });

  const legadoDepois = await db.prepare(`SELECT ciclo FROM movimentacoes WHERE id = ?`).get(legado.id);
  assert(legadoDepois.ciclo == null, `legado regravado ciclo=${legadoDepois.ciclo}`);

  const retirada = await db.prepare(`
    SELECT km_rodado, veiculo_apelido FROM movimentacoes
    WHERE pneu_id = ? AND tipo = 'retirada'
    ORDER BY id DESC LIMIT 1
  `).get(pneuId);
  assert(Number(retirada.km_rodado) === 5000, `km_rodado retirada ${retirada.km_rodado}`);
  assert(retirada.veiculo_apelido === 'Toco Teste', `apelido snapshot ${retirada.veiculo_apelido}`);

  const segundaMontagem = await db.prepare(`
    SELECT km_rodado FROM movimentacoes
    WHERE pneu_id = ? AND tipo = 'montagem' AND ciclo = 1
  `).get(pneuId);
  assert(segundaMontagem.km_rodado == null, `montagem nova nao herda km de estoque (${segundaMontagem.km_rodado})`);

  const histMov = await db.prepare(`SELECT * FROM movimentacoes WHERE pneu_id = ?`).all(pneuId);
  const histMed = await db.prepare(`SELECT * FROM medicoes WHERE pneu_id = ?`).all(pneuId);
  const ciclos = calcularCiclos({ movimentacoes: histMov, medicoes: histMed });
  const original = ciclos.find((c) => c.ciclo === 0);
  const r1 = ciclos.find((c) => c.ciclo === 1);
  assert(original?.km === 5000, `db km original ${original?.km}`);
  assert(original?.mm_consumidos === 6, `db mm original ${original?.mm_consumidos}`);
  assert(original?.veiculos?.some((v) => v.includes('Toco Teste')), `db apelido historico ${original?.veiculos}`);
  assert(!original?.veiculos?.some((v) => v.includes('MUDOU')), `apelido novo vazou ${original?.veiculos}`);
  assert(r1?.km === 3000, `db km R1 ${r1?.km}`);
  assert(r1?.sulco_inicial === 13 && r1?.sulco_atual === 10, `db sulco R1 ${r1?.sulco_inicial}/${r1?.sulco_atual}`);
  assert(r1?.mm_consumidos === 3, `db mm R1 ${r1?.mm_consumidos}`);
  assert(Number(histMed.length) === 4, `medicoes finais ${histMed.length}`);

  const evo = await carregarEvolucaoDesgaste(db, filial.id, { limite: 80 });
  const linhas = evo.linhas.filter((l) => l.pneu_id === pneuId);
  assert(linhas.some((l) => l.ciclo === 'Original' && l.consumido === 6), `relatorio original ${JSON.stringify(linhas)}`);
  assert(linhas.some((l) => l.ciclo === 'R1' && l.km === 3000), `relatorio R1 ${JSON.stringify(linhas)}`);

  const pdf = await gerarRelatorioSemanalPdfBuffer(filial.id, { geradoPor: 'teste-ciclo' });
  assert(pdf.buffer?.length > 1000, `pdf ${pdf.buffer?.length}`);
  assert(pdf.dados?.evolucao_desgaste?.linhas?.some((l) => l.pneu_id === pneuId), 'pdf sem evolucao do pneu');
} catch (err) {
  erros.push(`db: ${err.stack || err.message || err}`);
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
console.log('OK ciclo medicao → retirada → estoque → recapagem → montagem → medicao');
