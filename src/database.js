/**
 * PostgreSQL — schema, seed e init
 */
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { createPool, db, closePool } from './pg-db.js';
import { corrigirEncodingBanco } from './fix-encoding.js';
import { backfillTipoCodigoVeiculos, seedEquipamentoTipos } from './equipamento-tipos.js';
import { limparCacheColunas } from './schema-colunas.js';

let ready = false;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS filiais (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  codigo TEXT NOT NULL UNIQUE,
  contrato TEXT,
  ativo INTEGER DEFAULT 1,
  whatsapp TEXT,
  whatsapp_grupo TEXT,
  whatsapp_alerta TEXT,
  wuzapi_token TEXT,
  dia_medicao INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bancos já existentes mantêm a constraint antiga até scripts/migrar-papel-presidente.mjs.
-- Este CREATE não altera a constraint de uma tabela que já existe. O init não promove o login.
CREATE TABLE IF NOT EXISTS usuarios (
  id BIGSERIAL PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'gerente', 'filial', 'presidente')),
  filial_id BIGINT REFERENCES filiais(id) ON DELETE SET NULL,
  ativo INTEGER DEFAULT 1,
  whatsapp TEXT,
  cargo TEXT DEFAULT 'funcionario',
  ultimo_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equipamento_tipos (
  codigo TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  familia TEXT NOT NULL,
  unidade_uso TEXT NOT NULL DEFAULT 'km',
  layout_padrao TEXT NOT NULL,
  layouts_permitidos JSONB NOT NULL DEFAULT '[]'::jsonb,
  perfil_medicao TEXT NOT NULL DEFAULT 'caminhao',
  permite_recap INTEGER NOT NULL DEFAULT 1,
  legado INTEGER NOT NULL DEFAULT 0,
  regras JSONB DEFAULT '{}'::jsonb,
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS veiculos (
  id BIGSERIAL PRIMARY KEY,
  placa TEXT NOT NULL UNIQUE,
  apelido TEXT,
  tipo TEXT NOT NULL DEFAULT 'Outro',
  marca TEXT,
  modelo TEXT,
  ano INTEGER,
  km_atual INTEGER DEFAULT 0,
  hr_atual DOUBLE PRECISION DEFAULT 0,
  ativo INTEGER DEFAULT 1,
  observacoes TEXT,
  filial_id BIGINT REFERENCES filiais(id) ON DELETE RESTRICT,
  layout_pneus TEXT DEFAULT 'truck_10',
  dia_medicao INTEGER,
  cadastro_completo INTEGER DEFAULT 1,
  tipo_codigo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pneus (
  id BIGSERIAL PRIMARY KEY,
  veiculo_id BIGINT REFERENCES veiculos(id) ON DELETE SET NULL,
  posicao TEXT,
  filial_id BIGINT REFERENCES filiais(id) ON DELETE RESTRICT,
  marca TEXT,
  modelo TEXT,
  medida TEXT,
  dot TEXT,
  numero_fogo TEXT,
  tipo_pneu TEXT DEFAULT 'misto',
  condicao TEXT DEFAULT 'novo',
  vida_recap INTEGER DEFAULT 0,
  sulco_inicial_mm DOUBLE PRECISION,
  status_pneu TEXT DEFAULT 'estoque',
  data_instalacao TEXT,
  km_instalacao INTEGER DEFAULT 0,
  ativo INTEGER DEFAULT 1,
  observacoes TEXT,
  custo DOUBLE PRECISION,
  nota_fiscal TEXT,
  data_alerta_monitorar TEXT,
  cadastro_completo INTEGER DEFAULT 1,
  recap_fornecedor TEXT,
  recap_enviado_em TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (veiculo_id, posicao)
);

CREATE TABLE IF NOT EXISTS medicoes (
  id BIGSERIAL PRIMARY KEY,
  pneu_id BIGINT NOT NULL REFERENCES pneus(id) ON DELETE RESTRICT,
  data_medicao TEXT NOT NULL DEFAULT (CURRENT_DATE::TEXT),
  km_veiculo INTEGER,
  hr_veiculo DOUBLE PRECISION,
  sulco_externo DOUBLE PRECISION,
  sulco_central DOUBLE PRECISION,
  sulco_interno DOUBLE PRECISION,
  sulco_auxiliar DOUBLE PRECISION,
  pressao_psi DOUBLE PRECISION,
  responsavel TEXT,
  observacoes TEXT,
  marcacao_json TEXT,
  diagnostico TEXT,
  acao_sugerida TEXT,
  desgaste_mm_km DOUBLE PRECISION,
  desgaste_mm_hora DOUBLE PRECISION,
  sulco_mm DOUBLE PRECISION,
  inspecao_danos TEXT,
  veiculo_placa TEXT,
  veiculo_id BIGINT,
  veiculo_apelido TEXT,
  posicao TEXT,
  ciclo INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  pneu_id BIGINT NOT NULL REFERENCES pneus(id) ON DELETE RESTRICT,
  veiculo_id BIGINT REFERENCES veiculos(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,
  data_evento TEXT NOT NULL DEFAULT (CURRENT_DATE::TEXT),
  km_veiculo INTEGER,
  hr_veiculo DOUBLE PRECISION,
  posicao TEXT,
  sulco_mm DOUBLE PRECISION,
  detalhes TEXT,
  posicao_anterior TEXT,
  km_rodado INTEGER,
  hr_rodado DOUBLE PRECISION,
  veiculo_placa TEXT,
  veiculo_apelido TEXT,
  ciclo INTEGER,
  usuario TEXT,
  custo DOUBLE PRECISION,
  sulco_antes DOUBLE PRECISION,
  sulco_depois DOUBLE PRECISION,
  motivo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notificacoes_whatsapp (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('alerta_critico', 'alerta_desgaste', 'alerta_posicao', 'link_veiculo', 'menu', 'relatorio_semanal')),
  destinatario_whatsapp TEXT NOT NULL,
  veiculo_id BIGINT REFERENCES veiculos(id),
  medicao_id BIGINT REFERENCES medicoes(id),
  filial_id BIGINT,
  mensagem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado', 'erro', 'entregue')),
  resposta_api TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens_acesso_rapido (
  id BIGSERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  veiculo_id BIGINT REFERENCES veiculos(id),
  pneu_id BIGINT REFERENCES pneus(id),
  filial_id BIGINT NOT NULL REFERENCES filiais(id),
  tipo TEXT NOT NULL DEFAULT 'medir',
  whatsapp_origem TEXT,
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerta_destinatarios (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  ativo INTEGER DEFAULT 1,
  escopo TEXT NOT NULL DEFAULT 'todas' CHECK (escopo IN ('todas', 'filial')),
  filial_id BIGINT REFERENCES filiais(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pneus_veiculo ON pneus(veiculo_id);
CREATE INDEX IF NOT EXISTS idx_pneus_filial ON pneus(filial_id);
CREATE INDEX IF NOT EXISTS idx_medicoes_pneu ON medicoes(pneu_id);
CREATE INDEX IF NOT EXISTS idx_medicoes_pneu_recente ON medicoes(pneu_id, data_medicao DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_medicoes_data ON medicoes(data_medicao);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu ON movimentacoes(pneu_id);
CREATE INDEX IF NOT EXISTS idx_veiculos_filial ON veiculos(filial_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_filial ON usuarios(filial_id);
CREATE INDEX IF NOT EXISTS idx_notif_whatsapp_medicao ON notificacoes_whatsapp(medicao_id);
CREATE INDEX IF NOT EXISTS idx_tokens_acesso_token ON tokens_acesso_rapido(token);

CREATE TABLE IF NOT EXISTS whatsapp_sessoes (
  id BIGSERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,
  filial_id BIGINT NOT NULL,
  chat_jid TEXT,
  telefone TEXT,
  fluxo TEXT NOT NULL,
  passo TEXT NOT NULL,
  dados JSONB DEFAULT '{}'::jsonb,
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  expira_em TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_sessoes_expira ON whatsapp_sessoes(expira_em);
`;

async function restringirExclusaoHistoricoPneu() {
  const fks = await db.prepare(`
    SELECT t.relname AS tabela, c.conname, c.confdeltype::text AS confdeltype
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE f.relname = 'pneus'
      AND c.contype = 'f'
      AND a.attname = 'pneu_id'
      AND t.relname IN ('medicoes', 'movimentacoes')
  `).all();
  for (const fk of fks) {
    if (fk.confdeltype === 'c') {
      await db.exec(`ALTER TABLE ${fk.tabela} DROP CONSTRAINT ${fk.conname}`);
      await db.exec(
        `ALTER TABLE ${fk.tabela} ADD CONSTRAINT ${fk.conname} FOREIGN KEY (pneu_id) REFERENCES pneus(id) ON DELETE RESTRICT`
      );
    }
  }
}

async function ensureColumn(table, column, ddl) {
  // db.exec quebra o SQL por ';', então blocos DO $$ ... $$ não podem ser usados aqui.
  await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${ddl}`);
}

/** Tipos gravados pelo código e já presentes em produção (incluindo menu). */
export const TIPOS_NOTIFICACAO_WHATSAPP = [
  'alerta_critico',
  'alerta_desgaste',
  'alerta_posicao',
  'link_veiculo',
  'menu',
  'relatorio_semanal',
];

export function clausulaTiposNotificacao(extras = []) {
  const tipos = [...new Set(
    [...TIPOS_NOTIFICACAO_WHATSAPP, ...extras]
      .map((t) => String(t || '').trim())
      .filter((t) => /^[a-z0-9_]+$/i.test(t)),
  )].sort();
  return tipos.map((t) => `'${t}'`).join(', ');
}

/**
 * Recria o check numa transação. Inclui os tipos já gravados.
 * Se a troca falhar, o rollback devolve a constraint anterior. Nenhuma linha é apagada.
 */
async function ensureNotificacoesTipoRelatorio() {
  const rows = await db.prepare(`SELECT DISTINCT tipo FROM notificacoes_whatsapp`).all();
  const existentes = rows.map((r) => String(r.tipo || '').trim()).filter(Boolean);
  const invalidos = existentes.filter((t) => !/^[a-z0-9_]+$/i.test(t));
  if (invalidos.length) {
    console.warn('[database] constraint tipo notificacoes não alterada: tipo fora do padrão seguro');
    return;
  }
  const lista = clausulaTiposNotificacao(existentes);
  await db.transaction(async () => {
    await db.exec(`ALTER TABLE notificacoes_whatsapp DROP CONSTRAINT IF EXISTS notificacoes_whatsapp_tipo_check`);
    await db.exec(`
      ALTER TABLE notificacoes_whatsapp
        ADD CONSTRAINT notificacoes_whatsapp_tipo_check
        CHECK (tipo IN (${lista}))
    `);
  });
}

async function seedConfigs() {
  const insertIgnore = db.prepare(`
    INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
    ON CONFLICT (chave) DO NOTHING
  `);
  await insertIgnore.run('sulco_critico_mm', String(config.sulcoMinimo));
  await insertIgnore.run('sulco_alerta_mm', String(config.sulcoAlerta));
  await insertIgnore.run('sulco_recap_mm', '3');
  await insertIgnore.run('sulco_novo_mm', '14');
  await insertIgnore.run('max_recaps', '6');
  await insertIgnore.run('prazo_recap_dias', '15');
  await insertIgnore.run('diagnostico_tolerancia_mm', '1');
  await insertIgnore.run('trator_sulco_critico_mm', '10');
  await insertIgnore.run('trator_sulco_alerta_mm', '15');
  await insertIgnore.run('trator_sulco_novo_mm', '25');

  const migrou = await db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`).get('limites_faixas_v3');
  if (!migrou) {
    const upsert = db.prepare(`
      INSERT INTO configuracoes (chave, valor, updated_at)
      VALUES (?, ?, NOW())
      ON CONFLICT (chave) DO UPDATE SET
        valor = EXCLUDED.valor,
        updated_at = EXCLUDED.updated_at
    `);
    await upsert.run('sulco_critico_mm', '3');
    await upsert.run('sulco_recap_mm', '3');
    await upsert.run('sulco_alerta_mm', '8');
    await upsert.run('prazo_recap_dias', '15');
    await upsert.run('acao_troca_label', 'Trocar');
    await upsert.run('acao_troca_instrucao', 'Crítico — retirar e trocar o pneu');
    await upsert.run('acao_monitorar_label', 'Monitorar');
    await upsert.run(
      'acao_monitorar_instrucao',
      'Programar substituição — iniciar processo de recap em até 15 dias'
    );
    await upsert.run('acao_rodizio_label', 'Mudar posição');
    await upsert.run(
      'acao_rodizio_instrucao',
      'Mudar de posição no caminhão para equalizar o desgaste (não faz balanceamento no eixo traseiro)'
    );
    await upsert.run('limites_faixas_v2', '1');
    await upsert.run('limites_faixas_v3', '1');
    console.log('[migrate] Limites v3 (PG): <3 crítico · ≤8 monitorar · >8 OK');
  }
}

async function seedAuthAndFilial() {
  let matriz = await db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get();
  if (!matriz) {
    const r = await db.prepare(`
      INSERT INTO filiais (nome, codigo, contrato)
      VALUES ('Matriz', 'MATRIZ', 'Dados migrados')
      RETURNING id
    `).run();
    matriz = { id: r.lastInsertRowid };
  }

  await db.prepare(`UPDATE veiculos SET filial_id = ? WHERE filial_id IS NULL`).run(matriz.id);

  const admin = await db.prepare(`SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1`).get();
  if (!admin) {
    const hash = bcrypt.hashSync(config.adminPassword, 10);
    await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
      VALUES (?, ?, 'admin', 'admin', NULL, 1)
    `).run(config.adminUser, hash);
    console.log(`[seed] Admin criado: ${config.adminUser}`);
  } else {
    await db.prepare(`
      UPDATE usuarios SET cargo = COALESCE(NULLIF(cargo, ''), 'admin')
      WHERE id = ? AND (cargo IS NULL OR cargo = '' OR cargo = 'funcionario')
    `).run(admin.id);
  }

  const userMatriz = await db.prepare(`
    SELECT id FROM usuarios WHERE filial_id = ? AND papel = 'filial' AND login = 'matriz' LIMIT 1
  `).get(matriz.id);
  if (!userMatriz) {
    const hash = bcrypt.hashSync('matriz123', 10);
    await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
      VALUES ('matriz', ?, 'filial', 'funcionario', ?, 1)
    `).run(hash, matriz.id);
    console.log('[seed] Usuário filial Matriz: matriz / matriz123');
  }

  const compras = await db.prepare(`SELECT id FROM usuarios WHERE login = 'compras' LIMIT 1`).get();
  if (!compras) {
    const hash = bcrypt.hashSync('compras123', 10);
    await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, whatsapp, filial_id, ativo)
      VALUES ('compras', ?, 'gerente', 'gerente_compras', '5511988888888', NULL, 1)
    `).run(hash);
    console.log('[seed] Gerente compras: compras / compras123');
  }

  const gerenteMatriz = await db.prepare(`SELECT id FROM usuarios WHERE login = 'gerente_matriz' LIMIT 1`).get();
  if (!gerenteMatriz) {
    const hash = bcrypt.hashSync('gerente123', 10);
    await db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, whatsapp, filial_id, ativo)
      VALUES ('gerente_matriz', ?, 'gerente', 'gerente_filial', '5511977777777', ?, 1)
    `).run(hash, matriz.id);
    console.log('[seed] Gerente unidade Matriz: gerente_matriz / gerente123');
  }

  await db.prepare(`
    UPDATE usuarios SET cargo = 'funcionario' WHERE cargo IS NULL OR cargo = ''
  `).run();

  return matriz.id;
}

export async function initDatabase() {
  if (ready) return getDb();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL não configurada. Defina a connection string do PostgreSQL.');
  }

  createPool(config.databaseUrl);
  await db.exec(SCHEMA_SQL);

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_dest_whatsapp ON alerta_destinatarios(whatsapp);
  `);
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pneus_fogo_filial
      ON pneus(filial_id, numero_fogo)
      WHERE numero_fogo IS NOT NULL AND numero_fogo != '' AND ativo = 1;
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_medicoes_pneu_recente
      ON medicoes(pneu_id, data_medicao DESC, id DESC);
  `);

  // Colunas extras (idempotente)
  await ensureColumn('notificacoes_whatsapp', 'filial_id', 'BIGINT');
  await ensureNotificacoesTipoRelatorio();
  await ensureColumn('pneus', 'recap_fornecedor', 'TEXT');
  await ensureColumn('pneus', 'recap_enviado_em', 'TEXT');
  await ensureColumn('pneus', 'tratamento_descarte', 'TEXT');
  await ensureColumn('pneus', 'tratamento_descarte_obs', 'TEXT');
  await ensureColumn('pneus', 'tratamento_descarte_em', 'TEXT');
  await ensureColumn('filiais', 'dia_medicao', 'INTEGER');
  await ensureColumn('veiculos', 'dia_medicao', 'INTEGER');
  await ensureColumn('veiculos', 'tipo_codigo', 'TEXT');
  await ensureColumn('medicoes', 'sulco_mm', 'DOUBLE PRECISION');
  await ensureColumn('medicoes', 'inspecao_danos', 'TEXT');
  await ensureColumn('medicoes', 'desgaste_mm_hora', 'DOUBLE PRECISION');
  await ensureColumn('medicoes', 'veiculo_id', 'BIGINT');
  await ensureColumn('medicoes', 'veiculo_apelido', 'TEXT');
  await ensureColumn('medicoes', 'posicao', 'TEXT');
  await ensureColumn('medicoes', 'ciclo', 'INTEGER');
  await ensureColumn('movimentacoes', 'veiculo_apelido', 'TEXT');
  await ensureColumn('movimentacoes', 'ciclo', 'INTEGER');
  await ensureColumn('movimentacoes', 'usuario', 'TEXT');
  await ensureColumn('movimentacoes', 'custo', 'DOUBLE PRECISION');
  await ensureColumn('movimentacoes', 'sulco_antes', 'DOUBLE PRECISION');
  await ensureColumn('movimentacoes', 'sulco_depois', 'DOUBLE PRECISION');
  await ensureColumn('movimentacoes', 'motivo', 'TEXT');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu_data
      ON movimentacoes(pneu_id, data_evento, id);
    CREATE INDEX IF NOT EXISTS idx_medicoes_pneu_ciclo
      ON medicoes(pneu_id, ciclo);
    CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu_ciclo
      ON movimentacoes(pneu_id, ciclo);
    CREATE INDEX IF NOT EXISTS idx_movimentacoes_veiculo_periodo
      ON movimentacoes(veiculo_id, data_evento);
    CREATE INDEX IF NOT EXISTS idx_medicoes_veiculo_periodo
      ON medicoes(veiculo_id, data_medicao);
  `);
  await restringirExclusaoHistoricoPneu();
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_veiculos_tipo_codigo ON veiculos(tipo_codigo);
  `);
  await seedEquipamentoTipos(db);
  await backfillTipoCodigoVeiculos(db);
  await ensureColumn('tokens_acesso_rapido', 'tipo', "TEXT NOT NULL DEFAULT 'medir'");
  await ensureColumn('tokens_acesso_rapido', 'pneu_id', 'BIGINT');
  await ensureColumn('veiculos', 'cadastro_completo', 'INTEGER DEFAULT 1');
  await ensureColumn('pneus', 'cadastro_completo', 'INTEGER DEFAULT 1');
  limparCacheColunas();
  try {
    await db.exec(`
      ALTER TABLE tokens_acesso_rapido ALTER COLUMN veiculo_id DROP NOT NULL
    `);
  } catch (err) {
    // já nullable ou tabela nova
    if (!/does not exist|already|não existe/i.test(err.message)) {
      console.warn('[migrate] tokens veiculo_id nullable:', err.message);
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessoes (
      id BIGSERIAL PRIMARY KEY,
      chave TEXT NOT NULL UNIQUE,
      filial_id BIGINT NOT NULL,
      chat_jid TEXT,
      telefone TEXT,
      fluxo TEXT NOT NULL,
      passo TEXT NOT NULL,
      dados JSONB DEFAULT '{}'::jsonb,
      atualizado_em TIMESTAMPTZ DEFAULT NOW(),
      expira_em TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wa_sessoes_expira ON whatsapp_sessoes(expira_em);
  `);

  await seedConfigs();
  const matrizId = await seedAuthAndFilial();

  await db.prepare(`
    UPDATE pneus SET filial_id = (
      SELECT v.filial_id FROM veiculos v WHERE v.id = pneus.veiculo_id
    )
    WHERE filial_id IS NULL AND veiculo_id IS NOT NULL
  `).run();
  await db.prepare(`UPDATE pneus SET filial_id = ? WHERE filial_id IS NULL`).run(matrizId);

  try {
    const jaCorrigiu = await db.prepare(
      'SELECT valor FROM configuracoes WHERE chave = ?'
    ).get('encoding_corrigido_v1');
    if (!jaCorrigiu) {
      await corrigirEncodingBanco(db);
      await db.prepare(`
        INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
        ON CONFLICT (chave) DO NOTHING
      `).run('encoding_corrigido_v1', '1');
    }
  } catch (err) {
    console.warn('[database] encoding:', err.message);
  }

  ready = true;
  console.log(`[database] PostgreSQL OK → ${config.databaseUrl.replace(/:[^:@/]+@/, ':****@')}`);
  return getDb();
}

export function getDb() {
  return db;
}

export { classificarSulco } from './limites.js';
export { closePool };

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('database.js')) {
  initDatabase()
    .then(() => {
      console.log('Banco PostgreSQL inicializado');
      return closePool();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export default db;
