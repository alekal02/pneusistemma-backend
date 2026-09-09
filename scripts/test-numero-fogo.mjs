/**
 * Testes da marca de fogo (padrão 0110-0001) — sem deploy.
 *   node scripts/test-numero-fogo.mjs
 *
 * Cobre: regras puras, gerador com banco falso, botões da UI,
 * e HTTP local (cria unidade temporária e apaga no final).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatarNumeroFogo,
  sequenciaDoPadrao,
  normalizarFogoInformado,
  normalizarCodigoFilial,
  consultarProximoFogo,
  resolverNumeroFogo,
  assertFogoLivre,
  criarGeradorNumeroFogo,
  comRetryFogoUnico,
} from '../src/numero-fogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const codigo = '0110';
let falhas = 0;
let okCount = 0;

function passo(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      okCount += 1;
      console.log(`OK   ${nome}`);
    })
    .catch((err) => {
      falhas += 1;
      console.log(`FAIL ${nome} -> ${err.message}`);
    });
}

function deveLancar(fn, status) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (status != null) assert.equal(err.status, status);
  }
  assert.equal(threw, true);
}

async function deveLancarAsync(fn, status) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    if (status != null) assert.equal(err.status, status);
  }
  assert.equal(threw, true);
}

function dbFake({ codigoFilial = '0110', pneus = [] }) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        async get(...args) {
          if (/FROM filiais/i.test(s)) {
            return codigoFilial ? { id: 1, codigo: codigoFilial } : undefined;
          }
          if (/COUNT\(\*\)/i.test(s)) {
            return { n: pneus.filter((p) => String(p.numero_fogo || '').trim()).length };
          }
          if (/LOWER\(TRIM\(numero_fogo\)\)/i.test(s)) {
            const fogo = String(args[1] || '').trim().toLowerCase();
            const ignorar = /id\s*!=/i.test(s) ? args[2] : null;
            return pneus.find((p) => {
              if (ignorar != null && Number(p.id) === Number(ignorar)) return false;
              return String(p.numero_fogo || '').trim().toLowerCase() === fogo;
            });
          }
          return undefined;
        },
        async all(...args) {
          if (/numero_fogo\s+~\*/i.test(s)) {
            const re = new RegExp(args[1], 'i');
            return pneus
              .filter((p) => re.test(String(p.numero_fogo || '')))
              .map((p) => ({ numero_fogo: p.numero_fogo }));
          }
          return [];
        },
      };
    },
  };
}

console.log('\n== Regras do padrão ==');

await passo('normaliza código da filial', () => {
  assert.equal(normalizarCodigoFilial(' 0110 '), '0110');
});
await passo('formata 0001 / 0012 / 10000', () => {
  assert.equal(formatarNumeroFogo(codigo, 1), '0110-0001');
  assert.equal(formatarNumeroFogo(codigo, 12), '0110-0012');
  assert.equal(formatarNumeroFogo(codigo, 9999), '0110-9999');
  assert.equal(formatarNumeroFogo(codigo, 10000), '0110-10000');
});
await passo('lê sequência do padrão e ignora legado', () => {
  assert.equal(sequenciaDoPadrao('0110-0001', codigo), 1);
  assert.equal(sequenciaDoPadrao('0110-0042', codigo), 42);
  assert.equal(sequenciaDoPadrao('F-1001', codigo), null);
  assert.equal(sequenciaDoPadrao('0220-0001', codigo), null);
});
await passo('completa dígitos e aceita legado', () => {
  assert.equal(normalizarFogoInformado('', codigo), null);
  assert.equal(normalizarFogoInformado('0110', codigo), null);
  assert.equal(normalizarFogoInformado('0001', codigo), '0110-0001');
  assert.equal(normalizarFogoInformado('1', codigo), '0110-0001');
  assert.equal(normalizarFogoInformado('0110-1', codigo), '0110-0001');
  assert.equal(normalizarFogoInformado('F-1001', codigo), 'F-1001');
});
await passo('rejeita sequência 0', () => {
  deveLancar(() => formatarNumeroFogo(codigo, 0), 400);
});

console.log('\n== Banco simulado (botão Gerar / cadastro) ==');

await passo('unidade vazia começa em 0110-0001 e padrão é obrigatório', async () => {
  const info = await consultarProximoFogo(dbFake({ pneus: [] }), 1);
  assert.equal(info.proximo, '0110-0001');
  assert.equal(info.ultimo, null);
  assert.equal(info.padrao_obrigatorio, true);
  assert.equal(info.codigo_filial, '0110');
});

await passo('pula buracos e pega o maior (0001 e 0003 → 0004)', async () => {
  const info = await consultarProximoFogo(dbFake({
    pneus: [
      { id: 1, numero_fogo: '0110-0001' },
      { id: 2, numero_fogo: '0110-0003' },
    ],
  }), 1);
  assert.equal(info.ultimo, '0110-0003');
  assert.equal(info.proximo, '0110-0004');
});

