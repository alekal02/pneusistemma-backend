/**
 * PM2 — apenas o backend (API)
 * O frontend em produção é servido pelo nginx (pasta frontend/dist)
 */
module.exports = {
  apps: [
    {
      name: 'pneu-api',
      script: 'server.js',
      cwd: '/var/www/pneu-controle/backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        DB_PATH: '/var/www/pneu-controle/backend/data/pneus.db',
        CORS_ORIGIN: 'https://pneus.suaempresa.com.br',
        SULCO_MINIMO_MM: 1.6,
        SULCO_ALERTA_MM: 3.0,
      },
      error_file: '/var/www/pneu-controle/backend/logs/err.log',
      out_file: '/var/www/pneu-controle/backend/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
