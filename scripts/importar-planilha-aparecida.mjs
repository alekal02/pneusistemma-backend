/**
 * Importa a planilha preenchida na filial Aparecida, preservando o nº de fogo.
 * Uso: node scripts/importar-planilha-aparecida.mjs <arquivo.json>
 */
const BASE = process.env.API_BASE || 'https://pneusistemma-backend.onrender.com/api';
const LOGIN = process.env.FILIAL_LOGIN || 'aparecida';
const SENHA = process.env.FILIAL_SENHA || 'ap123';
const BATCH = Number(process.env.IMPORT_BATCH || 80);

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('Uso: node scripts/importar-planilha-aparecida.mjs <itens.json>');
  process.exit(1);
}

const { readFileSync } = await import('fs');
const payload = JSON.parse(readFileSync(jsonPath, 'utf8'));
const itens = payload.itens;
const descarteFogos = new Set(payload.descarte_fogos || []);

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.erro || data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const login = await req('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: LOGIN, senha: SENHA }),
});
const headers = { Authorization: `Bearer ${login.token}` };

const health = await req('/health');
console.log('API', BASE, 'db', health?.db || health, 'filial', login.usuario?.filial_id || login.filial_id);

const antes = await req('/pneus?status=todos', { headers });
console.log('pneus antes', antes.length, antes.map((p) => p.numero_fogo));

const detalhes = [];
const erros = [];
for (let i = 0; i < itens.length; i += BATCH) {
  const lote = itens.slice(i, i + BATCH);
  const n = Math.floor(i / BATCH) + 1;
  const totalLotes = Math.ceil(itens.length / BATCH);
  process.stdout.write(`lote ${n}/${totalLotes} (${lote.length})... `);
  try {
    const r = await req('/pneus/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ itens: lote }),
    });
    detalhes.push(...(r.detalhes || []));
    erros.push(...(r.erros || []));
    console.log(`ok ${r.inseridos}  erros ${r.erros?.length || 0}`);
  } catch (err) {
    console.log('FALHOU', err.message);
    erros.push({ lote: n, erro: err.message, data: err.data });
    break;
  }
}

let descartados = 0;
const falhaDescarte = [];
for (const d of detalhes) {
  if (!descarteFogos.has(String(d.numero_fogo))) continue;
  try {
    await req(`/pneus/${d.id}/evento`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tipo: 'descarte', detalhes: 'Importado da planilha (DESCARTE)' }),
    });
    descartados += 1;
  } catch (err) {
    falhaDescarte.push({ numero_fogo: d.numero_fogo, erro: err.message });
  }
}

const depois = await req('/pneus?status=todos', { headers });
const descarteLista = await req('/pneus?status=descarte', { headers }).catch(() => []);
const fogosDepois = [
  ...depois.map((p) => String(p.numero_fogo)),
  ...(Array.isArray(descarteLista) ? descarteLista.map((p) => String(p.numero_fogo)) : []),
];
const amostraPlanilha = itens.filter((x) => x.numero_fogo).slice(0, 8).map((x) => String(x.numero_fogo));
const okAmostra = amostraPlanilha.filter((f) => fogosDepois.includes(f));

console.log(JSON.stringify({
  enviados: itens.length,
  inseridos: detalhes.length,
  erros: erros.length,
  descartados,
  falhaDescarte: falhaDescarte.length,
  pneus_ativos: depois.length,
  pneus_descarte: Array.isArray(descarteLista) ? descarteLista.length : null,
  amostra_planilha_ok: `${okAmostra.length}/${amostraPlanilha.length}`,
  primeiros_erros: erros.slice(0, 8),
}, null, 2));

if (erros.length && detalhes.length === 0) process.exit(1);
if (okAmostra.length !== amostraPlanilha.length) {
  console.error('Amostra da planilha não conferiu nos fogos gravados', { amostraPlanilha, fogosDepois: fogosDepois.slice(0, 20) });
  process.exit(1);
}