await passo('ignora F-1001 na sequência e começa 0001', async () => {
  const info = await consultarProximoFogo(dbFake({
    pneus: [{ id: 1, numero_fogo: 'F-1001' }, { id: 2, numero_fogo: 'ABC' }],
  }), 1);
  assert.equal(info.proximo, '0110-0001');
  assert.equal(info.padrao_obrigatorio, false);
});

await passo('pneu inativo/descarte não reutiliza o número', async () => {
  const info = await consultarProximoFogo(dbFake({
    pneus: [{ id: 1, numero_fogo: '0110-0001', ativo: 0 }],
  }), 1);
  assert.equal(info.proximo, '0110-0002');
});

await passo('vazio ou só o código gera o próximo', async () => {
  const db = dbFake({ pneus: [{ id: 1, numero_fogo: '0110-0001' }] });
  const a = await resolverNumeroFogo(db, 1, '');
  const b = await resolverNumeroFogo(db, 1, '0110');
  assert.equal(a.numero_fogo, '0110-0002');
  assert.equal(a.gerado, true);
  assert.equal(b.numero_fogo, '0110-0002');
});

await passo('digitar 5 vira 0110-0005', async () => {
  const r = await resolverNumeroFogo(dbFake({ pneus: [] }), 1, '5');
  assert.equal(r.numero_fogo, '0110-0005');
  assert.equal(r.gerado, false);
});

await passo('unidade vazia recusa F-1001 (padrão obrigatório)', async () => {
  await deveLancarAsync(
    () => resolverNumeroFogo(dbFake({ pneus: [] }), 1, 'F-1001'),
    400
  );
});

await passo('unidade com legado ainda aceita F-1001', async () => {
  const r = await resolverNumeroFogo(dbFake({
    pneus: [{ id: 1, numero_fogo: 'F-1001' }],
  }), 1, 'F-2002');
  assert.equal(r.numero_fogo, 'F-2002');
});

await passo('fogo já usado (ativo) bloqueia', async () => {
  await deveLancarAsync(
    () => assertFogoLivre(dbFake({
      pneus: [{ id: 9, numero_fogo: '0110-0001', ativo: 1 }],
    }), 1, '0110-0001'),
    409
  );
});

await passo('gerador CSV aloca 0001, 0002, 0003 em sequência', async () => {
  const g = await criarGeradorNumeroFogo(dbFake({ pneus: [] }), 1);
  assert.equal(g.alocar('').numero_fogo, '0110-0001');
  assert.equal(g.alocar('').numero_fogo, '0110-0002');
  assert.equal(g.alocar('10').numero_fogo, '0110-0010');
  assert.equal(g.alocar('').numero_fogo, '0110-0011');
});

await passo('colisão do número gerado tenta o próximo', async () => {
  const pneus = [];
  const db = dbFake({ pneus });
  let tentativas = 0;
  const out = await comRetryFogoUnico(db, 1, '', async (fogo) => {
    tentativas += 1;
    if (tentativas === 1) {
      pneus.push({ id: 1, numero_fogo: fogo, ativo: 1 });
      const err = new Error('duplicate');
      err.code = '23505';
      throw err;
    }
    return { lastInsertRowid: 2, fogo };
  });
  assert.equal(out.numero_fogo, '0110-0002');
  assert.equal(tentativas, 2);
});

console.log('\n== UI (botão Gerar marca de fogo) ==');

await passo('HTML tem o botão nos 3 cadastros', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'frontend', 'index.html'), 'utf8');
  for (const id of ['btn-gerar-fogo', 'btn-truck-gerar-fogo', 'btn-ar-gerar-fogo']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, /Gerar marca de fogo/);
  }
});

await passo('app.js chama a API de próximo fogo no clique', () => {
  const js = fs.readFileSync(path.join(repoRoot, 'frontend', 'src', 'app.js'), 'utf8');
  assert.match(js, /function gerarMarcaFogoNoCampo/);
  assert.match(js, /\/pneus\/proximo-fogo/);
  assert.match(js, /\/acesso-rapido\/proximo-fogo/);
  assert.match(js, /btn-gerar-fogo/);
  assert.match(js, /mostrarBotaoGerarFogo\(false\)/);
});

