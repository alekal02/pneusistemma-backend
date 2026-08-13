# Deploy Digital Ocean — Front + Back separados

## Estrutura no servidor

```
/var/www/pneu-controle/
├── backend/          # API Node.js (PM2, porta 3000) → PostgreSQL (Neon/local)
│   ├── server.js
│   └── deploy/
└── frontend/
    └── dist/         # Build estático (nginx)
```

## 1. Preparar o Droplet

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx git
npm install -g pm2
```

## 2. Enviar o projeto

```bash
mkdir -p /var/www
cd /var/www
git clone SEU_REPO pneu-controle
cd pneu-controle
```

## 3. Backend (API)

```bash
cd /var/www/pneu-controle/backend
npm ci --production
cp .env.example .env
nano .env
```

`.env` em produção:

```env
PORT=3000
NODE_ENV=production
HOST=0.0.0.0
DATABASE_URL=postgresql://pneu:SENHA@localhost:5432/pneusistemma
DATABASE_SSL=false
CORS_ORIGIN=https://pneus.suaempresa.com.br
SULCO_MINIMO_MM=1.6
SULCO_ALERTA_MM=3.0
```

```bash
mkdir -p logs
# Postgres precisa estar acessível (Docker/serviço local)
node src/database.js
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

## 4. Frontend (build)

```bash
cd /var/www/pneu-controle/frontend
cp .env.example .env
```

No `.env` do frontend para produção com mesmo domínio:

```env
VITE_API_URL=/api
```

```bash
npm ci
npm run build
# Gera frontend/dist/
```

## 5. Nginx

```bash
cp /var/www/pneu-controle/backend/deploy/nginx.conf.example \
   /etc/nginx/sites-available/pneu-controle

nano /etc/nginx/sites-available/pneu-controle
# Ajuste server_name e root se necessário

ln -s /etc/nginx/sites-available/pneu-controle /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

## 6. SSL

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d pneus.suaempresa.com.br
```

## Desenvolvimento local

Na raiz do projeto:

```bash
npm run install:all
copy backend\.env.example backend\.env
copy frontend\.env.example frontend\.env
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3000/api

## Atualizar em produção

```bash
cd /var/www/pneu-controle
git pull

# Backend
cd backend && npm ci --production && pm2 restart pneu-api

# Frontend
cd ../frontend && npm ci && npm run build
```

## Domínios separados (opcional)

Se quiser API em subdomínio (`api.seudominio.com`):

- Backend `CORS_ORIGIN=https://app.seudominio.com`
- Frontend `.env`: `VITE_API_URL=https://api.seudominio.com/api`
- Nginx: dois `server` blocks, um para cada
