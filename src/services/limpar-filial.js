/**
 * Zera frota operacional de UMA filial: veículos, pneus, medições, movimentações.
 * Mantém o cadastro da filial, logins e configuração WhatsApp.
 */
import { comSavepoint } from '../db-utils.js';
export async function localizarFilialBh(db, filtro = '') {
  const q = String(filtro || '').trim();
  const filiais = await db.prepare(`
    SELECT id, nome, codigo, ativo FROM filiais ORDER BY nome
  `).all();

  if (q) {
    const nq = q.toLowerCase();
    const hits = filiais.filter((f) => {
      const nome = String(f.nome || '').toLowerCase();
      const codigo = String(f.codigo || '').toLowerCase();
      return nome.includes(nq) || codigo === nq || codigo.includes(nq);
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const err = new Error(
        `Mais de uma filial bate com "${q}": ${hits.map((f) => `${f.codigo} (${f.nome})`).join(', ')}`
      );
      err.status = 400;
      err.candidatas = hits;
      throw err;
    }
  }

  const bh = filiais.filter((f) => {
    const nome = String(f.nome || '').toLowerCase();
    const codigo = String(f.codigo || '').toUpperCase();
    return nome.includes('belo horizonte')
      || nome.includes('belo-horizonte')
      || /\bbh\b/.test(nome)
      || codigo === 'BH'
      || codigo === 'BHZ'
      || codigo === 'BELHORIZONTE';
  });
  if (bh.length === 1) return bh[0];
  if (bh.length > 1) {
    const err = new Error(
      `Mais de uma filial BH: ${bh.map((f) => `${f.codigo} (${f.nome})`).join(', ')}`
    );
    err.status = 400;
    err.candidatas = bh;
    throw err;
  }
  const err = new Error('Filial Belo Horizonte não encontrada');
  err.status = 404;
  err.filiais = filiais.map((f) => ({ id: f.id, nome: f.nome, codigo: f.codigo }));
  throw err;
}

async function nSafe(db, sql, ...p) {
  try {
    return Number((await db.prepare(sql).get(...p))?.c || 0);
  } catch (err) {
    if (/does not exist|undefined_table/i.test(String(err.message || ''))) return 0;
    throw err;
  }
}

async function delSafe(db, sql, ...p) {
  try {
    return await comSavepoint(db, () => db.prepare(sql).run(...p));
  } catch (err) {
    if (/does not exist|undefined_table/i.test(String(err.message || ''))) return { changes: 0 };
    throw err;
  }
}

export async function contarFrotaFilial(db, filialId) {
  const vid = `SELECT id FROM veiculos WHERE filial_id = ?`;
  const pid = `SELECT id FROM pneus WHERE filial_id = ? OR veiculo_id IN (${vid})`;
  return {
    veiculos: await nSafe(db, 'SELECT COUNT(*) as c FROM veiculos WHERE filial_id = ?', filialId),
    pneus: await nSafe(db, `SELECT COUNT(*) as c FROM pneus WHERE filial_id = ? OR veiculo_id IN (${vid})`, filialId, filialId),
    medicoes: await nSafe(db, `SELECT COUNT(*) as c FROM medicoes WHERE pneu_id IN (${pid})`, filialId, filialId),
    movimentacoes: await nSafe(db, `SELECT COUNT(*) as c FROM movimentacoes WHERE pneu_id IN (${pid}) OR veiculo_id IN (${vid})`, filialId, filialId, filialId),
    tokens: await nSafe(db, 'SELECT COUNT(*) as c FROM tokens_acesso_rapido WHERE filial_id = ?', filialId),
    notificacoes: await nSafe(
      db,
      `SELECT COUNT(*) as c FROM notificacoes_whatsapp
       WHERE filial_id = ? OR veiculo_id IN (${vid})`,
      filialId,
      filialId
    ),
    alertas_vaga: await nSafe(db, 'SELECT COUNT(*) as c FROM alertas_posicao_vaga WHERE filial_id = ?', filialId),
  };
}

/** Caminhão compactador: apelido/tipo/layout — a importação da Aparecida veio toda como Truck. */
const SQL_EH_COMPACTADOR = `
  (
    LOWER(COALESCE(apelido, '')) LIKE '%compactador%'
    OR LOWER(COALESCE(tipo, '')) LIKE '%compactador%'
    OR LOWER(COALESCE(layout_pneus, '')) = 'compactador'
  )
`;

export async function listarCompactadoresFilial(db, filialId) {
  return db.prepare(`
    SELECT id, placa, apelido, tipo, layout_pneus
    FROM veiculos
    WHERE filial_id = ?
      AND ${SQL_EH_COMPACTADOR}
    ORDER BY placa
  `).all(filialId);
}

export async function preverLimpezaExcetoCompactadores(db, filialId) {
  const { id, filial } = await filialOu404(db, filialId);
  const compactadores = await listarCompactadoresFilial(db, id);
  const keepSql = `SELECT id FROM veiculos WHERE filial_id = ? AND ${SQL_EH_COMPACTADOR}`;
  const veiculosOutros = await nSafe(
    db,
    `SELECT COUNT(*) as c FROM veiculos WHERE filial_id = ? AND NOT ${SQL_EH_COMPACTADOR}`,
    id
  );
  const pneusManter = await nSafe(
    db,
    `SELECT COUNT(*) as c FROM pneus
     WHERE filial_id = ?
       AND veiculo_id IN (${keepSql})`,
    id,
    id
  );
  const pneusApagar = await nSafe(
    db,
    `SELECT COUNT(*) as c FROM pneus
     WHERE filial_id = ?
       AND (veiculo_id IS NULL OR veiculo_id NOT IN (${keepSql}))`,
    id,
    id
  );
  return {
    filial,
    compactadores,
    manter: {
      veiculos: compactadores.length,
      pneus: pneusManter,
    },
    apagar: {
      veiculos: veiculosOutros,
      pneus: pneusApagar,
    },
  };
}

/**
 * Apaga frota da filial que NÃO é compactador.
 * Mantém cadastro, login, WhatsApp e os compactadores + pneus montados neles.
 */
export async function limparFrotaExcetoCompactadores(db, filialId) {
  const previsao = await preverLimpezaExcetoCompactadores(db, filialId);
  const { filial } = previsao;
  const id = filial.id;

  if (!previsao.compactadores.length) {
    const err = new Error('Nenhum compactador encontrado nesta filial. Nada foi apagado.');
    err.status = 400;
    throw err;
  }

  const keepSql = `SELECT id FROM veiculos WHERE filial_id = ? AND ${SQL_EH_COMPACTADOR}`;

  await db.transaction(async () => {
    await delSafe(db, `
      DELETE FROM tokens_acesso_rapido
      WHERE filial_id = ?
        AND (veiculo_id IS NULL OR veiculo_id NOT IN (${keepSql}))
    `, id, id);

    await delSafe(db, `
      DELETE FROM notificacoes_whatsapp
      WHERE filial_id = ?
        AND (
          veiculo_id IS NULL
          OR veiculo_id NOT IN (${keepSql})
        )
    `, id, id);

    await delSafe(db, `
      DELETE FROM alertas_posicao_vaga
      WHERE filial_id = ?
        AND (veiculo_id IS NULL OR veiculo_id NOT IN (${keepSql}))
    `, id, id);

    await db.prepare(`
      DELETE FROM medicoes
      WHERE pneu_id IN (
        SELECT id FROM pneus
        WHERE filial_id = ?
          AND (veiculo_id IS NULL OR veiculo_id NOT IN (${keepSql}))
      )
    `).run(id, id);

    await db.prepare(`
      DELETE FROM movimentacoes
      WHERE pneu_id IN (
        SELECT id FROM pneus
        WHERE filial_id = ?
          AND (veiculo_id IS NULL OR veiculo_id NOT IN (${keepSql}))
      )
         OR (
           veiculo_id IS NOT NULL
           AND veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ? AND NOT ${SQL_EH_COMPACTADOR})
         )
    `).run(id, id, id);

    await db.prepare(`
      DELETE FROM pneus
      WHERE filial_id = ?
        AND (veiculo_id IS NULL OR veiculo_id NOT IN (${keepSql}))
    `).run(id, id);

    await db.prepare(`
      DELETE FROM veiculos
      WHERE filial_id = ?
        AND NOT ${SQL_EH_COMPACTADOR}
    `).run(id);

    await db.prepare(`
      UPDATE veiculos
      SET tipo = 'Compactador', updated_at = NOW()
      WHERE filial_id = ?
        AND ${SQL_EH_COMPACTADOR}
    `).run(id);
  });

  const compactadoresDepois = await listarCompactadoresFilial(db, id);
  const depois = await contarFrotaFilial(db, id);
  return {
    filial,
    previsao,
    depois,
    compactadores: compactadoresDepois,
  };
}

async function apagarDependenciasOperacionais(db, id) {
  await delSafe(db, `
    DELETE FROM tokens_acesso_rapido WHERE filial_id = ?
  `, id);

  await delSafe(db, `
    DELETE FROM notificacoes_whatsapp
    WHERE filial_id = ?
       OR veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ?)
       OR medicao_id IN (
         SELECT m.id FROM medicoes m
         JOIN pneus p ON p.id = m.pneu_id
         WHERE p.filial_id = ? OR p.veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ?)
       )
  `, id, id, id, id);

  await delSafe(db, `
    DELETE FROM alertas_posicao_vaga WHERE filial_id = ?
  `, id);

  await db.prepare(`
    DELETE FROM medicoes
    WHERE pneu_id IN (
      SELECT id FROM pneus
      WHERE filial_id = ? OR veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ?)
    )
  `).run(id, id);

  await db.prepare(`
    DELETE FROM movimentacoes
    WHERE pneu_id IN (
      SELECT id FROM pneus
      WHERE filial_id = ? OR veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ?)
    )
       OR veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ?)
  `).run(id, id, id);

  await db.prepare(`
    DELETE FROM pneus
    WHERE filial_id = ? OR veiculo_id IN (SELECT id FROM veiculos WHERE filial_id = ?)
  `).run(id, id);

  await db.prepare(`
    DELETE FROM veiculos WHERE filial_id = ?
  `).run(id);
}

async function filialOu404(db, filialId) {
  const id = Number(filialId);
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('filial_id inválido');
    err.status = 400;
    throw err;
  }
  const filial = await db.prepare(`
    SELECT id, nome, codigo FROM filiais WHERE id = ?
  `).get(id);
  if (!filial) {
    const err = new Error('Filial não encontrada');
    err.status = 404;
    throw err;
  }
  return { id, filial };
}

