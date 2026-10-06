-- ============================================================
-- PneuSistemma — Schema PostgreSQL (Neon / Render / local)
-- Cole e execute no SQL Editor do Neon (ou: psql $DATABASE_URL -f schema-neon.sql)
-- Idempotente: pode rodar mais de uma vez (IF NOT EXISTS).
-- ============================================================

-- 1) Tabelas
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

CREATE TABLE IF NOT EXISTS usuarios (
  id BIGSERIAL PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'gerente', 'filial')),
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
  tipo_codigo TEXT,
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
  tratamento_descarte TEXT,
  tratamento_descarte_obs TEXT,
  tratamento_descarte_em TEXT,
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
  tipo TEXT NOT NULL CHECK (tipo IN ('link_veiculo', 'alerta_critico', 'alerta_desgaste', 'relatorio_semanal')),
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
  veiculo_id BIGINT NOT NULL REFERENCES veiculos(id),
  filial_id BIGINT NOT NULL REFERENCES filiais(id),
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

-- 2) Índices
CREATE INDEX IF NOT EXISTS idx_pneus_veiculo ON pneus(veiculo_id);
CREATE INDEX IF NOT EXISTS idx_pneus_filial ON pneus(filial_id);
CREATE INDEX IF NOT EXISTS idx_medicoes_pneu ON medicoes(pneu_id);
CREATE INDEX IF NOT EXISTS idx_medicoes_pneu_recente ON medicoes(pneu_id, data_medicao DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_medicoes_data ON medicoes(data_medicao);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu ON movimentacoes(pneu_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu_data ON movimentacoes(pneu_id, data_evento, id);
CREATE INDEX IF NOT EXISTS idx_medicoes_pneu_ciclo ON medicoes(pneu_id, ciclo);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_pneu_ciclo ON movimentacoes(pneu_id, ciclo);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_veiculo_periodo ON movimentacoes(veiculo_id, data_evento);
CREATE INDEX IF NOT EXISTS idx_medicoes_veiculo_periodo ON medicoes(veiculo_id, data_medicao);
CREATE INDEX IF NOT EXISTS idx_veiculos_filial ON veiculos(filial_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_filial ON usuarios(filial_id);
CREATE INDEX IF NOT EXISTS idx_notif_whatsapp_medicao ON notificacoes_whatsapp(medicao_id);
CREATE INDEX IF NOT EXISTS idx_tokens_acesso_token ON tokens_acesso_rapido(token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_dest_whatsapp
  ON alerta_destinatarios(whatsapp);

-- Bancos já criados: coluna nova sem reescrever veículos existentes.
-- O seed do catálogo e o backfill de tipo_codigo rodam no start da API.
ALTER TABLE veiculos ADD COLUMN IF NOT EXISTS tipo_codigo TEXT;
CREATE INDEX IF NOT EXISTS idx_veiculos_tipo_codigo ON veiculos(tipo_codigo);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pneus_fogo_filial
  ON pneus(filial_id, numero_fogo)
  WHERE numero_fogo IS NOT NULL AND numero_fogo != '' AND ativo = 1;

-- 3) Configurações iniciais (opcional — a API também cria ao subir)
INSERT INTO configuracoes (chave, valor) VALUES
  ('sulco_critico_mm', '3'),
  ('sulco_alerta_mm', '8'),
  ('sulco_recap_mm', '3'),
  ('sulco_novo_mm', '14'),
  ('max_recaps', '6'),
  ('prazo_recap_dias', '15'),
  ('diagnostico_tolerancia_mm', '1'),
  ('acao_troca_label', 'Trocar'),
  ('acao_troca_instrucao', 'Crítico — retirar e trocar o pneu'),
  ('acao_monitorar_label', 'Monitorar'),
  ('acao_monitorar_instrucao', 'Programar substituição — iniciar processo de recap em até 15 dias'),
  ('acao_rodizio_label', 'Mudar posição'),
  ('acao_rodizio_instrucao', 'Mudar de posição no caminhão para equalizar o desgaste (não faz balanceamento no eixo traseiro)'),
  ('limites_faixas_v2', '1'),
  ('limites_faixas_v3', '1')
ON CONFLICT (chave) DO NOTHING;

-- Usuários (admin, matriz, etc.) são criados automaticamente no 1º start da API
-- (initDatabase / seedAuthAndFilial). Não precisa inserir aqui.
