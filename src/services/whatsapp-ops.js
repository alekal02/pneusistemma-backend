/**
 * Operações de frota usadas pelo menu WhatsApp (escopo por filial_id).
 */
import { getDb } from '../database.js';
import { ehViolacaoUnique } from '../db-utils.js';
import { getLimites } from '../limites.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import { comRetryFogoUnico } from '../numero-fogo.js';
import {
  LAYOUT_PADRAO,
  TIPOS_PNEU,
  CONDICOES_PNEU,
  getLayout,
  labelPosicao,
  validarMontagem,
  aplicarLayoutPneus,
  layoutPadraoPorTipo,
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

  const exatos = rows.filter((v) => {
    const p = String(v.placa_norm || '').replace(/[^A-Z0-9]/gi, '');
    return p === placaLimpa;
  });
  return exatos.length ? exatos : rows;
}

export async function listarFrota(filialId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, placa, apelido, tipo, layout_pneus
    FROM veiculos
    WHERE ativo = 1 AND filial_id = ?
    ORDER BY placa
  `).all(filialId);
}

export async function criarVeiculo(filialId, {
  placa, apelido = null, tipo = 'Truck / Tração', km_atual = 0, layout_pneus = null,
}) {
  const db = getDb();
  const layoutId = layout_pneus || layoutPadraoPorTipo(tipo);
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
  const modeloOk = String(modelo || '').trim();
  if (!modeloOk) throw Object.assign(new Error('Modelo obrigatório'), { status: 400 });
  const tipo = TIPOS_PNEU.includes(tipo_pneu) ? tipo_pneu : 'misto';
  const cond = CONDICOES_PNEU.includes(condicao) ? condicao : 'novo';
  const vida = cond === 'recapado' ? 1 : 0;
  try {
    const { result } = await comRetryFogoUnico(db, filialId, numero_fogo, (fogo) => (
      db.prepare(`
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
      )
    ));
    return db.prepare('SELECT * FROM pneus WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    if (err.status) throw err;
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
  return {
    fogo: pneu.numero_fogo,
    placa: pneu.placa,
    posicao,
    veiculo_id: veiculoId,
    estava_montado: true,
  };
}

export async function registrarRecap({ filialId, pneuId }) {
  const db = getDb();
  const limites = getLimites();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu === 'recapagem') {
    throw Object.assign(new Error('Pneu já está em recapagem'), { status: 400 });
  }
  if (pneu.status_pneu === 'descarte') {
    throw Object.assign(new Error('Pneu já está no descarte'), { status: 400 });
  }
  const novaVida = (pneu.vida_recap || 0) + 1;
  if (novaVida > (limites.max_recaps || 6)) {
    throw Object.assign(new Error(`Limite de recaps atingido (${limites.max_recaps})`), { status: 400 });
  }
  const data = hojeIso();
  const estavaMontado = pneu.status_pneu === 'montado' && pneu.veiculo_id;
  const veiculoId = pneu.veiculo_id || null;
  const posicao = pneu.posicao || null;
  let placa = null;
  if (estavaMontado) {
    const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
    placa = veiculo?.placa || null;
  }
  await db.transaction(async () => {
    if (estavaMontado) {
      const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
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
    }
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = NULL, posicao = NULL, status_pneu = 'recapagem',
        vida_recap = ?, condicao = 'recapado', data_instalacao = NULL
      WHERE id = ?
    `).run(novaVida, pneuId);
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId: estavaMontado ? veiculoId : null,
      tipo: 'recap',
      data,
      km: null,
      hr: null,
      posicao: estavaMontado ? posicao : null,
      detalhes: estavaMontado
        ? `WhatsApp · enviou à recap (${novaVida}ª vida) · origem ${placa || ''} ${posicao || ''}`.trim()
        : `WhatsApp · enviou à recap (${novaVida}ª vida) · origem estoque`,
      placa,
    });
  });
  return {
    fogo: pneu.numero_fogo,
    vida: novaVida,
    estava_montado: Boolean(estavaMontado),
    veiculo_id: veiculoId,
    posicao,
    placa,
  };
}

/** Recap concluído: pneu volta ao estoque para reuso */
export async function devolverRecapAoEstoque({ filialId, pneuId }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu !== 'recapagem') {
    throw Object.assign(new Error('Pneu não está em recapagem'), { status: 400 });
  }
  const data = hojeIso();
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET
        status_pneu = 'estoque',
        condicao = 'recapado',
        veiculo_id = NULL,
        posicao = NULL,
        data_instalacao = NULL
      WHERE id = ?
    `).run(pneuId);
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId: null,
      tipo: 'retorno_recap',
      data,
      km: null,
      hr: null,
      posicao: null,
      detalhes: `WhatsApp · recap concluído · voltou ao estoque (${pneu.vida_recap || 1}ª vida)`,
      placa: null,
    });
  });
  return {
    fogo: pneu.numero_fogo,
    vida: pneu.vida_recap || 1,
    mensagem: `Fogo ${pneu.numero_fogo} voltou ao estoque (recapado)`,
  };
}

