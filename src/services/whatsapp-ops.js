/**
 * Operações de frota usadas pelo menu WhatsApp (escopo por filial_id).
 */
import { getDb } from '../database.js';
import { ehViolacaoUnique } from '../db-utils.js';
import { getLimites } from '../limites.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import {
  LAYOUT_PADRAO,
  TIPOS_PNEU,
  CONDICOES_PNEU,
  getLayout,
  labelPosicao,
  validarMontagem,
  aplicarLayoutPneus,
} from '../pneus-layouts.js';

function hojeIso() {
  return new Date().toISOString().split('T')[0];
}

async function registrarMovimentacao(db, {
  pneuId, veiculoId, tipo, data, km, hr, posicao, detalhes = null, placa = null,
}) {
  await db.prepare(`
    INSERT INTO movimentacoes (
      pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
      posicao, detalhes, veiculo_placa
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pneuId, veiculoId, tipo, data,
    km ?? null, hr ?? null, posicao ?? null, detalhes, placa
  );
}

function placaSoAlnum(p) {
  return String(p || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

/** I/1 e O/0 — digitação comum (ex.: JGZ4I28 enviado como JGZ4128) */
function placaChaveFlex(p) {
  return placaSoAlnum(p).replace(/I/g, '1').replace(/O/g, '0');
}

export async function buscarVeiculoPorPlaca(filialId, placaLimpa) {
  const db = getDb();
  const rows = await db.prepare(`
    SELECT v.*, f.nome as filial_nome,
      REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') AS placa_norm
    FROM veiculos v
    JOIN filiais f ON f.id = v.filial_id
    WHERE v.ativo = 1 AND v.filial_id = ?
      AND REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') LIKE ?
    ORDER BY v.placa
    LIMIT 15
  `).all(filialId, `%${placaLimpa}%`);

  const exatos = rows.filter((v) => placaSoAlnum(v.placa_norm) === placaLimpa);
  if (exatos.length) return exatos;

  const flexAlvo = placaChaveFlex(placaLimpa);
  const visuais = rows.filter((v) => placaChaveFlex(v.placa_norm) === flexAlvo);
  if (visuais.length) return visuais;
  if (rows.length) return rows;

  const frota = await db.prepare(`
    SELECT v.*, f.nome as filial_nome,
      REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') AS placa_norm
    FROM veiculos v
    JOIN filiais f ON f.id = v.filial_id
    WHERE v.ativo = 1 AND v.filial_id = ?
    ORDER BY v.placa
  `).all(filialId);
  return frota.filter((v) => placaChaveFlex(v.placa_norm) === flexAlvo);
}

export async function listarFrota(filialId) {
  const db = getDb();
  return db.prepare(`
    SELECT placa, apelido, tipo FROM veiculos
    WHERE ativo = 1 AND filial_id = ?
    ORDER BY placa
  `).all(filialId);
}

export async function criarVeiculo(filialId, {
  placa, apelido = null, tipo = 'Truck / Tração', km_atual = 0, layout_pneus = null,
}) {
  const db = getDb();
  const layoutId = layout_pneus
    || (String(tipo).toLowerCase().includes('toco') ? 'toco_6' : LAYOUT_PADRAO);
  try {
    const result = await db.prepare(`
      INSERT INTO veiculos (
        placa, apelido, tipo, km_atual, hr_atual, layout_pneus, filial_id, ativo
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 1)
    `).run(
      String(placa).trim().toUpperCase(),
      apelido?.trim() || null,
      normalizarTipoVeiculo(tipo) || 'Truck / Tração',
      Number(km_atual) || 0,
      layoutId,
      filialId
    );
    const id = result.lastInsertRowid;
    const posicoes = await aplicarLayoutPneus(db, id, layoutId, null);
    return { id, layoutId, total_posicoes: posicoes.length };
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      const e = new Error('Placa já cadastrada');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

export async function criarPneuEstoque(filialId, {
  numero_fogo, marca = null, modelo, tipo_pneu = 'misto',
  condicao = 'novo', sulco_inicial_mm = null,
}) {
  const db = getDb();
  const fogo = String(numero_fogo || '').trim();
  const modeloOk = String(modelo || '').trim();
  if (!fogo) throw Object.assign(new Error('Nº de fogo obrigatório'), { status: 400 });
  if (!modeloOk) throw Object.assign(new Error('Modelo obrigatório'), { status: 400 });
  const tipo = TIPOS_PNEU.includes(tipo_pneu) ? tipo_pneu : 'misto';
  const cond = CONDICOES_PNEU.includes(condicao) ? condicao : 'novo';
  const vida = cond === 'recapado' ? 1 : 0;
  try {
    const result = await db.prepare(`
      INSERT INTO pneus (
        veiculo_id, posicao, filial_id, marca, modelo, numero_fogo,
        tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, ativo
      ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'estoque', 1)
    `).run(
      filialId,
      marca?.trim() || null,
      modeloOk,
      fogo,
      tipo,
      cond,
      vida,
      sulco_inicial_mm != null ? Number(sulco_inicial_mm) : null
    );
    return db.prepare('SELECT * FROM pneus WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      throw Object.assign(new Error('Já existe pneu com este nº de fogo'), { status: 409 });
    }
    throw err;
  }
}

export async function listarEstoque(filialId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT id, numero_fogo, marca, modelo, tipo_pneu, condicao
    FROM pneus
    WHERE filial_id = ? AND ativo = 1 AND status_pneu = 'estoque'
    ORDER BY numero_fogo
    LIMIT ?
  `).all(filialId, limit);
}

