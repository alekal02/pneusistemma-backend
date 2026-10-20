/**
 * Migração da constraint usuarios.papel e ativação do login presidente.
 *
 * Não roda no init do servidor. O padrão é só leitura.
 * Recusa host que não seja localhost, salvo PNEU_MIGRACAO_PAPEL_CONFIRMADA=sim.
 *
 *   node scripts/migrar-papel-presidente.mjs
 *   node scripts/migrar-papel-presidente.mjs --aplicar
 *   node scripts/migrar-papel-presidente.mjs --ativar
 *
 * --aplicar só amplia o CHECK (admin, gerente, filial, presidente).
 * --ativar só troca o papel do id 34 / login presidente, se ele ainda for
 * admin, ativo e sem filial. Não mexe em senha, cargo, último login nem na frota.
 */
import pg from 'pg';

export const CONSTRAINT_PAPEL = 'usuarios_papel_check';
export const PAPEIS_PERMITIDOS = ['admin', 'gerente', 'filial', 'presidente'];

const PRESIDENTE_ID = 34;
const PRESIDENTE_LOGIN = 'presidente';

export function assertHostPermitido(connectionString) {
  const host = new URL(connectionString).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  const confirmado = process.env.PNEU_MIGRACAO_PAPEL_CONFIRMADA === 'sim';
  if (!local && !confirmado) {
    throw new Error(
      `Migração recusada para o host "${host}". `
      + 'Em produção, revise o script e defina PNEU_MIGRACAO_PAPEL_CONFIRMADA=sim antes de executar.'
    );
  }
  return { host, local, confirmado };
}

function definicaoEsperada(def) {
  const texto = String(def || '');
  return PAPEIS_PERMITIDOS.every((papel) => texto.includes(`'${papel}'`));
}

export async function inspecionarPapel(client) {
  const constraints = await client.query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def, c.convalidated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'usuarios' AND n.nspname = 'public' AND c.contype = 'c'
    ORDER BY c.conname
  `);
  const papeis = await client.query(`
    SELECT papel, COUNT(*)::int AS n
    FROM usuarios
    GROUP BY papel
    ORDER BY papel
  `);
  const alvo = await client.query(`
    SELECT id, login, papel, cargo, ativo, filial_id,
           (senha_hash IS NOT NULL AND length(senha_hash) > 0) AS tem_senha,
           ultimo_login, created_at
    FROM usuarios
    WHERE id = $1 OR lower(login) = $2
    ORDER BY id
  `, [PRESIDENTE_ID, PRESIDENTE_LOGIN]);
  const contagens = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pneus) AS pneus,
      (SELECT COUNT(*)::int FROM medicoes) AS medicoes,
      (SELECT COUNT(*)::int FROM movimentacoes) AS movimentacoes
  `);
  return {
    constraints: constraints.rows,
    papeis: papeis.rows,
    alvo: alvo.rows,
    contagens: contagens.rows[0],
  };
}

async function papeisForaDoConjunto(client) {
  const rows = await client.query(`
    SELECT DISTINCT papel
    FROM usuarios
    WHERE papel <> ALL ($1::text[])
  `, [PAPEIS_PERMITIDOS]);
  return rows.rows.map((row) => row.papel);
}

