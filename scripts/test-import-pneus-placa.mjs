/**
 * Importação de pneus com placa: monta no caminhão.
 *   node scripts/test-import-pneus-placa.mjs
 * HTTP local: SKIP_HTTP=1 para pular.
 */
import assert from 'node:assert/strict';
import {
  PNEU_TEMPLATE_HEADERS,
  toCsv,
  parseCsv,
  encaixarPosicaoNoLayout,
} from '../src/csv-utils.js';

let falhas = 0;
let okCount = 0;

async function passo(nome, fn) {
  try {
    await fn();
    okCount += 1;
    console.log(`OK   ${nome}`);
  } catch (err) {
    falhas += 1;
    console.log(`FAIL ${nome} -> ${err.message}`);
  }
}

await passo('modelo CSV inclui placa e posicao', () => {
  const csv = toCsv(PNEU_TEMPLATE_HEADERS, [{
    numero_fogo: 'F-1',
    placa: 'ABC1D23',
    posicao: '1E',
    tipo_pneu: 'direcional',
    condicao: 'novo',
  }]);
  const parsed = parseCsv(csv);
  assert.ok(parsed.headers.includes('placa'));
  assert.ok(parsed.headers.includes('posicao'));
  assert.equal(parsed.rows[0].placa, 'ABC1D23');
  assert.equal(parsed.rows[0].posicao, '1E');
});

await passo('1E em compactador vira DE', () => {
  assert.equal(encaixarPosicaoNoLayout('1E', ['DD', 'DE', 'E2EE']), 'DE');
});

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api';
const tentarHttp = process.env.SKIP_HTTP !== '1';

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

if (tentarHttp) {
  console.log(`\n== HTTP (${BASE}) ==`);
  let apiOk = false;
  try {
    const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    apiOk = health.ok;
  } catch {
    apiOk = false;
  }

  if (!apiOk) {
    console.log('SKIP HTTP — API local não está no ar.');
  } else {
    const adminLogin = await req('POST', '/auth/login', {
      body: { login: 'admin', senha: process.env.ADMIN_PASS || 'admin123' },
    });
    const adminTok = adminLogin.dados?.token;
    if (!adminTok) {
      falhas += 1;
      console.log('FAIL login admin');
    } else {
      const sufixo = String(Date.now()).slice(-4);
      const codigoFilial = `P${sufixo}`.slice(0, 5).toUpperCase();
      const loginFilial = `tplaca_${sufixo}`;
      const criar = await req('POST', '/filiais', {
        token: adminTok,
        body: {
          nome: `Teste import placa ${sufixo}`,
          codigo: codigoFilial,
          login: loginFilial,
          senha: 'teste1234',
        },
      });
      const filialId = criar.dados?.id ?? criar.dados?.filial?.id;
      const loginF = await req('POST', '/auth/login', {
        body: { login: loginFilial, senha: 'teste1234' },
      });
      const tok = loginF.dados?.token;
      const placa = `TST${sufixo}`;

      await passo('cria caminhão e importa pneu montado', async () => {
        assert.ok(tok, 'login filial');
        const v = await req('POST', '/veiculos', {
          token: tok,
          body: { placa, tipo: 'Truck / Tração', layout_pneus: 'truck_10', km_atual: 100 },
        });
        assert.equal(v.status, 201, JSON.stringify(v.dados).slice(0, 200));
        const fogo = `FPL${sufixo}`;
        const imp = await req('POST', '/pneus/import', {
          token: tok,
          body: {
            itens: [
              { numero_fogo: fogo, placa, posicao: '1E', tipo_pneu: 'direcional', condicao: 'novo' },
              { numero_fogo: `FES${sufixo}`, tipo_pneu: 'misto', condicao: 'novo' },
            ],
          },
        });
        assert.ok([200, 201].includes(imp.status), JSON.stringify(imp.dados).slice(0, 300));
        assert.equal(imp.dados.montados, 1, JSON.stringify(imp.dados).slice(0, 300));
        assert.equal(imp.dados.estoque, 1);
        const montado = (imp.dados.detalhes || []).find((d) => d.status_pneu === 'montado');
        assert.equal(montado?.placa, placa);
        assert.equal(montado?.posicao, '1E');

        const lista = await req('GET', '/pneus?status=montado', { token: tok });
        const naFrota = (lista.dados || []).find((p) => p.numero_fogo === fogo);
        assert.ok(naFrota, 'pneu montado aparece na listagem');
        assert.equal(naFrota.status_pneu, 'montado');
        assert.equal(String(naFrota.veiculo_placa || '').toUpperCase(), placa);
      });

      if (filialId) {
        await req('DELETE', `/filiais/${filialId}`, {
          token: adminTok,
          body: { senha_admin: process.env.ADMIN_PASS || 'admin123' },
        });
      }
    }
  }
}

console.log(falhas ? `\n${falhas} FALHA(S) · ${okCount} ok` : `\nTodos os testes passaram (${okCount} ok).`);
process.exit(falhas ? 1 : 0);
