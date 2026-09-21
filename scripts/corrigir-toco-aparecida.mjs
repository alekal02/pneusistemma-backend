/**
 * Corrige a frota da Aparecida para Toco / Mini + toco_6.
 * Não apaga nem desmonta pneus — só atualiza tipo e layout.
 *
 *   node scripts/corrigir-toco-aparecida.mjs
 *   node scripts/corrigir-toco-aparecida.mjs --confirmar
 */
const BASE = process.env.API_BASE || 'https://pneusistemma-backend.onrender.com/api';
const LOGIN = process.env.FILIAL_LOGIN || 'aparecida';
const SENHA = process.env.FILIAL_SENHA || 'ap123';
const CONFIRMAR = process.argv.includes('--confirmar');
const TIPO = 'Toco / Mini';
const LAYOUT = 'toco_6';

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.erro || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const login = await req('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: LOGIN, senha: SENHA }),
});
const headers = { Authorization: `Bearer ${login.token}` };
const veiculos = await req('/veiculos', { headers });
const resumo = {};
for (const v of veiculos) {
  const k = `${v.tipo || '—'} / ${v.layout_pneus || '—'}`;
  resumo[k] = (resumo[k] || 0) + 1;
}
console.log(`API ${BASE}  filial ${login.usuario?.filial_id}  veiculos ${veiculos.length}`);
console.log('Antes:', resumo);
for (const v of veiculos) {
  console.log(`  ${v.placa} ${v.apelido || ''} | ${v.tipo} | ${v.layout_pneus}`);
}

if (!CONFIRMAR) {
  console.log('\nNada foi alterado. Rode com --confirmar para aplicar Toco / Mini.');
  process.exit(0);
}

let ok = 0;
for (const v of veiculos) {
  await req(`/veiculos/${v.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      tipo: TIPO,
      layout_pneus: LAYOUT,
      apelido: v.apelido,
      marca: v.marca,
      modelo: v.modelo,
      observacoes: v.observacoes,
    }),
  });
  ok += 1;
  console.log(`ok ${v.placa}`);
}

const depois = await req('/veiculos', { headers });
const resumo2 = {};
for (const v of depois) {
  const k = `${v.tipo || '—'} / ${v.layout_pneus || '—'}`;
  resumo2[k] = (resumo2[k] || 0) + 1;
}
console.log(`Atualizados ${ok}. Depois:`, resumo2);
