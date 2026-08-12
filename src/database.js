import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { corrigirEncodingBanco } from './fix-encoding.js';

const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS filiais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT NOT NULL UNIQUE,
    contrato TEXT,
    ativo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    papel TEXT NOT NULL CHECK(papel IN ('admin', 'filial')),
    filial_id INTEGER,
    ativo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (filial_id) REFERENCES filiais(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS veiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    placa TEXT NOT NULL UNIQUE,
    apelido TEXT,
    tipo TEXT NOT NULL DEFAULT 'Outro',
    marca TEXT,
    modelo TEXT,
    ano INTEGER,
    km_atual INTEGER DEFAULT 0,
    hr_atual REAL DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    observacoes TEXT,
    filial_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (filial_id) REFERENCES filiais(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS pneus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER,
    posicao TEXT,
    filial_id INTEGER,
    marca TEXT,
    modelo TEXT,
    medida TEXT,
    dot TEXT,
    numero_fogo TEXT,
    tipo_pneu TEXT DEFAULT 'misto',
    condicao TEXT DEFAULT 'novo',
    vida_recap INTEGER DEFAULT 0,
    sulco_inicial_mm REAL,
    status_pneu TEXT DEFAULT 'estoque',
    data_instalacao TEXT,
    km_instalacao INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    observacoes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (veiculo_id) REFERENCES veiculos(id) ON DELETE SET NULL,
    FOREIGN KEY (filial_id) REFERENCES filiais(id) ON DELETE RESTRICT,
    UNIQUE(veiculo_id, posicao)
  );

  CREATE TABLE IF NOT EXISTS medicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pneu_id INTEGER NOT NULL,
    data_medicao TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    km_veiculo INTEGER,
    hr_veiculo REAL,
    sulco_externo REAL,
    sulco_central REAL,
    sulco_interno REAL,
    sulco_auxiliar REAL,
    pressao_psi REAL,
    responsavel TEXT,
    observacoes TEXT,
    marcacao_json TEXT,
    diagnostico TEXT,
    acao_sugerida TEXT,
    desgaste_mm_km REAL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (pneu_id) REFERENCES pneus(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS movimentacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pneu_id INTEGER NOT NULL,
    veiculo_id INTEGER,
    tipo TEXT NOT NULL,
    data_evento TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    km_veiculo INTEGER,
    hr_veiculo REAL,
    posicao TEXT,
    sulco_mm REAL,
    detalhes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (pneu_id) REFERENCES pneus(id) ON DELETE CASCADE,
    FOREIGN KEY (veiculo_id) REFERENCES veiculos(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pneus_veiculo ON pneus(veiculo_id);
  CREATE INDEX IF NOT EXISTS idx_medicoes_pneu ON medicoes(pneu_id);
  CREATE INDEX IF NOT EXISTS idx_medicoes_data ON medicoes(data_medicao);
  CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu ON movimentacoes(pneu_id);

  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

const insertConfig = db.prepare(`
  INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)
`);
insertConfig.run('sulco_critico_mm', String(config.sulcoMinimo));
insertConfig.run('sulco_alerta_mm', String(config.sulcoAlerta));
insertConfig.run('sulco_recap_mm', '3');
insertConfig.run('sulco_novo_mm', '14');
insertConfig.run('max_recaps', '6');
insertConfig.run('prazo_recap_dias', '15');
insertConfig.run('diagnostico_tolerancia_mm', '1');

// Migração: perda ≤3 · recap ≤5 · monitorar ≤8 · OK >8 (legado)
const migrouFaixas = db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`)
  .get('limites_faixas_v2');
if (!migrouFaixas) {
  const upsertConfig = db.prepare(`
    INSERT INTO configuracoes (chave, valor, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(chave) DO UPDATE SET
      valor = excluded.valor,
      updated_at = excluded.updated_at
  `);
  upsertConfig.run('sulco_critico_mm', '3');
  upsertConfig.run('sulco_recap_mm', '5');
  upsertConfig.run('sulco_alerta_mm', '8');
  upsertConfig.run('limites_faixas_v2', '1');
  console.log('[migrate] Limites: perda ≤3 · recap ≤5 · monitorar ≤8 · OK >8');
}

// Faixas operacionais: <3 crítico · ≤8 monitorar (recap em 15 dias) · >8 OK
const migrouFaixasV3 = db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`)
  .get('limites_faixas_v3');
if (!migrouFaixasV3) {
  const upsertConfig = db.prepare(`
    INSERT INTO configuracoes (chave, valor, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(chave) DO UPDATE SET
      valor = excluded.valor,
      updated_at = excluded.updated_at
  `);
  upsertConfig.run('sulco_critico_mm', '3');
  upsertConfig.run('sulco_recap_mm', '3');
  upsertConfig.run('sulco_alerta_mm', '8');
  upsertConfig.run('prazo_recap_dias', '15');
  upsertConfig.run('acao_troca_label', 'Trocar');
  upsertConfig.run('acao_troca_instrucao', 'Crítico — retirar e trocar o pneu');
  upsertConfig.run('acao_monitorar_label', 'Monitorar');
  upsertConfig.run(
    'acao_monitorar_instrucao',
    'Programar substituição — iniciar processo de recap em até 15 dias'
  );
  upsertConfig.run('acao_rodizio_label', 'Mudar posição');
  upsertConfig.run(
    'acao_rodizio_instrucao',
    'Mudar de posição no caminhão para equalizar o desgaste (não faz balanceamento no eixo traseiro)'
  );
  upsertConfig.run('limites_faixas_v3', '1');
  console.log('[migrate] Limites v3: <3 crítico · ≤8 monitorar (recap 15d) · >8 OK');
}

function ensureColumn(table, column, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // coluna já existe
  }
}

ensureColumn('veiculos', 'layout_pneus', `TEXT DEFAULT 'truck_10'`);
ensureColumn('veiculos', 'hr_atual', 'REAL DEFAULT 0');
ensureColumn('veiculos', 'filial_id', 'INTEGER');

ensureColumn('pneus', 'numero_fogo', 'TEXT');
ensureColumn('pneus', 'tipo_pneu', `TEXT DEFAULT 'misto'`);
ensureColumn('pneus', 'condicao', `TEXT DEFAULT 'novo'`);
ensureColumn('pneus', 'vida_recap', 'INTEGER DEFAULT 0');
ensureColumn('pneus', 'sulco_inicial_mm', 'REAL');
ensureColumn('pneus', 'status_pneu', `TEXT DEFAULT 'montado'`);
ensureColumn('pneus', 'filial_id', 'INTEGER');
ensureColumn('pneus', 'custo', 'REAL');
ensureColumn('pneus', 'nota_fiscal', 'TEXT');
ensureColumn('pneus', 'data_alerta_monitorar', 'TEXT');

ensureColumn('medicoes', 'hr_veiculo', 'REAL');
ensureColumn('medicoes', 'diagnostico', 'TEXT');
ensureColumn('medicoes', 'acao_sugerida', 'TEXT');
ensureColumn('medicoes', 'desgaste_mm_km', 'REAL');
ensureColumn('medicoes', 'veiculo_placa', 'TEXT');

ensureColumn('movimentacoes', 'hr_veiculo', 'REAL');
ensureColumn('movimentacoes', 'posicao_anterior', 'TEXT');
ensureColumn('movimentacoes', 'km_rodado', 'INTEGER');
ensureColumn('movimentacoes', 'hr_rodado', 'REAL');
ensureColumn('movimentacoes', 'veiculo_placa', 'TEXT');

ensureColumn('usuarios', 'whatsapp', 'TEXT');
ensureColumn('usuarios', 'cargo', `TEXT DEFAULT 'funcionario'`);
ensureColumn('usuarios', 'ultimo_login', 'TEXT');

ensureColumn('filiais', 'whatsapp', 'TEXT');
ensureColumn('filiais', 'whatsapp_grupo', 'TEXT');
ensureColumn('filiais', 'whatsapp_alerta', 'TEXT');
ensureColumn('filiais', 'wuzapi_token', 'TEXT');
ensureColumn('notificacoes_whatsapp', 'filial_id', 'INTEGER');

// Backfill filial_id a partir do veículo
try {
  db.prepare(`
    UPDATE notificacoes_whatsapp
    SET filial_id = (
      SELECT v.filial_id FROM veiculos v WHERE v.id = notificacoes_whatsapp.veiculo_id
    )
    WHERE filial_id IS NULL AND veiculo_id IS NOT NULL
  `).run();
} catch {
  /* ignore */
}

// Limpa valores literais "null"/"undefined" gravados por engano em campos WhatsApp
try {
  db.prepare(`
    UPDATE filiais SET
      whatsapp = CASE WHEN lower(trim(COALESCE(whatsapp,''))) IN ('null','undefined','') THEN NULL ELSE whatsapp END,
      whatsapp_grupo = CASE WHEN lower(trim(COALESCE(whatsapp_grupo,''))) IN ('null','undefined','') THEN NULL ELSE whatsapp_grupo END,
      whatsapp_alerta = CASE WHEN lower(trim(COALESCE(whatsapp_alerta,''))) IN ('null','undefined','') THEN NULL ELSE whatsapp_alerta END
  `).run();
} catch {
  /* ignore */
}

/** Amplia papéis: admin | gerente | filial */
function migratePapeisUsuarios() {
  const done = db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`).get('migrate_papel_gerente_v1');
  if (done) return;

  const info = db.prepare('PRAGMA table_info(usuarios)').all();
  if (!info.length) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE usuarios_novo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL CHECK(papel IN ('admin', 'gerente', 'filial')),
      filial_id INTEGER,
      ativo INTEGER DEFAULT 1,
      whatsapp TEXT,
      cargo TEXT DEFAULT 'funcionario',
      ultimo_login TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (filial_id) REFERENCES filiais(id) ON DELETE SET NULL
    );

    INSERT INTO usuarios_novo (
      id, login, senha_hash, papel, filial_id, ativo, whatsapp, cargo, ultimo_login, created_at, updated_at
    )
    SELECT
      id, login, senha_hash,
      CASE
        WHEN papel = 'admin' AND IFNULL(cargo, '') IN ('gerente_compras', 'gerente_filial') THEN 'gerente'
        WHEN papel = 'filial' AND IFNULL(cargo, '') = 'gerente_filial' THEN 'gerente'
        ELSE papel
      END,
      filial_id, ativo, whatsapp, cargo, NULL, created_at, updated_at
    FROM usuarios;

    DROP TABLE usuarios;
    ALTER TABLE usuarios_novo RENAME TO usuarios;
  `);
  db.exec('PRAGMA foreign_keys = ON');

  db.prepare(`
    INSERT INTO configuracoes (chave, valor, updated_at)
    VALUES ('migrate_papel_gerente_v1', '1', datetime('now', 'localtime'))
  `).run();
  console.log('[migrate] Papéis: admin (total) · gerente (unidade) · filial (operador)');
}

migratePapeisUsuarios();

db.exec(`
  CREATE TABLE IF NOT EXISTS notificacoes_whatsapp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL CHECK(tipo IN ('link_veiculo', 'alerta_critico', 'alerta_desgaste')),
    destinatario_whatsapp TEXT NOT NULL,
    veiculo_id INTEGER,
    medicao_id INTEGER,
    mensagem TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'enviado' CHECK(status IN ('enviado', 'erro', 'entregue')),
    resposta_api TEXT,
    criado_em TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (veiculo_id) REFERENCES veiculos(id),
    FOREIGN KEY (medicao_id) REFERENCES medicoes(id)
  );

  CREATE TABLE IF NOT EXISTS tokens_acesso_rapido (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    veiculo_id INTEGER NOT NULL,
    filial_id INTEGER NOT NULL,
    whatsapp_origem TEXT,
    expira_em TEXT NOT NULL,
    usado_em TEXT,
    criado_em TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (veiculo_id) REFERENCES veiculos(id),
    FOREIGN KEY (filial_id) REFERENCES filiais(id)
  );

  CREATE INDEX IF NOT EXISTS idx_notif_whatsapp_medicao ON notificacoes_whatsapp(medicao_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_acesso_token ON tokens_acesso_rapido(token);

  CREATE TABLE IF NOT EXISTS alerta_destinatarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    whatsapp TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    escopo TEXT NOT NULL DEFAULT 'todas' CHECK(escopo IN ('todas', 'filial')),
    filial_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (filial_id) REFERENCES filiais(id) ON DELETE SET NULL
  );
`);

try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_dest_whatsapp ON alerta_destinatarios(whatsapp)');
} catch {
  // índice já existe
}

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_veiculos_filial ON veiculos(filial_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usuarios_filial ON usuarios(filial_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pneus_filial ON pneus(filial_id)');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pneus_fogo_filial
    ON pneus(filial_id, numero_fogo)
    WHERE numero_fogo IS NOT NULL AND numero_fogo != '' AND ativo = 1`);
} catch {
  // índice já existe ou coluna ainda indisponível
}

/** Migra veículos sem filial para Matriz e cria admin se necessário */
function seedAuthAndFilial() {
  let matriz = db.prepare(`SELECT id FROM filiais WHERE codigo = 'MATRIZ'`).get();
  if (!matriz) {
    const r = db.prepare(`
      INSERT INTO filiais (nome, codigo, contrato)
      VALUES ('Matriz', 'MATRIZ', 'Dados migrados')
    `).run();
    matriz = { id: r.lastInsertRowid };
  }

  db.prepare(`
    UPDATE veiculos SET filial_id = ? WHERE filial_id IS NULL
  `).run(matriz.id);

  const admin = db.prepare(`SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1`).get();
  if (!admin) {
    const hash = bcrypt.hashSync(config.adminPassword, 10);
    db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
      VALUES (?, ?, 'admin', 'admin', NULL, 1)
    `).run(config.adminUser, hash);
    console.log(`[seed] Admin criado: ${config.adminUser} / (senha do .env ADMIN_PASSWORD)`);
  } else {
    db.prepare(`
      UPDATE usuarios SET cargo = COALESCE(NULLIF(cargo, ''), 'admin')
      WHERE id = ? AND (cargo IS NULL OR cargo = '' OR cargo = 'funcionario')
    `).run(admin.id);
  }

  // Usuário da Matriz se não existir
  const userMatriz = db.prepare(`
    SELECT id FROM usuarios WHERE filial_id = ? AND papel = 'filial' AND login = 'matriz' LIMIT 1
  `).get(matriz.id);
  if (!userMatriz) {
    const hash = bcrypt.hashSync('matriz123', 10);
    db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
      VALUES ('matriz', ?, 'filial', 'funcionario', ?, 1)
    `).run(hash, matriz.id);
    console.log('[seed] Usuário filial Matriz: matriz / matriz123');
  }

  const compras = db.prepare(`SELECT id FROM usuarios WHERE login = 'compras' LIMIT 1`).get();
  if (!compras) {
    const hash = bcrypt.hashSync('compras123', 10);
    db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, whatsapp, filial_id, ativo)
      VALUES ('compras', ?, 'gerente', 'gerente_compras', '5511988888888', NULL, 1)
    `).run(hash);
    console.log('[seed] Gerente compras: compras / compras123 (WhatsApp 5511988888888)');
  }

  const gerenteMatriz = db.prepare(`
    SELECT id FROM usuarios WHERE login = 'gerente_matriz' LIMIT 1
  `).get();
  if (!gerenteMatriz) {
    const hash = bcrypt.hashSync('gerente123', 10);
    db.prepare(`
      INSERT INTO usuarios (login, senha_hash, papel, cargo, whatsapp, filial_id, ativo)
      VALUES ('gerente_matriz', ?, 'gerente', 'gerente_filial', '5511977777777', ?, 1)
    `).run(hash, matriz.id);
    console.log('[seed] Gerente unidade Matriz: gerente_matriz / gerente123');
  }

  db.prepare(`
    UPDATE usuarios SET cargo = 'funcionario'
    WHERE cargo IS NULL OR cargo = ''
  `).run();

  return matriz.id;
}