export async function limparFrotaFilial(db, filialId) {
  const { id, filial } = await filialOu404(db, filialId);
  const antes = await contarFrotaFilial(db, id);

  await db.transaction(async () => {
    await apagarDependenciasOperacionais(db, id);
  });

  const depois = await contarFrotaFilial(db, id);
  return { filial, antes, depois };
}

/** Apaga a filial e tudo que pertence a ela — sem deixar cadastro órfão. */
export async function excluirFilialCompleta(db, filialId) {
  const { id, filial } = await filialOu404(db, filialId);
  const antes = await contarFrotaFilial(db, id);
  const usuarios = await nSafe(
    db,
    `SELECT COUNT(*) as c FROM usuarios WHERE filial_id = ? AND papel NOT IN ('admin', 'presidente')`,
    id
  );

  await db.transaction(async () => {
    await apagarDependenciasOperacionais(db, id);
    await delSafe(db, `
      DELETE FROM whatsapp_sessoes WHERE filial_id = ?
    `, id);
    await delSafe(db, `
      DELETE FROM alerta_destinatarios WHERE filial_id = ?
    `, id);
    await delSafe(db, `
      DELETE FROM usuarios WHERE filial_id = ? AND papel NOT IN ('admin', 'presidente')
    `, id);
    const result = await db.prepare(`DELETE FROM filiais WHERE id = ?`).run(id);
    if (!result.changes) {
      const err = new Error('Filial não encontrada');
      err.status = 404;
      throw err;
    }
  });

  return {
    filial,
    removidos: { ...antes, usuarios },
  };
}

