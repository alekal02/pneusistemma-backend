#!/bin/bash
# Deploy front + back separados — Digital Ocean
set -e

APP_DIR="/var/www/pneu-controle"
REPO_URL=""  # <-- URL do repositório Git

echo "=== Deploy Controle de Pneus ==="

if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  sudo mkdir -p /var/www
  sudo git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# Backend
cd "$APP_DIR/backend"
npm ci --production
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i 's/NODE_ENV=development/NODE_ENV=production/' .env
  sed -i 's|HOST=localhost|HOST=0.0.0.0|' .env
fi
mkdir -p data logs
node src/database.js
pm2 delete pneu-api 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save

# Frontend
cd "$APP_DIR/frontend"
npm ci
cp -n .env.example .env 2>/dev/null || true
npm run build

echo ""
echo "=== Próximos passos ==="
echo "1. nginx: cp backend/deploy/nginx.conf.example /etc/nginx/sites-available/pneu-controle"
echo "2. certbot --nginx -d seu-dominio.com.br"
echo "Deploy concluído!"
