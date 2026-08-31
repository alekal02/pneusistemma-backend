/**
 * Remove só filiais de teste E2E (frota + cadastro), via API.
 * Não toca BH, Matriz nem outras unidades reais.
 *
 * Trava dupla: código E2E… E nome "Filial Teste E2E".
 *
 *   node scripts/limpar-dados-e2e.mjs
 *   E2E_BASE=https://pneusistemma-backend.onrender.com/api ADMIN_PASS=... node scripts/limpar-dados-e2e.mjs --confirmar
 */
const BASE = (process.env.E2E_BASE || 'http://localhost:3000/api').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || 'admin123';
const CONFIRMAR = process.argv.includes('--confirmar');

function ehFilialTesteE2E(f) {
  if (!f) return false;
  const codigo = String(f.codigo || '').toUpperCase();
  const nome = String(f.nome || f.filial || '');
  const contrato = String(f.contrato || '');
  const codigoOk = /^E2E\d+$/.test(codigo);
  const nomeOk = /filial teste e2e/i.test(nome);
  const contratoOk = /teste automatizado/i.test(contrato);
  return codigoOk && (nomeOk || contratoOk);
}

async function req(metodo, caminho, { token, body, timeoutMs = 180_000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const texto = await res.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto.slice(0, 300) }; }
  return { status: res.status, dados };
}

async function main() {
  console.log(`\nLimpeza E2E → ${BASE}${CONFIRMAR ? ' (CONFIRMAR)' : ' (simulação)'}\n`);

  const login = await req('POST', '/auth/login', { body: { login: ADMIN_USER, senha: ADMIN_PASS } });
  const token = login.dados?.token;
  if (login.status !== 200 || !token) {
    console.error('Login admin falhou:', login.status, login.dados);
    process.exit(1);
  }

  const ids = new Set();

  const users = await req('GET', '/usuarios', { token });
  const listaUsers = users.dados?.usuarios || [];
  for (const u of listaUsers) {
    const codigo = String(u.filial_codigo || '').toUpperCase();
    const loginU = String(u.login || '');
    if (/^E2E\d+$/.test(codigo) || /^(fiscal|gerente)_\d{6}$/.test(loginU)) {
      if (u.filial_id) ids.add(Number(u.filial_id));
    }
  }

  const dir = await req('GET', '/relatorios/diretoria', { token });
  const linhas = dir.dados?.por_filial || [];
  for (const f of linhas) {
    if (ehFilialTesteE2E(f) && f.filial_id) ids.add(Number(f.filial_id));
  }

  const alvos = [];
  for (const id of ids) {
    const det = await req('GET', `/filiais/${id}/resumo`, { token });
    const f = det.dados?.filial || det.dados;
    if (!ehFilialTesteE2E(f)) {
      console.log(`ignorado id=${id} (não é E2E de teste) ${f?.codigo || ''} ${f?.nome || det.status}`);
      continue;
    }
    alvos.push({
      id,
      codigo: f.codigo,
      nome: f.nome,
      veiculos: det.dados?.veiculos ?? null,
    });
  }

  if (!alvos.length) {
    console.log('Nenhuma filial de teste E2E encontrada.');
    return;
  }

  console.log('Alvos (somente teste):');
  for (const a of alvos) {
    console.log(`  id=${a.id} ${a.codigo} — ${a.nome} · veículos≈${a.veiculos}`);
  }

  if (!CONFIRMAR) {
    console.log('\nNada foi apagado. Rode de novo com --confirmar.');
    return;
  }

  for (const a of alvos) {
    const limpa = await req('POST', `/filiais/${a.id}/limpar-frota`, { token });
    console.log(
      `frota ${a.codigo}:`,
      limpa.status,
      limpa.dados?.antes || limpa.dados?.erro || limpa.dados?.mensagem || ''
    );
    const del = await req('DELETE', `/filiais/${a.id}`, { token });
    console.log(`filial ${a.codigo}:`, del.status, del.dados?.mensagem || del.dados?.erro || '');
  }

  console.log('\nConcluído. Unidades reais não foram alteradas.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
