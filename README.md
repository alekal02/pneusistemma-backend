# PneuSistemma — Backend (API)

API REST (Node.js + Express + SQLite) para controle de desgaste de pneus.

**Deploy:** [Render](https://render.com)  
**Repositório frontend:** https://github.com/alekal02/pneusistemma-frontend

## Stack

- Node.js ≥ 22
- Express
- SQLite (`node:sqlite`)
- JWT + bcrypt
- Integração WuzAPI (WhatsApp)

## Local

```bash
cp .env.example .env
npm install
npm run dev
```

API: http://localhost:3000/api  
Health: http://localhost:3000/api/health

## Render

1. New → Web Service → este repositório
2. Build: `npm install` · Start: `npm start`
3. Health Check Path: `/api/health`
4. Adicione um **Disk** montado em `/var/data`
5. Configure as variáveis (veja `VARIAVEIS_AMBIENTE.md`)

Blueprint opcional: `render.yaml`

## Variáveis de ambiente

Documento completo: **[VARIAVEIS_AMBIENTE.md](./VARIAVEIS_AMBIENTE.md)**