/**
 * Troca o pneu montado por outro do estoque na mesma posição.
 */
export async function trocarPorEstoque({ filialId, pneuMontadoId, pneuEstoqueId }) {
  const montado = await getDb().prepare(`
    SELECT * FROM pneus
    WHERE id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'montado'
  `).get(pneuMontadoId, filialId);
  if (!montado) throw Object.assign(new Error('Pneu montado não encontrado'), { status: 404 });

  const estoque = await getDb().prepare(`
    SELECT * FROM pneus
    WHERE id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'estoque'
  `).get(pneuEstoqueId, filialId);
  if (!estoque) throw Object.assign(new Error('Pneu do estoque não encontrado'), { status: 404 });

  const posicao = montado.posicao;
  const veiculoId = montado.veiculo_id;
  const retirado = await desmontarPneu({ filialId, pneuId: montado.id });
  const montagem = await montarPneu({
    filialId,
    pneuId: estoque.id,
    veiculoId,
    posicao,
  });
  return {
    mensagem: `Trocou fogo ${retirado.fogo} → ${montagem.fogo} em ${montagem.label}`,
    retirado,
    montado: montagem,
  };
}

/**
 * Move o pneu para outro veículo/posição da frota.
 * Se a posição destino estiver ocupada, troca os dois pneus (swap).
 */