export async function buscarPneuPorFogo(filialId, fogo) {
  const db = getDb();
  const n = String(fogo || '').trim();
  return db.prepare(`
    SELECT p.*, v.placa
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.filial_id = ? AND p.ativo = 1
      AND LOWER(TRIM(p.numero_fogo)) = LOWER(?)
    LIMIT 1
  `).get(filialId, n);
}

export async function listarPneusMontados(veiculoId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, numero_fogo, posicao, marca, modelo
    FROM pneus
    WHERE veiculo_id = ? AND ativo = 1 AND status_pneu = 'montado'
    ORDER BY posicao
  `).all(veiculoId);
}

export async function posicoesLivres(veiculoId) {
  const db = getDb();
  const v = await db.prepare('SELECT * FROM veiculos WHERE id = ? AND ativo = 1').get(veiculoId);
  if (!v) return [];
  const layout = getLayout(v.layout_pneus || LAYOUT_PADRAO);
  const ocupadas = new Set(
    (await db.prepare(`
      SELECT posicao FROM pneus
      WHERE veiculo_id = ? AND ativo = 1 AND status_pneu = 'montado'
    `).all(veiculoId)).map((r) => r.posicao)
  );
  return layout.posicoes.filter((p) => !ocupadas.has(p));
}

export async function montarPneu({ filialId, pneuId, veiculoId, posicao }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu === 'descarte') {
    throw Object.assign(new Error('Pneu descartado não pode ser montado'), { status: 400 });
  }
  if (pneu.status_pneu === 'montado') {
    throw Object.assign(new Error('Pneu já está montado'), { status: 400 });
  }
  const veiculo = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoId, filialId);
  if (!veiculo) throw Object.assign(new Error('Veículo não encontrado'), { status: 404 });

  const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
  if (!layout.posicoes.includes(posicao)) {
    throw Object.assign(new Error(`Posição ${posicao} inválida neste veículo`), { status: 400 });
  }
  const validacao = validarMontagem({
    condicao: pneu.condicao,
    tipo_pneu: pneu.tipo_pneu,
    posicao,
  });
  if (!validacao.ok) {
    throw Object.assign(new Error(validacao.erros.join(' ')), { status: 400 });
  }
  const ocupado = await db.prepare(`
    SELECT id, numero_fogo FROM pneus
    WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
  `).get(veiculoId, posicao);
  if (ocupado) {
    throw Object.assign(
      new Error(`Posição ${posicao} ocupada${ocupado.numero_fogo ? ` (fogo ${ocupado.numero_fogo})` : ''}`),
      { status: 409 }
    );
  }

  const data = hojeIso();
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = ?, posicao = ?, status_pneu = 'montado',
        data_instalacao = ?, km_instalacao = ?, ativo = 1
      WHERE id = ?
    `).run(veiculoId, posicao, data, veiculo.km_atual || null, pneuId);
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId,
      tipo: 'montagem',
      data,
      km: veiculo.km_atual,
      hr: veiculo.hr_atual,
      posicao,
      detalhes: `WhatsApp · ${veiculo.placa} · ${labelPosicao(posicao)}`,
      placa: veiculo.placa,
    });
  });
  return { placa: veiculo.placa, posicao, label: labelPosicao(posicao), fogo: pneu.numero_fogo };
}

