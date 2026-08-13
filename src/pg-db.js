/**
 * Camada PostgreSQL com API compatível (prepare/get/all/run/exec) — tudo async.
 */
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { translateSql, ensureReturningId, ensureIgnoreConflict } from './pg-sql.js';

const { Pool } = pg;
const txStore = new AsyncLocalStorage();

// node-pg devolve BIGINT/NUMERIC como string; o código do projeto (herdado do
// SQLite) compara ids e soma contagens como número.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

let pool = null;

export function createPool(connectionString) {
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    // Render / SSL
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : (process.env.NODE_ENV === 'production' || /render\.com|sslmode=require/i.test(connectionString || '')
        ? { rejectUnauthorized: false }
        : false),
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  });
  pool.on('error', (err) => {
    console.error('[pg] pool error', err);
  });
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('Pool PostgreSQL não inicializado');
  return pool;
}

async function query(sql, params = []) {
  const client = txStore.getStore()?.client;
  if (client) return client.query(sql, params);
  return getPool().query(sql, params);
}

class Statement {
  constructor(originalSql) {
    this.originalSql = originalSql;
    let translated = translateSql(originalSql);
    translated = ensureIgnoreConflict(originalSql, translated);
    this.sql = translated;
  }

  async get(...params) {
    const flat = flatten(params);
    const res = await query(this.sql, flat);
    return res.rows[0];
  }

  async all(...params) {
    const flat = flatten(params);
    const res = await query(this.sql, flat);
    return res.rows;
  }

  async run(...params) {
    const flat = flatten(params);
    let sql = this.sql;
    const isInsert = /^\s*INSERT\s+/i.test(sql);
    if (isInsert) sql = ensureReturningId(sql);
    const res = await query(sql, flat);
    const id = res.rows?.[0]?.id;
    return {
      lastInsertRowid: id != null ? Number(id) : 0,
      changes: res.rowCount || 0,
      rows: res.rows,
    };
  }
}

function flatten(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

export const db = {
  prepare(sql) {
    return new Statement(sql);
  },

  async exec(sql) {
    const parts = String(sql)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const part of parts) {
      const upper = part.toUpperCase();
      if (upper === 'BEGIN') {
        if (txStore.getStore()?.client) continue;
        const client = await getPool().connect();
        await client.query('BEGIN');
        // Nota: BEGIN via exec só funciona se o restante da tx rodar no mesmo async context
        // Preferir db.transaction(). Aqui armazenamos em ALS do caller se já estiver dentro.
        throw new Error('Use await db.transaction(async (tx) => { ... }) em vez de BEGIN/COMMIT');
      }
      if (upper === 'COMMIT' || upper === 'ROLLBACK') {
        throw new Error('Use await db.transaction(async (tx) => { ... }) em vez de BEGIN/COMMIT');
      }
      await query(translateSql(part));
    }
  },

  /**
   * Transação com o mesmo client (substitui BEGIN/COMMIT/ROLLBACK)
   */
  async transaction(fn) {
    const existing = txStore.getStore();
    if (existing?.client) {
      return fn(db);
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await txStore.run({ client }, async () => fn(db));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  },
};

export function getDb() {
  return db;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