export async function moverOuTrocarNaFrota({
  filialId,
  pneuId,
  veiculoDestinoId,
  posicaoDestino,
  detalhes = null,
}) {
  const db = getDb();
  const posDest = String(posicaoDestino || '').trim().toUpperCase();
  if (!posDest) {
    throw Object.assign(new Error('Informe a posição de destino'), { status: 400 });
  }

  const origem = await db.prepare(`
    SELECT p.*, v.placa as placa_origem, v.km_atual as km_origem, v.hr_atual as hr_origem
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1
    WHERE p.id = ? AND p.filial_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
  `).get(pneuId, filialId);
  if (!origem) {
    throw Object.assign(new Error('Pneu montado não encontrado'), { status: 404 });
  }

  const veiculoDest = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoDestinoId, filialId);
  if (!veiculoDest) {
    throw Object.assign(new Error('Veículo de destino não encontrado'), { status: 404 });
  }

  const layoutDest = getLayout(veiculoDest.layout_pneus || LAYOUT_PADRAO);
  if (!layoutDest.posicoes.includes(posDest)) {
    throw Object.assign(new Error(`Posição ${posDest} inválida no veículo ${veiculoDest.placa}`), { status: 400 });
  }

  if (Number(origem.veiculo_id) === Number(veiculoDest.id) && origem.posicao === posDest) {
    throw Object.assign(new Error('Pneu já está nesta posição'), { status: 400 });
  }

  const valOrigem = validarMontagem({
    condicao: origem.condicao,
    tipo_pneu: origem.tipo_pneu,
    posicao: posDest,
  });
  if (!valOrigem.ok) {
    throw Object.assign(new Error(valOrigem.erros.join(' ')), { status: 400 });
  }

  const ocupante = await db.prepare(`
    SELECT p.*, v.placa as placa_ocupante
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.veiculo_id = ? AND p.posicao = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
  `).get(veiculoDest.id, posDest, origem.id);

  const data = hojeIso();
  const posOrigem = origem.posicao;
  const veiculoOrigemId = origem.veiculo_id;
  const placaOrigem = origem.placa_origem;

  if (ocupante) {
    const valOcupante = validarMontagem({
      condicao: ocupante.condicao,
      tipo_pneu: ocupante.tipo_pneu,
      posicao: posOrigem,
    });
    if (!valOcupante.ok) {
      throw Object.assign(
        new Error(`Não dá para trocar: pneu fogo ${ocupante.numero_fogo} não serve em ${labelPosicao(posOrigem)}. ${valOcupante.erros.join(' ')}`),
        { status: 400 }
      );
    }

    await db.transaction(async () => {
      // Libera destino temporariamente (evita unique parcial)
      await db.prepare(`
        UPDATE pneus SET posicao = NULL WHERE id = ?
      `).run(ocupante.id);

      await db.prepare(`
        UPDATE pneus SET veiculo_id = ?, posicao = ?, data_instalacao = COALESCE(data_instalacao, ?)
        WHERE id = ?
      `).run(veiculoDest.id, posDest, data, origem.id);

      await db.prepare(`
        UPDATE pneus SET veiculo_id = ?, posicao = ?, data_instalacao = COALESCE(data_instalacao, ?)
        WHERE id = ?
      `).run(veiculoOrigemId, posOrigem, data, ocupante.id);

      const detBase = detalhes?.trim()
        || `Troca na frota · ${placaOrigem} ${labelPosicao(posOrigem)} ↔ ${veiculoDest.placa} ${labelPosicao(posDest)}`;

      await registrarMovimentacao(db, {
        pneuId: origem.id,
        veiculoId: veiculoDest.id,
        tipo: 'mudanca_posicao',
        data,
        km: veiculoDest.km_atual,
        hr: veiculoDest.hr_atual,
        posicao: posDest,
        detalhes: `${detBase} · fogo ${origem.numero_fogo}`,
        placa: veiculoDest.placa,
      });
      await registrarMovimentacao(db, {
        pneuId: ocupante.id,
        veiculoId: veiculoOrigemId,
        tipo: 'mudanca_posicao',
        data,
        km: origem.km_origem,
        hr: origem.hr_origem,
        posicao: posOrigem,
        detalhes: `${detBase} · fogo ${ocupante.numero_fogo}`,
        placa: placaOrigem,
      });
    });

    return {
      modo: 'troca',
      mensagem: `Trocou fogo ${origem.numero_fogo} (${placaOrigem} ${labelPosicao(posOrigem)}) ↔ fogo ${ocupante.numero_fogo} (${veiculoDest.placa} ${labelPosicao(posDest)})`,
      origem: {
        id: origem.id,
        fogo: origem.numero_fogo,
        de: { veiculo_id: veiculoOrigemId, placa: placaOrigem, posicao: posOrigem },
        para: { veiculo_id: veiculoDest.id, placa: veiculoDest.placa, posicao: posDest },
      },
      destino: {
        id: ocupante.id,
        fogo: ocupante.numero_fogo,
        de: { veiculo_id: veiculoDest.id, placa: veiculoDest.placa, posicao: posDest },
        para: { veiculo_id: veiculoOrigemId, placa: placaOrigem, posicao: posOrigem },
      },
    };
  }

  // Posição livre: só move
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET veiculo_id = ?, posicao = ?, data_instalacao = COALESCE(data_instalacao, ?)
      WHERE id = ?
    `).run(veiculoDest.id, posDest, data, origem.id);

    await registrarMovimentacao(db, {
      pneuId: origem.id,
      veiculoId: veiculoDest.id,
      tipo: 'mudanca_posicao',
      data,
      km: veiculoDest.km_atual,
      hr: veiculoDest.hr_atual,
      posicao: posDest,
      detalhes: detalhes?.trim()
        || `Moveu na frota · ${placaOrigem} ${labelPosicao(posOrigem)} → ${veiculoDest.placa} ${labelPosicao(posDest)}`,
      placa: veiculoDest.placa,
    });
  });

  return {
    modo: 'mover',
    mensagem: `Moveu fogo ${origem.numero_fogo}: ${placaOrigem} ${labelPosicao(posOrigem)} → ${veiculoDest.placa} ${labelPosicao(posDest)}`,
    origem: {
      id: origem.id,
      fogo: origem.numero_fogo,
      de: { veiculo_id: veiculoOrigemId, placa: placaOrigem, posicao: posOrigem },
      para: { veiculo_id: veiculoDest.id, placa: veiculoDest.placa, posicao: posDest },
    },
  };
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
  const estavaMontado = pneu.status_pneu === 'montado' && pneu.veiculo_id;
  const veiculoId = pneu.veiculo_id || null;
  const posicao = pneu.posicao || null;
  await db.transaction(async () => {
    if (estavaMontado) {
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
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId: estavaMontado ? veiculoId : null,
      tipo: 'descarte',
      data,
      km: pneu.km_atual,
      hr: pneu.hr_atual,
      posicao: estavaMontado ? posicao : null,
      detalhes: motivo?.trim() || 'WhatsApp · enviou ao descarte',
      placa: pneu.placa || null,
    });
  });
  return {
    fogo: pneu.numero_fogo,
    estava_montado: Boolean(estavaMontado),
    veiculo_id: veiculoId,
    posicao,
    placa: pneu.placa || null,
  };
}

export { labelPosicao, TIPOS_PNEU, CONDICOES_PNEU };
