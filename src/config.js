import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

function parseCorsOrigins(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return list.length ? list : ['http://localhost:5173'];
}

const nodeEnv = process.env.NODE_ENV || 'development';
const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

/** Connection string PostgreSQL (obrigatória) */
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  // Dev fallback local (docker pneusistemma-pg)
  if (nodeEnv === 'development') {
    return process.env.DATABASE_URL_DEV
      || 'postgresql://pneu:pneu123@localhost:5434/pneusistemma';
  }
  return '';
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || (nodeEnv === 'production' ? '0.0.0.0' : 'localhost'),
  nodeEnv,
  databaseUrl: resolveDatabaseUrl(),
  sulcoMinimo: parseFloat(process.env.SULCO_MINIMO_MM || '3.0'),
  sulcoAlerta: parseFloat(process.env.SULCO_ALERTA_MM || '8.0'),
  corsOrigins,
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
  wuzapiWebhookPublicUrl: (process.env.WUZAPI_WEBHOOK_PUBLIC_URL
    || `http://host.docker.internal:${parseInt(process.env.PORT || '3000', 10)}/api/webhook/whatsapp`
  ).replace(/\/$/, ''),
  gerenteComprasWhatsapp: (process.env.GERENTE_COMPRAS_WHATSAPP || '').replace(/\D/g, ''),
  /** Alertas WhatsApp pós-medição (crítico/monitorar). Desligado até segunda ordem. */
  whatsappAlertasEnabled: String(process.env.WHATSAPP_ALERTAS_ENABLED || 'false').toLowerCase() === 'true',
  allowVercelPreviews: String(process.env.ALLOW_VERCEL_PREVIEWS || 'true').toLowerCase() !== 'false',
  rootDir,
};

export const TIPOS_VEICULO = [
  'Truck / Tração',
  'Toco / Mini',
];