/** Torna veiculo_id/posicao nullable e garante filial_id (estoque reutilizável) */
function migratePneusEstoque(filialFallbackId) {
  db.prepare(`
    UPDATE pneus SET filial_id = (
      SELECT v.filial_id FROM veiculos v WHERE v.id = pneus.veiculo_id
    )
    WHERE filial_id IS NULL AND veiculo_id IS NOT NULL
  `).run();

  if (filialFallbackId) {
    db.prepare(`
      UPDATE pneus SET filial_id = ? WHERE filial_id IS NULL
    `).run(filialFallbackId);
  }

  const info = db.prepare('PRAGMA table_info(pneus)').all();
  const veiculoCol = info.find((c) => c.name === 'veiculo_id');
  if (!veiculoCol || veiculoCol.notnull !== 1) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE pneus_novo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      veiculo_id INTEGER,
      posicao TEXT,
      filial_id INTEGER,
      marca TEXT,
      modelo TEXT,
      medida TEXT,
      dot TEXT,
      numero_fogo TEXT,
      tipo_pneu TEXT DEFAULT 'misto',
      condicao TEXT DEFAULT 'novo',
      vida_recap INTEGER DEFAULT 0,
      sulco_inicial_mm REAL,
      status_pneu TEXT DEFAULT 'montado',
      data_instalacao TEXT,
      km_instalacao INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      observacoes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (veiculo_id) REFERENCES veiculos(id) ON DELETE SET NULL,
      FOREIGN KEY (filial_id) REFERENCES filiais(id) ON DELETE RESTRICT,
      UNIQUE(veiculo_id, posicao)
    );

    INSERT INTO pneus_novo (
      id, veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu,
      data_instalacao, km_instalacao, ativo, observacoes, created_at
    )
    SELECT
      id, veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu,
      data_instalacao, km_instalacao, ativo, observacoes, created_at
    FROM pneus;

    DROP TABLE pneus;
    ALTER TABLE pneus_novo RENAME TO pneus;

    CREATE INDEX IF NOT EXISTS idx_pneus_veiculo ON pneus(veiculo_id);
    CREATE INDEX IF NOT EXISTS idx_pneus_filial ON pneus(filial_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pneus_fogo_filial
      ON pneus(filial_id, numero_fogo)
      WHERE numero_fogo IS NOT NULL AND numero_fogo != '' AND ativo = 1;
  `);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[migrate] Tabela pneus: veiculo_id/posicao nullable + filial_id');
}

let matrizId = null;
try {
  matrizId = seedAuthAndFilial();
  migratePneusEstoque(matrizId);
} catch (err) {
  console.warn('[database] seed/migrate adiado:', err.message);
}

// Corrige acentos/corrompidos salvos no SQLite (ex.: Tração → Tra��o)
try {
  corrigirEncodingBanco(db);
} catch (err) {
  console.warn('[database] correção de encoding adiada:', err.message);
}

export function getDb() {
  return db;
}

export { classificarSulco } from './limites.js';

if (process.argv[1] && process.argv[1].endsWith('database.js')) {
  console.log('Banco de dados inicializado em:', config.dbPath);
}

export default db;
