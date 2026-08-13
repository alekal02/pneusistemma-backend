# Variáveis de Ambiente — PneuSistemma (Backend)

Documento completo na raiz do monorepo: `../VARIAVEIS_AMBIENTE.md`  
Cópia alinhada abaixo para o repo `pneusistemma-backend`.

---

## Render — obrigatórias

| Variável | Exemplo | Descrição |
|----------|---------|-----------|
| `DATABASE_URL` | `postgresql://…@….neon.tech/neondb?sslmode=require` | URI **Neon** (ou outro Postgres) |
| `DATABASE_SSL` | `true` | SSL em produção / Neon |
| `JWT_SECRET` | string longa | Assinatura JWT |
| `JWT_EXPIRES_IN` | `7d` | Validade |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / senha | Seed do admin |
| `CORS_ORIGIN` | URL Vercel | Origens permitidas |
| `FRONTEND_URL` | URL Vercel | Links WhatsApp |
| `HOST` | `0.0.0.0` | Escuta pública |
| `NODE_ENV` | `production` | Ambiente |

## Removido (SQLite)

- ~~`DB_PATH`~~ — não use mais
- ~~Disk `/var/data`~~ — não necessário para banco

## WhatsApp

`WUZAPI_BASE_URL`, `WUZAPI_TOKEN`, `WUZAPI_ADMIN_TOKEN`, `WUZAPI_WEBHOOK_PUBLIC_URL`, `WUZAPI_WEBHOOK_SECRET`, `GERENTE_COMPRAS_WHATSAPP`

## Local

```text
DATABASE_URL=postgresql://pneu:pneu123@localhost:5434/pneusistemma
DATABASE_SSL=false
```

Ou URI do Neon com `DATABASE_SSL=true`.

Arquivos: `.env.example` · `render.env.example` · `schema-neon.sql`
