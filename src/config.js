import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

function resolveDbPath() {
  const raw = process.env.DB_PATH;
  if (!raw) return path.join(rootDir, 'data', 'pneus.db');
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(rootDir, raw);
}

/** CORS_ORIGIN pode ser uma URL ou várias separadas por vírgula */
function parseCorsOrigins(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return list.length ? list : ['http://localhost:5173'];
}

const nodeEnv = process.env.NODE_ENV || 'development';
const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Em produção (Render) sempre escuta em todas as interfaces
  host: process.env.HOST || (nodeEnv === 'production' ? '0.0.0.0' : 'localhost'),
  nodeEnv,
  dbPath: resolveDbPath(),
  sulcoMinimo: parseFloat(process.env.SULCO_MINIMO_MM || '3.0'),
  sulcoAlerta: parseFloat(process.env.SULCO_ALERTA_MM || '8.0'),
  corsOrigins,
  /** @deprecated use corsOrigins — mantido para compat */
  corsOrigin: corsOrigins[0],
  frontendUrl: (process.env.FRONTEND_URL || corsOrigins[0] || 'http://localhost:5173').replace(/\/$/, ''),
  jwtSecret: process.env.JWT_SECRET || 'pneu-dev-secret-altere-em-producao',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  wuzapiBaseUrl: (process.env.WUZAPI_BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),
  wuzapiToken: process.env.WUZAPI_TOKEN || '',
  wuzapiAdminToken: process.env.WUZAPI_ADMIN_TOKEN || '',
  wuzapiWebhookSecret: process.env.WUZAPI_WEBHOOK_SECRET || '',
  // Em produção: URL pública do Render, ex: https://SEU-SERVICO.onrender.com/api/webhook/whatsapp
  wuzapiWebhookPublicUrl: (process.env.WUZAPI_WEBHOOK_PUBLIC_URL
    || `http://host.docker.internal:${parseInt(process.env.PORT || '3000', 10)}/api/webhook/whatsapp`
  ).replace(/\/$/, ''),
  gerenteComprasWhatsapp: (process.env.GERENTE_COMPRAS_WHATSAPP || '').replace(/\D/g, ''),
  allowVercelPreviews: String(process.env.ALLOW_VERCEL_PREVIEWS || 'true').toLowerCase() !== 'false',
  rootDir,
  dataDir: path.dirname(resolveDbPath()),
};

export const TIPOS_VEICULO = [
  'Truck / Tração',
  'Toco / Mini',
];
