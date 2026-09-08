/**
 * Zera frota operacional de UMA filial: veículos, pneus, medições, movimentações.
 * Mantém o cadastro da filial, logins e configuração WhatsApp.
 */
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
    return await db.prepare(sql).run(...p);
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
    `SELECT COUNT(*) as c FROM usuarios WHERE filial_id = ? AND papel <> 'admin'`,
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
      DELETE FROM usuarios WHERE filial_id = ? AND papel <> 'admin'
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
