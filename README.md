# PneuSistemma — Backend (API)

API REST (Node.js + Express + **PostgreSQL**) para controle de desgaste de pneus.

**Deploy:** [Render](https://render.com)  
**Repositório frontend:** https://github.com/alekal02/pneusistemma-frontend

## Stack

- Node.js ≥ 18 (recomendado 22)
- Express
- PostgreSQL (`pg`)
- JWT + bcrypt
- Integração WuzAPI (WhatsApp)

## Local

1. Suba o Postgres (Docker):

```bash
docker run -d --name pneusistemma-pg \
  -e POSTGRES_USER=pneu \
  -e POSTGRES_PASSWORD=pneu123 \
  -e POSTGRES_DB=pneusistemma \
  -p 5434:5432 postgres:16
```

2. Configure e rode a API:

```bash
cp .env.example .env
npm install
npm run dev
```

API: http://localhost:3000/api  
Health: http://localhost:3000/api/health (`"database":"postgresql"`)

### Smoke test

Com a API no ar:

```bash
npm run smoke
```

## Render

1. Crie um **PostgreSQL** no Render (ou use o `render.yaml`)
2. New → Web Service → este repositório
3. Build: `npm install` · Start: `npm start`
4. Health Check Path: `/api/health`
5. Defina `DATABASE_URL` (URI do **Neon** ou outro Postgres) e `DATABASE_SSL=true`
6. Configure as demais variáveis (veja `VARIAVEIS_AMBIENTE.md` / `render.env.example`)

> Não use `DB_PATH` nem Disk de SQLite — o banco é PostgreSQL.

## Variáveis de ambiente

Documento completo: **[VARIAVEIS_AMBIENTE.md](./VARIAVEIS_AMBIENTE.md)**