export async function desmontarPneu({ filialId, pneuId }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT p.*, v.placa, v.km_atual, v.hr_atual
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.id = ? AND p.filial_id = ? AND p.ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu !== 'montado' || !pneu.veiculo_id) {
    throw Object.assign(new Error('Pneu não está montado'), { status: 400 });
  }
  const data = hojeIso();
  const veiculoId = pneu.veiculo_id;
  const posicao = pneu.posicao;
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET veiculo_id = NULL, posicao = NULL, status_pneu = 'estoque', data_instalacao = NULL
      WHERE id = ?
    `).run(pneuId);
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId,
      tipo: 'retirada',
      data,
      km: pneu.km_atual,
      hr: pneu.hr_atual,
      posicao,
      detalhes: `WhatsApp · retirou de ${pneu.placa || ''}`,
      placa: pneu.placa,
    });
  });
  return { fogo: pneu.numero_fogo, placa: pneu.placa, posicao };
}

export async function registrarRecap({ filialId, pneuId }) {
  const db = getDb();
  const limites = getLimites();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  const novaVida = (pneu.vida_recap || 0) + 1;
  if (novaVida > (limites.max_recaps || 6)) {
    throw Object.assign(new Error(`Limite de recaps atingido (${limites.max_recaps})`), { status: 400 });
  }
  const data = hojeIso();
  if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
    const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
    await db.transaction(async () => {
      await db.prepare(`
        UPDATE pneus SET
          veiculo_id = NULL, posicao = NULL, status_pneu = 'recapagem',
          vida_recap = ?, condicao = 'recapado', data_instalacao = NULL
        WHERE id = ?
      `).run(novaVida, pneuId);
      await registrarMovimentacao(db, {
        pneuId,
        veiculoId: pneu.veiculo_id,
        tipo: 'retirada',
        data,
        km: veiculo?.km_atual,
        hr: veiculo?.hr_atual,
        posicao: pneu.posicao,
        detalhes: 'WhatsApp · retirou para recap',
        placa: veiculo?.placa,
      });
    });
  } else {
    await db.prepare(`
      UPDATE pneus SET status_pneu = 'recapagem', vida_recap = ?, condicao = 'recapado'
      WHERE id = ?
    `).run(novaVida, pneuId);
  }
  return { fogo: pneu.numero_fogo, vida: novaVida };
}

export async function registrarDescarte({ filialId, pneuId, motivo = null }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT p.*, v.placa, v.km_atual, v.hr_atual
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.id = ? AND p.filial_id = ? AND p.ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu === 'descarte') {
    throw Object.assign(new Error('Pneu já está no descarte'), { status: 400 });
  }
  const data = hojeIso();
  await db.transaction(async () => {
    if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
      await registrarMovimentacao(db, {
        pneuId,
        veiculoId: pneu.veiculo_id,
        tipo: 'retirada',
        data,
        km: pneu.km_atual,
        hr: pneu.hr_atual,
        posicao: pneu.posicao,
        detalhes: 'WhatsApp · retirou para descarte',
        placa: pneu.placa,
      });
    }
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = NULL, posicao = NULL, status_pneu = 'descarte', ativo = 0,
        tratamento_descarte = 'pendente',
        tratamento_descarte_obs = ?,
        tratamento_descarte_em = ?,
        data_instalacao = NULL
      WHERE id = ?
    `).run(motivo?.trim() || null, data, pneuId);
  });
  return { fogo: pneu.numero_fogo };
}

export { labelPosicao, TIPOS_PNEU, CONDICOES_PNEU };