await passo('API expõe GET /pneus/proximo-fogo antes de /:id', () => {
  const rotas = fs.readFileSync(path.join(repoRoot, 'backend', 'src', 'routes', 'pneus.js'), 'utf8');
  const iProximo = rotas.indexOf("router.get('/proximo-fogo'");
  const iId = rotas.indexOf("router.get('/:id'");
  assert.ok(iProximo > 0 && iProximo < iId, 'proximo-fogo precisa vir antes de /:id');
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
  console.log(`\n== HTTP local (${BASE}) ==`);
  let apiOk = false;
  try {
    const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    apiOk = health.ok;
  } catch {
    apiOk = false;
  }

  if (!apiOk) {
    console.log('SKIP HTTP — API local não está no ar (subimos só os testes sem servidor).');
  } else {
    const adminLogin = await req('POST', '/auth/login', {
      body: { login: 'admin', senha: process.env.ADMIN_PASS || 'admin123' },
    });
    const adminTok = adminLogin.dados?.token;
    if (!adminTok) {
      falhas += 1;
      console.log(`FAIL login admin -> ${JSON.stringify(adminLogin.dados).slice(0, 200)}`);
    } else {
      const sufixo = String(Date.now()).slice(-4);
      const codigoFilial = `T${sufixo}`.slice(0, 5).toUpperCase();
      const loginFilial = `tfogo_${sufixo}`;
      const senhaFilial = 'teste1234';
      let filialId = null;

      const criar = await req('POST', '/filiais', {
        token: adminTok,
        body: {
          nome: `Teste marca fogo ${sufixo}`,
          codigo: codigoFilial,
          login: loginFilial,
          senha: senhaFilial,
        },
      });
      filialId = criar.dados?.id ?? criar.dados?.filial?.id ?? criar.dados?.filial_id;
      if (criar.status !== 201 || !filialId) {
        falhas += 1;
        console.log(`FAIL criar filial teste -> ${criar.status} ${JSON.stringify(criar.dados).slice(0, 240)}`);
      } else {
        console.log(`OK   filial temporária ${codigoFilial} id=${filialId}`);
        const loginF = await req('POST', '/auth/login', {
          body: { login: loginFilial, senha: senhaFilial },
        });
        const tok = loginF.dados?.token;
        if (!tok) {
          falhas += 1;
          console.log(`FAIL login filial teste -> ${JSON.stringify(loginF.dados).slice(0, 200)}`);
        } else {
          const esperado1 = `${codigoFilial}-0001`;
          const esperado2 = `${codigoFilial}-0002`;
          const esperado3 = `${codigoFilial}-0003`;

          await passo(`GET proximo-fogo vazio = ${esperado1}`, async () => {
            const { status, dados } = await req('GET', '/pneus/proximo-fogo', { token: tok });
            assert.equal(status, 200);
            assert.equal(dados.proximo, esperado1);
            assert.equal(dados.padrao_obrigatorio, true);
            assert.equal(dados.codigo_filial, codigoFilial);
          });

          await passo('POST estoque sem fogo gera 0001', async () => {
            const { status, dados } = await req('POST', '/pneus', {
              token: tok,
              body: { modelo: 'TesteAuto', tipo_pneu: 'misto', condicao: 'novo' },
            });
            assert.equal(status, 201, JSON.stringify(dados).slice(0, 200));
            assert.equal(dados.pneu?.numero_fogo, esperado1);
          });

          await passo(`GET proximo-fogo depois do 1º = ${esperado2}`, async () => {
            const { status, dados } = await req('GET', '/pneus/proximo-fogo', { token: tok });
            assert.equal(status, 200);
            assert.equal(dados.proximo, esperado2);
            assert.equal(dados.ultimo, esperado1);
          });

          await passo('POST com só a sequência 2 vira 0002', async () => {
            const { status, dados } = await req('POST', '/pneus', {
              token: tok,
              body: { modelo: 'TesteAuto', numero_fogo: '2', tipo_pneu: 'misto', condicao: 'novo' },
            });
            assert.equal(status, 201, JSON.stringify(dados).slice(0, 200));
            assert.equal(dados.pneu?.numero_fogo, esperado2);
          });

          await passo('POST F-1001 é recusado nesta unidade nova', async () => {
            const { status, dados } = await req('POST', '/pneus', {
              token: tok,
              body: { modelo: 'TesteAuto', numero_fogo: 'F-1001', tipo_pneu: 'misto', condicao: 'novo' },
            });
            assert.equal(status, 400);
            assert.match(String(dados.erro || ''), /padrão/i);
          });

          await passo('import CSV sem fogo gera o próximo', async () => {
            const { status, dados } = await req('POST', '/pneus/import', {
              token: tok,
              body: { itens: [{ modelo: 'CsvAuto', tipo_pneu: 'misto', condicao: 'novo' }] },
            });
            assert.ok([200, 201].includes(status), JSON.stringify(dados).slice(0, 200));
            assert.equal(dados.detalhes?.[0]?.numero_fogo, esperado3);
          });
        }

        const apagar = await req('DELETE', `/filiais/${filialId}`, {
          token: adminTok,
          body: { senha_admin: process.env.ADMIN_PASS || 'admin123' },
        });
        if (![200, 201].includes(apagar.status)) {
          falhas += 1;
          console.log(`FAIL limpar filial teste -> ${apagar.status} ${JSON.stringify(apagar.dados).slice(0, 240)}`);
        } else {
          console.log('OK   filial temporária removida');
        }
      }
    }
  }
}

console.log(falhas ? `\n${falhas} FALHA(S) · ${okCount} ok` : `\nTodos os testes passaram (${okCount} ok).`);
process.exit(falhas ? 1 : 0);
