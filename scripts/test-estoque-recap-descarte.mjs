/**
 * Testa o fluxo do Editar (estoque → recap / descarte), igual ao painel.
 * Uso: node scripts/test-estoque-recap-descarte.mjs
 * Env: SMOKE_BASE, FILIAL_USER, FILIAL_PASS
 */
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api';
const USER = process.env.FILIAL_USER || 'matriz';
const PASS = process.env.FILIAL_PASS || 'matriz123';

let falhas = 0;

function assert(cond, msg, extra) {
  if (cond) console.log(`OK   ${msg}`);
  else {
    falhas += 1;
    console.log(`FAIL ${msg}${extra ? ` -> ${String(extra).slice(0, 280)}` : ''}`);
  }
}

async function req(metodo, caminho, { token, body } = {}) {
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto }; }
  return { status: res.status, dados };
}

function payloadEdit(overrides = {}) {
  return {
    numero_fogo: overrides.numero_fogo,
    marca: overrides.marca || 'TesteEstoque',
    modelo: overrides.modelo || 'Anteo',
    medida: '275/80R22.5',
    tipo_pneu: 'direcional',
    condicao: 'novo',
    vida_recap: overrides.vida_recap ?? 1,
    sulco_inicial_mm: 5,
    custo: null,
    nota_fiscal: null,
    dot: '2922',
  };
}

const login = await req('POST', '/auth/login', { body: { login: USER, senha: PASS } });
assert(login.status === 200 && login.dados?.token, 'login filial', JSON.stringify(login.dados));
const token = login.dados?.token;
if (!token) {
  console.error('\nAbortado: API local não autenticou. Não publicar.');
  process.exit(1);
}

async function proximoFogo() {
  const r = await req('GET', '/pneus/proximo-fogo', { token });
  const fogo = r.dados?.proximo;
  assert(r.status === 200 && fogo, 'GET /pneus/proximo-fogo', JSON.stringify(r.dados));
  return fogo;
}

const fogoRecap = await proximoFogo();
if (!fogoRecap) {
  console.error('\nAbortado: sem marca de fogo. Não publicar.');
  process.exit(1);
}

const criaRecap = await req('POST', '/pneus', {
  token,
  body: payloadEdit({ numero_fogo: fogoRecap, vida_recap: 1 }),
});
const idRecap = criaRecap.dados?.pneu?.id ?? criaRecap.dados?.id;
assert(criaRecap.status === 201 && idRecap, 'POST pneu recap no estoque', JSON.stringify(criaRecap.dados));
if (!idRecap) {
  console.error('\nAbortado: não criou pneu de recap. Não publicar.');
  process.exit(1);
}
assert(criaRecap.dados?.pneu?.status_pneu === 'estoque', 'pneu recap nasce em estoque', criaRecap.dados?.pneu?.status_pneu);

const putRecap = await req('PUT', `/pneus/${idRecap}`, {
  token,
  body: payloadEdit({ numero_fogo: fogoRecap, marca: 'TesteEstoque', modelo: 'Anteo', vida_recap: 1 }),
});
assert(putRecap.status === 200, 'PUT editar pneu (antes da recap)', JSON.stringify(putRecap.dados));

const evRecap = await req('POST', `/pneus/${idRecap}/evento`, {
  token,
  body: { tipo: 'recap', detalhes: 'Estoque · teste envio recap' },
});
assert(evRecap.status === 201, 'POST evento recap a partir do estoque', JSON.stringify(evRecap.dados));
assert(evRecap.dados?.pneu?.status_pneu === 'recapagem', 'status virou recapagem', evRecap.dados?.pneu?.status_pneu);
assert((evRecap.dados?.pneu?.vida_recap || 0) === 2, 'vida recap incrementou 1→2', evRecap.dados?.pneu?.vida_recap);
assert(!evRecap.dados?.pneu?.veiculo_id, 'recap do estoque não fica montado', evRecap.dados?.pneu?.veiculo_id);