export async function aplicarConstraintPapel(client) {
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE usuarios IN SHARE ROW EXCLUSIVE MODE');
    const fora = await papeisForaDoConjunto(client);
    if (fora.length) {
      throw new Error(`Papéis inesperados na tabela usuarios: ${fora.join(', ')}. Nada foi alterado.`);
    }
    const atual = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = $1
    `, [CONSTRAINT_PAPEL]);
    if (!atual.rows.length) {
      throw new Error(`Constraint ${CONSTRAINT_PAPEL} não encontrada. Nada foi alterado.`);
    }
    const antes = atual.rows[0].def;
    if (!['admin', 'gerente', 'filial'].every((papel) => antes.includes(`'${papel}'`))) {
      throw new Error('A constraint atual não é a esperada. Nada foi alterado.');
    }
    let alterada = false;
    if (!definicaoEsperada(antes)) {
      await client.query(`ALTER TABLE usuarios DROP CONSTRAINT ${CONSTRAINT_PAPEL}`);
      await client.query(`
        ALTER TABLE usuarios
          ADD CONSTRAINT ${CONSTRAINT_PAPEL}
          CHECK (papel IN ('admin', 'gerente', 'filial', 'presidente'))
      `);
      alterada = true;
    }
    const depois = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def, convalidated
      FROM pg_constraint
      WHERE conname = $1
    `, [CONSTRAINT_PAPEL]);
    if (!definicaoEsperada(depois.rows[0]?.def) || depois.rows[0]?.convalidated !== true) {
      throw new Error('A constraint nova não ficou válida. A transação será desfeita.');
    }
    await client.query('COMMIT');
    return { alterada, antes, depois: depois.rows[0].def };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function ativarPresidente(client, { id = PRESIDENTE_ID, login = PRESIDENTE_LOGIN } = {}) {
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE usuarios IN SHARE ROW EXCLUSIVE MODE');
    const check = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = $1
    `, [CONSTRAINT_PAPEL]);
    if (!definicaoEsperada(check.rows[0]?.def)) {
      throw new Error('A constraint ainda não aceita presidente. Rode --aplicar antes. Nada foi alterado.');
    }
    const antes = await client.query(`
      SELECT id, login, papel, cargo, ativo, filial_id, senha_hash, ultimo_login, created_at
      FROM usuarios
      WHERE id = $1
      FOR UPDATE
    `, [id]);
    if (antes.rows.length !== 1) {
      throw new Error(`Usuário id ${id} não encontrado. Nada foi alterado.`);
    }
    const row = antes.rows[0];
    if (String(row.login).toLowerCase() !== String(login).toLowerCase()) {
      throw new Error(`O id ${id} não é o login ${login}. Nada foi alterado.`);
    }
    if (Number(row.ativo) !== 1) {
      throw new Error('O login presidente não está ativo. Nada foi alterado.');
    }
    if (row.filial_id != null) {
      throw new Error('O login presidente está vinculado a uma filial. Nada foi alterado.');
    }
    if (!row.senha_hash) {
      throw new Error('O login presidente está sem senha. Nada foi alterado.');
    }
    if (row.papel === 'presidente') {
      await client.query('COMMIT');
      return { jaAtivo: true, id: row.id, login: row.login };
    }
    if (row.papel !== 'admin') {
      throw new Error(`Papel atual é "${row.papel}", esperado "admin". Nada foi alterado.`);
    }
    const upd = await client.query(`
      UPDATE usuarios
      SET papel = 'presidente', updated_at = NOW()
      WHERE id = $1
        AND lower(login) = lower($2)
        AND papel = 'admin'
        AND ativo = 1
        AND filial_id IS NULL
        AND senha_hash IS NOT NULL
      RETURNING id, login, papel, cargo, ativo, filial_id, senha_hash, ultimo_login, created_at
    `, [id, login]);
    if (upd.rowCount !== 1) {
      throw new Error('A ativação não afetou exatamente uma linha. A transação será desfeita.');
    }
    const depois = upd.rows[0];
    if (depois.senha_hash !== row.senha_hash) {
      throw new Error('A senha mudaria. A transação será desfeita.');
    }
    if (String(depois.cargo ?? '') !== String(row.cargo ?? '')) {
      throw new Error('O cargo mudaria. A transação será desfeita.');
    }
    const mesmoInstante = (a, b) => {
      if (a == null && b == null) return true;
      return new Date(a).getTime() === new Date(b).getTime();
    };
    if (!mesmoInstante(depois.ultimo_login, row.ultimo_login) || !mesmoInstante(depois.created_at, row.created_at)) {
      throw new Error('O histórico do login mudaria. A transação será desfeita.');
    }
    if (depois.filial_id != null || depois.papel !== 'presidente' || Number(depois.ativo) !== 1) {
      throw new Error('O estado final do presidente não confere. A transação será desfeita.');
    }
    await client.query('COMMIT');
    return {
      jaAtivo: false,
      id: depois.id,
      login: depois.login,
      papel: depois.papel,
      filial_id: depois.filial_id,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('Defina DATABASE_URL');
  const acesso = assertHostPermitido(connectionString);
  const aplicar = process.argv.includes('--aplicar');
  const ativar = process.argv.includes('--ativar');
  const pool = new pg.Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'false' ? false : undefined,
  });
  const client = await pool.connect();
  try {
    const antes = await inspecionarPapel(client);
    console.log(JSON.stringify({
      modo: aplicar || ativar ? 'execucao' : 'leitura',
      host: acesso.host,
      local: acesso.local,
      antes: {
        constraints: antes.constraints,
        papeis: antes.papeis,
        alvo: antes.alvo,
        contagens: antes.contagens,
      },
    }, null, 2));
    if (!aplicar && !ativar) {
      console.log('Leitura apenas. Use --aplicar para a constraint e --ativar para o login presidente.');
      return;
    }
    if (aplicar) {
      const resultado = await aplicarConstraintPapel(client);
      console.log(JSON.stringify({ constraint: resultado.alterada ? 'atualizada' : 'ja_estava_pronta', depois: resultado.depois }, null, 2));
    }
    if (ativar) {
      const resultado = await ativarPresidente(client);
      console.log(JSON.stringify({ ativacao: resultado }, null, 2));
    }
    const depois = await inspecionarPapel(client);
    if (depois.contagens.pneus !== antes.contagens.pneus
      || depois.contagens.medicoes !== antes.contagens.medicoes
      || depois.contagens.movimentacoes !== antes.contagens.movimentacoes) {
      throw new Error('As contagens de pneus, medições ou movimentações mudaram.');
    }
    console.log(JSON.stringify({ contagens: depois.contagens, alvo: depois.alvo }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const executadoDireto = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('scripts/migrar-papel-presidente.mjs');
if (executadoDireto) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
