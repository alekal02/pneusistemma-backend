/**
 * Smoke test HTTP das rotas migradas para PostgreSQL.
 * Uso: node scripts/smoke-api.mjs
 */
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api';

let falhas = 0;

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

async function checar(rotulo, metodo, caminho, opts = {}, okStatus = [200, 201]) {
  const { status, dados } = await req(metodo, caminho, opts);
  const ok = okStatus.includes(status);
  if (!ok) falhas += 1;
  const detalhe = ok ? '' : ` -> ${JSON.stringify(dados).slice(0, 300)}`;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${status} ${rotulo}${detalhe}`);
  return dados;
}

async function login(usuario, senha) {
  const { status, dados } = await req('POST', '/auth/login', { body: { login: usuario, senha } });
  if (status !== 200) {
    falhas += 1;
    console.log(`FAIL ${status} login ${usuario} -> ${JSON.stringify(dados).slice(0, 200)}`);
    return null;
  }
  console.log(`OK   200 login ${usuario}`);
  return dados.token;
}

const admin = await login('admin', process.env.ADMIN_PASS || 'admin123');
const filial = await login('matriz', 'matriz123');
const gerente = await login('gerente_matriz', 'gerente123');
const compras = await login('compras', 'compras123');

if (admin) {
  await checar('GET /auth/me', 'GET', '/auth/me', { token: admin });
  await checar('GET /configuracoes', 'GET', '/configuracoes', { token: admin });
  await checar('PUT /configuracoes', 'PUT', '/configuracoes', {
    token: admin,
    body: { sulco_critico_mm: 3, sulco_alerta_mm: 8 },
  });
  await checar('GET /usuarios', 'GET', '/usuarios', { token: admin });
  await checar('GET /filiais', 'GET', '/filiais', { token: admin });
  await checar('GET /relatorios/diretoria', 'GET', '/relatorios/diretoria', { token: admin });
  await checar('GET /relatorios/diretoria.csv', 'GET', '/relatorios/diretoria.csv', { token: admin });
  await checar('GET /whatsapp/destinatarios', 'GET', '/whatsapp/destinatarios', { token: admin });
  await checar('GET /whatsapp/filiais-chatbot', 'GET', '/whatsapp/filiais-chatbot', { token: admin });
}

if (gerente) {
  await checar('GET /filiais (gerente)', 'GET', '/filiais', { token: gerente });
  await checar('GET /usuarios (gerente)', 'GET', '/usuarios', { token: gerente });
}

if (compras) {
  await checar('GET /filiais/compras/consolidado', 'GET', '/filiais/compras/consolidado', { token: compras });
}

let veiculoId = null;
let pneuId = null;

if (filial) {
  await checar('GET /dashboard/resumo', 'GET', '/dashboard/resumo', { token: filial });
  await checar('GET /veiculos/meta', 'GET', '/veiculos/meta', { token: filial });
  await checar('GET /veiculos', 'GET', '/veiculos', { token: filial });
  await checar('GET /pneus/meta', 'GET', '/pneus/meta', { token: filial });
  await checar('GET /pneus/proximo-fogo', 'GET', '/pneus/proximo-fogo', { token: filial });
  await checar('GET /pneus', 'GET', '/pneus', { token: filial });
  await checar('GET /medicoes/alertas', 'GET', '/medicoes/alertas', { token: filial });
  await checar('GET /medicoes/acoes', 'GET', '/medicoes/acoes', { token: filial });

  const placa = `SMK${Math.floor(Math.random() * 9000 + 1000)}`;
  const veiculo = await checar('POST /veiculos', 'POST', '/veiculos', {
    token: filial,
    body: { placa, tipo: 'Truck / Tração', layout_pneus: 'truck_6x2', km_atual: 1000 },
  });
  veiculoId = veiculo?.id ?? veiculo?.veiculo?.id;

  if (veiculoId) {
    await checar('GET /veiculos/:id', 'GET', `/veiculos/${veiculoId}`, { token: filial });
    await checar('GET /veiculos/:id/link-whatsapp', 'GET', `/veiculos/${veiculoId}/link-whatsapp`, { token: filial });
    await checar('PUT /veiculos/:id', 'PUT', `/veiculos/${veiculoId}`, {
      token: filial,
      body: { apelido: 'Smoke', km_atual: 1500 },
    });

    const fogo = `SMKF${Math.floor(Math.random() * 90000 + 10000)}`;
    const pneu = await checar('POST /pneus', 'POST', '/pneus', {
      token: filial,
      body: {
        numero_fogo: fogo,
        marca: 'Smoke',
        modelo: 'SmokeModel',
        medida: '295/80R22.5',
        tipo_pneu: 'direcional',
        condicao: 'novo',
        sulco_inicial_mm: 14,
      },
    });
    pneuId = pneu?.id ?? pneu?.pneu?.id;

    if (pneuId) {
      await checar('GET /pneus/:id', 'GET', `/pneus/${pneuId}`, { token: filial });
      await checar('PUT /pneus/:id', 'PUT', `/pneus/${pneuId}`, {
        token: filial, body: { marca: 'Smoke2' },
      });
      await checar('POST /pneus/:id/montar', 'POST', `/pneus/${pneuId}/montar`, {
        token: filial, body: { veiculo_id: veiculoId, posicao: '1E', km_veiculo: 1600 },
      });
      await checar('POST /medicoes', 'POST', '/medicoes', {
        token: filial,
        body: { pneu_id: pneuId, sulco_externo: 9, sulco_central: 9, sulco_interno: 9, km_veiculo: 1700 },
      });
      await checar('POST /pneus/:id/reposicionar', 'POST', `/pneus/${pneuId}/reposicionar`, {
        token: filial, body: { posicao: '1D' },
      });
      await checar('POST /pneus/:id/desmontar', 'POST', `/pneus/${pneuId}/desmontar`, {
        token: filial, body: { km_veiculo: 1800, motivo: 'smoke' },
      });
      await checar('POST /pneus/:id/evento (recap)', 'POST', `/pneus/${pneuId}/evento`, {
        token: filial, body: { tipo: 'recap' },
      });
      await checar('POST /pneus/:id/evento (descarte)', 'POST', `/pneus/${pneuId}/evento`, {
        token: filial, body: { tipo: 'descarte', detalhes: 'smoke' },
      });
    }

    // Fluxo de acesso rápido (link do WhatsApp): token → detalhe → medição sem login
    const linkResp = await checar('GET /veiculos/:id/link-whatsapp (token)', 'GET', `/veiculos/${veiculoId}/link-whatsapp`, { token: filial });
    const tokenRapido = linkResp?.token || String(linkResp?.link || '').split('/').pop();
    if (tokenRapido) {
      const detalhe = await checar('GET /veiculos/acesso-rapido', 'GET', `/veiculos/acesso-rapido?token=${tokenRapido}`);
      const pneuRapido = detalhe?.pneus?.find((p) => p.pneu_id || p.id);
      if (pneuRapido) {
        await checar('POST /medicoes (acesso rápido)', 'POST', '/medicoes', {
          body: {
            token_acesso: tokenRapido,
            pneu_id: pneuRapido.pneu_id || pneuRapido.id,
            sulco_externo: 7,
            sulco_central: 7,
            sulco_interno: 7,
          },
        });
      }
      await checar('POST /veiculos/acesso-rapido/montar-novo', 'POST', '/veiculos/acesso-rapido/montar-novo', {
        body: {
          token: tokenRapido,
          posicao: '2EE',
          numero_fogo: `RAP${Math.floor(Math.random() * 90000 + 10000)}`,
          marca: 'Smoke',
          modelo: 'SmokeModel',
          medida: '295/80R22.5',
          tipo_pneu: 'borrachudo',
          condicao: 'novo',
          sulco_inicial_mm: 14,
        },
      });
    }

    await checar('POST /veiculos/import', 'POST', '/veiculos/import', {
      token: filial,
      body: {
        itens: [
          { placa: `IMP${Math.floor(Math.random() * 9000 + 1000)}`, tipo_veiculo: 'Truck / Tração', layout_pneus: 'truck_6x2', km_atual: '10' },
        ],
      },
    });

    await checar('POST /frota/import', 'POST', '/frota/import', {
      token: filial,
      body: {
        itens: [
          { placa: `FRT${Math.floor(Math.random() * 9000 + 1000)}`, tipo_veiculo: 'Truck / Tração', layout_pneus: 'truck_6x2', km_atual: '10' },
          { numero_fogo: `FRTF${Math.floor(Math.random() * 90000 + 10000)}`, marca: 'Smoke', condicao: 'novo', status: 'estoque' },
        ],
      },
    });

    await checar('POST /pneus/import', 'POST', '/pneus/import', {
      token: filial,
      body: {
        itens: [
          { numero_fogo: `PNI${Math.floor(Math.random() * 90000 + 10000)}`, marca: 'Smoke', condicao: 'novo', sulco_inicial_mm: '14' },
        ],
      },
    });

    const placaMontagem = veiculo?.placa || placa;
    const impMontado = await checar('POST /pneus/import (placa+posicao)', 'POST', '/pneus/import', {
      token: filial,
      body: {
        itens: [
          {
            numero_fogo: `PNM${Math.floor(Math.random() * 90000 + 10000)}`,
            placa: placaMontagem,
            posicao: '2EI',
            marca: 'Smoke',
            tipo_pneu: 'borrachudo',
            condicao: 'novo',
            sulco_inicial_mm: '14',
          },
        ],
      },
    });
    if (impMontado && impMontado.montados !== 1 && impMontado.detalhes?.[0]?.status_pneu !== 'montado') {
      console.log('FAIL import com placa não montou', JSON.stringify(impMontado).slice(0, 300));
    }

    await checar('DELETE /veiculos/:id', 'DELETE', `/veiculos/${veiculoId}`, { token: filial });
  }
}

if (admin) {
  const dest = await checar('POST /whatsapp/destinatarios', 'POST', '/whatsapp/destinatarios', {
    token: admin,
    body: { nome: 'Smoke', whatsapp: `4899${Math.floor(Math.random() * 9000000 + 1000000)}` },
  });
  if (dest?.id) {
    await checar('PUT /whatsapp/destinatarios/:id', 'PUT', `/whatsapp/destinatarios/${dest.id}`, {
      token: admin, body: { nome: 'Smoke 2' },
    });
    await checar('DELETE /whatsapp/destinatarios/:id', 'DELETE', `/whatsapp/destinatarios/${dest.id}`, { token: admin });
  }
  await checar('GET /whatsapp/filial/1/config', 'GET', '/whatsapp/filial/1/config', { token: admin });
  await checar('GET /whatsapp/filial/1/envios', 'GET', '/whatsapp/filial/1/envios', { token: admin });
  await checar('GET /filiais/1/resumo', 'GET', '/filiais/1/resumo', { token: admin });
  await checar('GET /filiais/1', 'GET', '/filiais/1', { token: admin });
}

await checar('POST /webhook/whatsapp', 'POST', '/webhook/whatsapp', {
  body: { event: 'Message', data: { from: '5548999999999@s.whatsapp.net', message: { conversation: 'frota' } } },
});

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(falhas ? 1 : 0);