const getRecap = await req('GET', `/pneus/${idRecap}`, { token });
assert(getRecap.status === 200 && getRecap.dados?.status_pneu === 'recapagem', 'GET confirma recapagem');

const listaRecap = await req('GET', '/pneus?status=recapagem', { token });
const naListaRecap = (listaRecap.dados || []).some((p) => Number(p.id) === Number(idRecap));
assert(listaRecap.status === 200 && naListaRecap, 'aparece no filtro Em recapagem');

const listaEstoqueAposRecap = await req('GET', '/pneus?status=estoque', { token });
const aindaEstoque = (listaEstoqueAposRecap.dados || []).some((p) => Number(p.id) === Number(idRecap));
assert(!aindaEstoque, 'saiu do filtro Estoque após recap');

const recapDeNovo = await req('POST', `/pneus/${idRecap}/evento`, {
  token,
  body: { tipo: 'recap' },
});
assert(recapDeNovo.status === 400, 'não deixa enviar de novo à recap', JSON.stringify(recapDeNovo.dados));

const fogoDesc = await proximoFogo();
if (!fogoDesc) {
  console.error('\nAbortado: sem marca de fogo para descarte. Não publicar.');
  process.exit(1);
}

const criaDesc = await req('POST', '/pneus', {
  token,
  body: payloadEdit({ numero_fogo: fogoDesc, vida_recap: 1 }),
});
const idDesc = criaDesc.dados?.pneu?.id ?? criaDesc.dados?.id;
assert(criaDesc.status === 201 && idDesc, 'POST pneu descarte no estoque', JSON.stringify(criaDesc.dados));
if (!idDesc) {
  console.error('\nAbortado: não criou pneu de descarte. Não publicar.');
  process.exit(1);
}

const putDesc = await req('PUT', `/pneus/${idDesc}`, {
  token,
  body: payloadEdit({ numero_fogo: fogoDesc, modelo: 'Anteo', vida_recap: 1 }),
});
assert(putDesc.status === 200, 'PUT editar pneu (antes do descarte)', JSON.stringify(putDesc.dados));

const evDesc = await req('POST', `/pneus/${idDesc}/evento`, {
  token,
  body: { tipo: 'descarte', detalhes: 'Estoque · rasgado teste' },
});
assert(evDesc.status === 201, 'POST evento descarte a partir do estoque', JSON.stringify(evDesc.dados));
assert(evDesc.dados?.pneu?.status_pneu === 'descarte', 'status virou descarte', evDesc.dados?.pneu?.status_pneu);
assert(evDesc.dados?.pneu?.tratamento_descarte === 'pendente', 'tratamento inicia pendente', evDesc.dados?.pneu?.tratamento_descarte);

const listaDesc = await req('GET', '/pneus?status=descarte', { token });
const naListaDesc = (listaDesc.dados || []).some((p) => Number(p.id) === Number(idDesc));
assert(listaDesc.status === 200 && naListaDesc, 'aparece no filtro Descarte');

const trat = await req('PUT', `/pneus/${idDesc}/tratamento-descarte`, {
  token,
  body: { tratamento: 'reciclagem', observacoes: 'teste coleta' },
});
assert(trat.status === 200, 'PUT tratamento descarte', JSON.stringify(trat.dados));
assert(trat.dados?.pneu?.tratamento_descarte === 'reciclagem', 'tratamento gravado', trat.dados?.pneu?.tratamento_descarte);

const recapDescartado = await req('POST', `/pneus/${idDesc}/evento`, {
  token,
  body: { tipo: 'recap' },
});
assert(
  recapDescartado.status === 400 || recapDescartado.status === 404,
  'pneu em descarte não vai para recap',
  JSON.stringify(recapDescartado.dados)
);

console.log(falhas ? `\n${falhas} FALHA(S) — não publicar` : '\nFLUXO ESTOQUE → RECAP/DESCARTE OK');
process.exit(falhas ? 1 : 0);
