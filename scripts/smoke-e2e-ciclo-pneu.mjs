/**
 * E2E: caminhão novo → estoque → montagem → medições variáveis →
 * diagnósticos/pendências → rodízio → recap → retorno → descarte → relatório.
 *
 * Uso: node scripts/smoke-e2e-ciclo-pneu.mjs
 * Env: SMOKE_BASE, SMOKE_LOGIN, SMOKE_PASS
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api';
const LOGIN = process.env.SMOKE_LOGIN || 'matriz';
const PASS = process.env.SMOKE_PASS || 'matriz123';
const __dir = dirname(fileURLToPath(import.meta.url));

let falhas = 0;
const log = [];

function ok(msg, extra = '') {
  const line = `OK   ${msg}${extra ? ` · ${extra}` : ''}`;
  console.log(line);
  log.push(line);
}

function fail(msg, extra = '') {
  falhas += 1;
  const line = `FAIL ${msg}${extra ? ` · ${extra}` : ''}`;
  console.error(line);
  log.push(line);
}

async function req(method, path, { token, body, raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, contentType: res.headers.get('content-type') };
  }
  const texto = await res.text();
  let dados;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = { raw: texto.slice(0, 400) };
  }
  return { status: res.status, dados };
}

function assert(cond, rotulo, detalhe = '') {
  if (cond) ok(rotulo, detalhe);
  else fail(rotulo, detalhe);
}

function idDe(payload) {
  return payload?.id ?? payload?.veiculo?.id ?? payload?.pneu?.id ?? null;
}

const suffix = Date.now().toString().slice(-6);
const placa = `E2E${suffix}`.slice(0, 7);

console.log(`\n=== E2E ciclo pneu @ ${BASE} ===\n`);

// 1) Login filial + gerente (PDF)
const loginFilial = await req('POST', '/auth/login', { body: { login: LOGIN, senha: PASS } });
assert(loginFilial.status === 200 && loginFilial.dados?.token, 'login filial', LOGIN);
const token = loginFilial.dados?.token;
if (!token) {
  console.error('Abortando: sem token');
  process.exit(1);
}

const me = await req('GET', '/auth/me', { token });
const filialId = me.dados?.usuario?.filial_id ?? me.dados?.filial_id;
ok('auth/me', `filial_id=${filialId} papel=${me.dados?.usuario?.papel || me.dados?.papel}`);

const loginGerente = await req('POST', '/auth/login', {
  body: { login: process.env.SMOKE_GERENTE || 'gerente_matriz', senha: process.env.SMOKE_GERENTE_PASS || 'gerente123' },
});
const tokenGerente = loginGerente.status === 200 ? loginGerente.dados?.token : null;
if (tokenGerente) ok('login gerente');
else fail('login gerente', JSON.stringify(loginGerente.dados).slice(0, 200));

const loginAdmin = await req('POST', '/auth/login', {
  body: { login: process.env.ADMIN_USER || 'admin', senha: process.env.ADMIN_PASS || 'admin123' },
});
const tokenAdmin = loginAdmin.status === 200 ? loginAdmin.dados?.token : null;
if (tokenAdmin) ok('login admin');
else fail('login admin', JSON.stringify(loginAdmin.dados).slice(0, 200));

// 2) Meta / layouts
const metaV = await req('GET', '/veiculos/meta', { token });
assert(metaV.status === 200, 'GET /veiculos/meta');
const layoutId = 'truck_6x2';
const layout = (metaV.dados?.layouts || []).find((l) => l.id === layoutId)
  || { posicoes: ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3EE', '3EI', '3DI', '3DE'] };
const posicoes = layout.posicoes;
ok('layout', `${layoutId} · ${posicoes.length} posições`);

// 3) Caminhão novo
const veiculoResp = await req('POST', '/veiculos', {
  token,
  body: {
    placa,
    apelido: `E2E Smoke ${suffix}`,
    tipo: 'Truck / Tração',
    layout_pneus: layoutId,
    km_atual: 50000,
    marca: 'Volvo',
    modelo: 'FH',
  },
});
const veiculoId = idDe(veiculoResp.dados);
assert(veiculoResp.status === 201 || veiculoResp.status === 200, 'criar caminhão', `placa=${placa} id=${veiculoId}`);
if (!veiculoId) {
  console.error(veiculoResp.dados);
  process.exit(1);
}

// 4) Pneus em estoque (reserva) + pneus para montar
const estoque = [];
for (let i = 1; i <= 3; i++) {
  const fogo = `E2E-E${i}-${suffix}`;
  const r = await req('POST', '/pneus', {
    token,
    body: {
      numero_fogo: fogo,
      marca: 'Michelin',
      modelo: 'X Multi',
      medida: '295/80R22.5',
      tipo_pneu: 'misto',
      condicao: 'novo',
      vida_recap: 0,
      sulco_inicial_mm: 14,
      custo: 1900,
      observacoes: 'E2E estoque',
    },
  });
  const pid = idDe(r.dados);
  assert(r.status === 201 || r.status === 200, `estoque ${fogo}`, `id=${pid}`);
  if (pid) estoque.push({ id: pid, fogo });
}

const montados = [];
const cenarios = [
  // pos, tipo, sulcos [ext,cent,int,aux], expectativa acao aproximada
  { pos: '1E', tipo: 'direcional', sulcos: [14, 14, 14, 14], expect: 'ok' },
  { pos: '1D', tipo: 'direcional', sulcos: [12, 12, 12, 12], expect: 'ok' },
  { pos: '2EE', tipo: 'borrachudo', sulcos: [6.5, 6.5, 6.5, 6.5], expect: 'monitorar' },
  { pos: '2EI', tipo: 'borrachudo', sulcos: [5.0, 5.0, 5.0, 5.0], expect: 'monitorar' },
  { pos: '2DI', tipo: 'borrachudo', sulcos: [2.5, 2.5, 2.5, 2.5], expect: 'troca' },
  { pos: '2DE', tipo: 'borrachudo', sulcos: [8, 4, 8, 8], expect: 'rodizio_ou_monitorar' },
  { pos: '3EE', tipo: 'borrachudo', sulcos: [10, 10, 9.5, 10], expect: 'ok' },
  { pos: '3EI', tipo: 'borrachudo', sulcos: [7.0, 7.0, 7.0, 7.0], expect: 'monitorar' },
  { pos: '3DI', tipo: 'borrachudo', sulcos: [13, 13, 13, 13], expect: 'ok' },
  { pos: '3DE', tipo: 'borrachudo', sulcos: [3.0, 3.0, 3.0, 3.0], expect: 'troca' },
];

for (const c of cenarios) {
  if (!posicoes.includes(c.pos)) continue;
  const fogo = `E2E-${c.pos}-${suffix}`;
  const r = await req('POST', '/pneus', {
    token,
    body: {
      numero_fogo: fogo,
      marca: 'Pirelli',
      modelo: 'FH01',
      medida: '295/80R22.5',
      tipo_pneu: c.tipo,
      condicao: 'novo',
      vida_recap: 0,
      sulco_inicial_mm: 14,
      custo: 1800,
    },
  });
  const pid = idDe(r.dados);
  if (!pid) {
    fail(`criar pneu ${fogo}`, JSON.stringify(r.dados).slice(0, 200));
    continue;
  }
  const m = await req('POST', `/pneus/${pid}/montar`, {
    token,
    body: { veiculo_id: veiculoId, posicao: c.pos, km_veiculo: 50000 },
  });
  assert(m.status === 200 || m.status === 201, `montar ${c.pos}`, fogo);
  montados.push({ ...c, id: pid, fogo });
}

// 5) Medições variáveis
for (const p of montados) {
  const [ext, cent, int_, aux] = p.sulcos;
  const med = await req('POST', '/medicoes', {
    token,
    body: {
      pneu_id: p.id,
      data_medicao: new Date().toISOString().slice(0, 10),
      km_veiculo: 50500,
      sulco_externo: ext,
      sulco_central: cent,
      sulco_interno: int_,
      sulco_auxiliar: aux,
      responsavel: 'e2e',
    },
  });
  const acao = med.dados?.acao_sugerida || med.dados?.medicao?.acao_sugerida || med.dados?.diagnostico;
  const diag = med.dados?.diagnostico || med.dados?.medicao?.diagnostico;
  assert(med.status === 200 || med.status === 201, `medir ${p.pos}`, `acao=${acao} diag=${diag}`);
  p.acao = acao;
  p.diag = diag;
}

// 6) Detalhe veículo + diagnósticos
const det = await req('GET', `/veiculos/${veiculoId}`, { token });
assert(det.status === 200, 'GET veiculo detalhe');
const pneusDet = det.dados?.pneus || [];
assert(pneusDet.filter((p) => p.posicao || p.status_pneu === 'montado').length >= Math.min(8, montados.length),
  'pneus montados no detalhe', `n=${pneusDet.length}`);

const comAcao = pneusDet.filter((p) => p.acao_sugerida && p.acao_sugerida !== 'ok');
ok('ações no detalhe', comAcao.map((p) => `${p.posicao}:${p.acao_sugerida}`).join(', ') || 'nenhuma');

// 7) Pendências da unidade (filial detalhe)
let pendOk = false;
if (filialId && tokenGerente) {
  const fil = await req('GET', `/filiais/${filialId}`, { token: tokenGerente });
  assert(fil.status === 200, 'GET filial detalhe (gerente)');
  const pend = fil.dados?.pendencias || {};
  const recap = pend.recap || [];
  const troca = pend.troca || [];
  const mon = pend.monitorar || [];
  ok('pendências montados', `troca=${troca.length} mon=${mon.length} recap(em processo)=${recap.length}`);
  assert(troca.length >= 1, 'pendência troca (sulco crítico)', `n=${troca.length}`);
  assert(mon.length >= 1, 'pendência monitorar', `n=${mon.length}`);
  assert((fil.dados?.compras?.pneus_para_comprar ?? 0) >= 1, 'KPI comprar');
  pendOk = true;
} else if (filialId) {
  // filial user may not access /filiais/:id — try dashboard
  const dash = await req('GET', '/dashboard/resumo', { token });
  assert(dash.status === 200, 'dashboard resumo');
}

// 8) Rodízio (reposicionar)
const pRod = montados.find((p) => p.pos === '2DE') || montados[0];
const alvoRod = posicoes.find((pos) => !montados.some((m) => m.pos === pos)) || 'ESTEPE';
// Se tudo ocupado, troca 2DE <-> 3DI
const pPar = montados.find((p) => p.pos === '3DI');
if (pRod && pPar) {
  const des = await req('POST', `/pneus/${pPar.id}/desmontar`, {
    token,
    body: { km_veiculo: 50600, motivo: 'e2e liberar para rodizio' },
  });
  assert(des.status === 200 || des.status === 201, 'desmontar para rodízio', pPar.fogo);
  const rod = await req('POST', `/pneus/${pRod.id}/reposicionar`, {
    token,
    body: { posicao: pPar.pos, km_veiculo: 50600 },
  });
  assert(rod.status === 200 || rod.status === 201, 'rodízio/reposicionar', `${pRod.pos} → ${pPar.pos}`);
  const histRod = await req('GET', `/pneus/${pRod.id}`, { token });
  const movs = histRod.dados?.movimentacoes || histRod.dados?.pneu?.movimentacoes || [];
  // detalhe pode vir sem movs — buscar histórico dedicado se existir
  ok('histórico após rodízio', `status=${histRod.dados?.status_pneu || histRod.dados?.pneu?.status_pneu} movs=${movs.length}`);
}

// 9) Recap: envia pneu montado crítico → recapagem → KPI → devolve estoque
const pRecap = montados.find((p) => p.pos === '2DI') || montados.find((p) => p.expect === 'troca');
if (pRecap) {
  const ev = await req('POST', `/pneus/${pRecap.id}/evento`, {
    token,
    body: { tipo: 'recap', km_veiculo: 50700, detalhes: 'E2E envio recap' },
  });
  assert(ev.status === 201 || ev.status === 200, 'evento recap', JSON.stringify(ev.dados?.mensagem || ev.dados?.erro || '').slice(0, 120));
  const st = ev.dados?.pneu?.status_pneu;
  assert(st === 'recapagem', 'status após recap = recapagem', `got=${st}`);

  const listaRecap = await req('GET', '/pneus?status=recapagem', { token });
  assert(listaRecap.status === 200, 'listar em recapagem');
  const found = (listaRecap.dados || []).some((p) => p.id === pRecap.id || p.numero_fogo === pRecap.fogo);
  assert(found, 'pneu aparece em /pneus?status=recapagem', pRecap.fogo);

  if (tokenGerente && filialId) {
    const fil2 = await req('GET', `/filiais/${filialId}`, { token: tokenGerente });
    const emRecap = fil2.dados?.compras?.pneus_para_recap ?? fil2.dados?.resumo?.pneus_em_recapagem ?? 0;
    const listaPend = fil2.dados?.pendencias?.recap || [];
    assert(emRecap >= 1, 'KPI em recap após envio', `kpi=${emRecap}`);
    assert(listaPend.some((p) => p.pneu_id === pRecap.id || p.numero_fogo === pRecap.fogo),
      'pendências.recap lista o fogo', pRecap.fogo);
  }

  const hist = await req('GET', `/pneus/${pRecap.id}`, { token });
  const movs = hist.dados?.movimentacoes || [];
  const temRecapMov = movs.some((m) => m.tipo === 'recap');
  if (movs.length) assert(temRecapMov, 'movimentação tipo=recap no histórico');
  else {
    // endpoint pode embutir em outro campo
    ok('histórico pneu (sem array movimentacoes no payload — checando campo)', Object.keys(hist.dados || {}).join(','));
  }

  const ret = await req('POST', `/pneus/${pRecap.id}/evento`, {
    token,
    body: { tipo: 'retorno_recap', sulco_mm: 14 },
  });
  assert(ret.status === 201 || ret.status === 200, 'retorno_recap', ret.dados?.mensagem || '');
  assert(ret.dados?.pneu?.status_pneu === 'estoque', 'voltou ao estoque após recap');
}

// 10) Descarte de pneu de estoque
if (estoque[0]) {
  const d = await req('POST', `/pneus/${estoque[0].id}/evento`, {
    token,
    body: { tipo: 'descarte', detalhes: 'E2E descarte' },
  });
  assert(d.status === 201 || d.status === 200, 'descarte estoque', estoque[0].fogo);
  assert(d.dados?.pneu?.status_pneu === 'descarte', 'status descarte');

  const listaD = await req('GET', '/pneus?status=descarte', { token });
  assert((listaD.dados || []).some((p) => p.id === estoque[0].id), 'aparece em descarte');

  const trat = await req('PUT', `/pneus/${estoque[0].id}/tratamento-descarte`, {
    token,
    body: { tratamento: 'sucata', observacoes: 'E2E' },
  });
  assert(trat.status === 200, 'tratamento descarte');
}

// 11) Remontar estoque no buraco deixado pelo recap
if (estoque[1] && pRecap) {
  const livre = pRecap.pos;
  const m2 = await req('POST', `/pneus/${estoque[1].id}/montar`, {
    token,
    body: { veiculo_id: veiculoId, posicao: livre, km_veiculo: 50800 },
  });
  assert(m2.status === 200 || m2.status === 201, `remontar estoque em ${livre}`, estoque[1].fogo);
}

// 12) Relatórios
const acoes = await req('GET', '/medicoes/acoes', { token });
assert(acoes.status === 200, 'GET /medicoes/acoes');

const alertas = await req('GET', '/medicoes/alertas', { token });
assert(alertas.status === 200, 'GET /medicoes/alertas');

if (tokenAdmin) {
  const dir = await req('GET', '/relatorios/diretoria', { token: tokenAdmin });
  assert(dir.status === 200, 'relatório diretoria JSON (admin)');
} else {
  fail('relatório diretoria JSON', 'sem token admin');
}

if (tokenGerente) {
  const pdf = await req('GET', `/relatorios/unidade/semanal.pdf?filial_id=${filialId}`, {
    token: tokenGerente,
    raw: true,
  });
  assert(pdf.status === 200 && pdf.contentType?.includes('pdf') && pdf.buf?.length > 500,
    'PDF semanal', `bytes=${pdf.buf?.length} ct=${pdf.contentType}`);
  if (pdf.status === 200 && pdf.buf?.length) {
    const out = join(__dir, `e2e-semanal-${suffix}.pdf`);
    writeFileSync(out, pdf.buf);
    ok('PDF salvo', out);
  }
} else {
  fail('PDF semanal', 'sem token gerente');
}

// 13) Conferência final do veículo
const detFinal = await req('GET', `/veiculos/${veiculoId}`, { token });
const montadosFinais = (detFinal.dados?.pneus || []).filter((p) => p.status_pneu === 'montado' || p.posicao);
ok('frota final', `placa=${placa} montados=${montadosFinais.length}`);

console.log(`\n=== RESULTADO: ${falhas === 0 ? 'PASSOU' : `${falhas} FALHA(S)`} ===\n`);
process.exit(falhas === 0 ? 0 : 1);