/** Apaga um caminhão da unidade e os pneus ainda ligados a ele (medições e histórico inclusive). */
export async function excluirVeiculoCompleto(db, filialId, veiculoId) {
  const fid = Number(filialId);
  const vid = Number(veiculoId);
  if (!fid || !vid) {
    const err = new Error('Filial e veículo são obrigatórios');
    err.status = 400;
    throw err;
  }

  const veiculo = await db.prepare(`
    SELECT id, placa, apelido, ativo, filial_id
    FROM veiculos
    WHERE id = ? AND filial_id = ?
  `).get(vid, fid);
  if (!veiculo) {
    const err = new Error('Veículo não encontrado nesta unidade');
    err.status = 404;
    throw err;
  }

  const pneus = await db.prepare(`
    SELECT id FROM pneus WHERE veiculo_id = ?
  `).all(vid);
  const nPneus = pneus.length;

  await db.transaction(async () => {
    await delSafe(db, `DELETE FROM tokens_acesso_rapido WHERE veiculo_id = ?`, vid);
    await delSafe(db, `
      DELETE FROM notificacoes_whatsapp
      WHERE veiculo_id = ?
         OR medicao_id IN (
           SELECT m.id FROM medicoes m
           JOIN pneus p ON p.id = m.pneu_id
           WHERE p.veiculo_id = ?
         )
    `, vid, vid);
    await delSafe(db, `DELETE FROM alertas_posicao_vaga WHERE veiculo_id = ?`, vid);
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = NULL,
        posicao = NULL,
        status_pneu = CASE WHEN status_pneu = 'montado' THEN 'estoque' ELSE status_pneu END,
        data_instalacao = CASE WHEN status_pneu = 'montado' THEN NULL ELSE data_instalacao END
      WHERE veiculo_id = ?
    `).run(vid);
    const result = await db.prepare(`
      DELETE FROM veiculos WHERE id = ? AND filial_id = ?
    `).run(vid, fid);
    if (!result.changes) {
      const err = new Error('Não foi possível excluir o veículo');
      err.status = 409;
      throw err;
    }
  });

  return {
    placa: veiculo.placa,
    apelido: veiculo.apelido,
    pneus_apagados: 0,
    pneus_desvinculados: nPneus,
  };
}

const STATUS_PNEU_EXCLUIVEL = new Set(['estoque', 'descarte']);
const NOME_SQL = /^[a-z_][a-z0-9_]*$/;
/** Filhos cujo histórico pertence ao registro apagado. O restante anulável só perde o vínculo. */
const FILHOS_APAGADOS = {
  pneus: new Set(['medicoes', 'movimentacoes', 'tokens_acesso_rapido']),
  medicoes: new Set(['notificacoes_whatsapp']),
};

function erroExclusao(mensagem, status = 409) {
  const err = new Error(mensagem);
  err.status = status;
  return err;
}

function nomeSql(valor, rotulo) {
  const nome = String(valor || '');
  if (!NOME_SQL.test(nome)) {
    throw erroExclusao(`Nome de ${rotulo} inesperado no catálogo do banco. Exclusão interrompida.`);
  }
  return nome;
}

async function fksPara(db, tabela) {
  return db.prepare(`
    SELECT t.relname AS tabela,
           a.attname AS coluna,
           c.confdeltype::text AS ao_apagar,
           (NOT a.attnotnull) AS anulavel,
           cardinality(c.conkey) AS ncolunas
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace nt ON nt.oid = t.relnamespace
    JOIN pg_class f ON f.oid = c.confrelid
    JOIN pg_namespace nf ON nf.oid = f.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND nf.nspname = 'public'
      AND nt.nspname = 'public'
      AND f.relname = ?
  `).all(tabela);
}

/**
 * Monta a ordem de limpeza a partir do catálogo do Postgres.
 * Tabela desconhecida que impeça o DELETE interrompe antes de apagar o pneu.
 */
async function planoLimpeza(db, tabelaPai, wherePai, caminho) {
  if (caminho.includes(tabelaPai)) return [];
  const fks = await fksPara(db, tabelaPai);
  const passos = [];
  for (const fk of fks) {
    const tabela = nomeSql(fk.tabela, 'tabela');
    const coluna = nomeSql(fk.coluna, 'coluna');
    if (Number(fk.ncolunas) !== 1) {
      throw erroExclusao(
        `A tabela ${tabela} referencia ${tabelaPai} com mais de uma coluna. Exclusão interrompida para proteger o banco.`
      );
    }
    const whereFilho = `${coluna} IN (SELECT id FROM ${nomeSql(tabelaPai, 'tabela')} WHERE ${wherePai})`;
    const apagar = FILHOS_APAGADOS[tabelaPai]?.has(tabela) || fk.ao_apagar === 'c';
    if (apagar) {
      passos.push(...await planoLimpeza(db, tabela, whereFilho, [...caminho, tabelaPai]));
      passos.push(`DELETE FROM ${tabela} WHERE ${whereFilho}`);
      continue;
    }
    if (fk.anulavel || fk.ao_apagar === 'n') {
      passos.push(`UPDATE ${tabela} SET ${coluna} = NULL WHERE ${whereFilho}`);
      continue;
    }
    throw erroExclusao(
      `A tabela ${tabela}.${coluna} impede excluir ${tabelaPai}. Nada foi apagado.`
    );
  }
  return passos;
}

/** Admin: apaga pneu somente se estiver em estoque ou descarte, sem veículo. */
export async function excluirPneuEstoqueOuDescarte(db, filialId, pneuId) {
  const fid = Number(filialId);
  const pid = Number(pneuId);
  if (!fid || !pid) {
    const err = new Error('Filial e pneu são obrigatórios');
    err.status = 400;
    throw err;
  }

  const pneu = await db.prepare(`
    SELECT id, numero_fogo, status_pneu, filial_id, veiculo_id
    FROM pneus
    WHERE id = ? AND filial_id = ?
  `).get(pid, fid);
  if (!pneu) {
    const err = new Error('Pneu não encontrado nesta unidade');
    err.status = 404;
    throw err;
  }
  if (pneu.veiculo_id || !STATUS_PNEU_EXCLUIVEL.has(pneu.status_pneu)) {
    const err = new Error('Só é possível excluir pneu em estoque ou descarte');
    err.status = 409;
    throw err;
  }

  await db.transaction(async () => {
    const passos = await planoLimpeza(db, 'pneus', 'id = ?', []);
    for (const sql of passos) {
      await db.prepare(sql).run(pid);
    }
    await delSafe(db, `DELETE FROM tokens_acesso_rapido WHERE pneu_id = ?`, pid);
    const result = await db.prepare(`
      DELETE FROM pneus
      WHERE id = ? AND filial_id = ?
        AND veiculo_id IS NULL
        AND status_pneu IN ('estoque', 'descarte')
    `).run(pid, fid);
    if (!result.changes) {
      const err = new Error('Não foi possível excluir o pneu');
      err.status = 409;
      throw err;
    }
  });

  return {
    numero_fogo: pneu.numero_fogo,
    status_pneu: pneu.status_pneu,
  };
}
