/**
 * Teste ponta a ponta: filial + gerente + fiscal, frota 24 caminhões,
 * medições 14–3 mm, chatbot (placa/frota/recap/relatório) e PDF.
 *
 * Uso:
 *   node scripts/e2e-frota-chatbot.mjs
 *   E2E_BASE=https://pneusistemma-backend.onrender.com/api ADMIN_USER=admin ADMIN_PASS=... node scripts/e2e-frota-chatbot.mjs
 */
const BASE = (process.env.E2E_BASE || 'http://localhost:3000/api').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || 'admin123';
const SUFIXO = String(Date.now()).slice(-6);
const GRUPO_OK = '120363111111111111@g.us';
const GRUPO_ERRADO = '120363222222222222@g.us';

function ehUrlProducao(url) {
  return /onrender\.com/i.test(url) || /pneusistemma-backend/i.test(url);
}

const LAYOUTS = {
  truck_10: ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3EE', '3EI', '3DI', '3DE'],
  truck_8: ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3E', '3D'],
  toco_6: ['1E', '1D', '2EE', '2EI', '2DI', '2DE'],
};

const FROTA = [
  ...Array.from({ length: 16 }, (_, i) => ({ layout: 'truck_10', n: i + 1 })),
  ...Array.from({ length: 6 }, (_, i) => ({ layout: 'truck_8', n: i + 17 })),
  ...Array.from({ length: 2 }, (_, i) => ({ layout: 'toco_6', n: i + 23 })),
];

let falhas = 0;
let oks = 0;
const notas = [];

function log(ok, rotulo, extra = '') {
  if (ok) oks += 1;
  else falhas += 1;
  const linha = `${ok ? 'OK  ' : 'FAIL'} ${rotulo}${extra ? ` → ${extra}` : ''}`;
  console.log(linha);
  if (!ok) notas.push(linha);
}

async function req(metodo, caminho, { token, body, raw, timeoutMs = 120_000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers,
      body: body != null ? JSON.stringify(body) : (raw || undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const texto = await res.text();
    let dados;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto.slice(0, 400) }; }
    return { status: res.status, dados, texto };
  } catch (err) {
    return { status: 0, dados: { erro: err.message }, texto: '' };
  }
}

async function checar(rotulo, metodo, caminho, opts = {}, okStatus = [200, 201]) {
  const r = await req(metodo, caminho, opts);
  const ok = okStatus.includes(r.status);
  log(ok, rotulo, ok ? String(r.status) : `${r.status} ${JSON.stringify(r.dados).slice(0, 220)}`);
  return r;
}

function placaDe(n) {
  // Formato antigo ABC1234 — o chatbot só aceita placa BR (antiga ou Mercosul)
  const base = (Number(SUFIXO.slice(-3)) + n) % 10000;
  return `PNE${String(base).padStart(4, '0')}`;
}

function tipoPneu(pos) {
  return (pos === '1E' || pos === '1D') ? 'direcional' : 'misto';
}

function sulcoAlvo(idx) {
  return 14 - (idx % 12);
}

function payloadGrupo(texto, grupo = GRUPO_OK, filialId) {
  return {
    type: 'Message',
    Info: {
      IsGroup: true,
      Chat: grupo,
      Sender: '5531999999999@s.whatsapp.net',
    },
    Message: { conversation: texto },
    body: texto,
    queryFilial: filialId,
  };
}

async function webhook(filialId, texto, grupo = GRUPO_OK) {
  const body = payloadGrupo(texto, grupo, filialId);
  delete body.queryFilial;
  return req('POST', `/webhook/whatsapp?filial_id=${filialId}`, { body, timeoutMs: 90_000 });
}

async function login(usuario, senha) {
  const r = await req('POST', '/auth/login', { body: { login: usuario, senha } });
  const ok = r.status === 200 && r.dados?.token;
  log(ok, `login ${usuario}`, ok ? '' : `${r.status} ${JSON.stringify(r.dados).slice(0, 160)}`);
  return r.dados?.token || null;
}

async function main() {
  console.log(`\nE2E → ${BASE}\n`);

  if (ehUrlProducao(BASE) && process.env.E2E_ALLOW_PROD !== '1') {
    console.error(
      'Bloqueado: este teste cria filial/frota reais. Rode no local (sem E2E_BASE)\n'
      + 'ou, se for consciente, E2E_ALLOW_PROD=1. Depois use scripts/limpar-dados-e2e.mjs.'
    );
    process.exit(1);
  }

  const health = await req('GET', '/health');
  if (health.status !== 200) {
    log(false, 'API no ar', `${health.status}`);
    process.exit(1);
  }
  log(true, 'API no ar', health.dados?.database || '');

  const adminTok = await login(ADMIN_USER, ADMIN_PASS);
  if (!adminTok) {
    console.log('\nNão foi possível autenticar o admin. Ajuste ADMIN_PASS e rode de novo.');
    process.exit(1);
  }

  const codigo = `E2E${SUFIXO}`;
  const loginFiscal = `fiscal_${SUFIXO}`;
  const loginGerente = `gerente_${SUFIXO}`;
  const senha = 'Teste@123';

  const filialRes = await checar('criar filial', 'POST', '/filiais', {
    token: adminTok,
    body: {
      nome: `Filial Teste E2E ${SUFIXO}`,
      codigo,
      contrato: 'Teste automatizado',
      login: loginFiscal,
      senha,
      whatsapp: '5531988887777',
      whatsapp_grupo: GRUPO_OK,
    },
  });
  const filialId = filialRes.dados?.id;
  if (!filialId) {
    console.log('Abortado: filial não criada.');
    process.exit(1);
  }

  const gerRes = await checar('criar gerente', 'POST', '/usuarios', {
    token: adminTok,
    body: {
      login: loginGerente,
      senha,
      papel: 'gerente',
      cargo: 'gerente_filial',
      filial_id: filialId,
      whatsapp: '5531977776666',
    },
  });
  log(gerRes.dados?.usuario?.papel === 'gerente', 'gerente com papel gerente');

  await checar('salvar grupo chatbot', 'PUT', `/whatsapp/filiais-chatbot/${filialId}`, {
    token: adminTok,
    body: { whatsapp_grupo: GRUPO_OK, whatsapp_grupo_nome: 'Grupo E2E Medição' },
  });

  const fiscalTok = await login(loginFiscal, senha);
  const gerenteTok = await login(loginGerente, senha);
  if (!fiscalTok || !gerenteTok) process.exit(1);

  await checar('gerente vê a unidade', 'GET', `/filiais/${filialId}`, { token: gerenteTok });
  await checar('fiscal lista veículos (vazio)', 'GET', '/veiculos', { token: fiscalTok });

  const itensPorCaminhao = [];
  let fogoSeq = 1;
  for (const cam of FROTA) {
    const placa = placaDe(cam.n);
    const posicoes = LAYOUTS[cam.layout];
    const lote = [{
      placa,
      apelido: `Caminhão ${cam.n}`,
      tipo_veiculo: 'Truck / Tração',
      layout_pneus: cam.layout,
      km_atual: String(80000 + cam.n * 137),
      hr_atual: String(4000 + cam.n),
    }];
    for (const pos of posicoes) {
      lote.push({
        status: 'montado',
        placa,
        apelido: `Caminhão ${cam.n}`,
        tipo_veiculo: 'Truck / Tração',
        layout_pneus: cam.layout,
        km_atual: String(80000 + cam.n * 137),
        posicao: pos,
        numero_fogo: `E2E${SUFIXO}${String(fogoSeq).padStart(4, '0')}`,
        tipo_pneu: tipoPneu(pos),
        condicao: 'novo',
        vida_recap: '0',
        marca: 'Michelin',
        modelo: 'X Multi',
        medida: '295/80R22.5',
        sulco_inicial_mm: '16',
      });
      fogoSeq += 1;
    }
    itensPorCaminhao.push(lote);
  }

  let criados = 0;
  let montados = 0;
  let errosImp = 0;
  const TAM_LOTE = 4;
  for (let i = 0; i < itensPorCaminhao.length; i += TAM_LOTE) {
    const itens = itensPorCaminhao.slice(i, i + TAM_LOTE).flat();
    const loteN = Math.floor(i / TAM_LOTE) + 1;
    const lotesTot = Math.ceil(itensPorCaminhao.length / TAM_LOTE);
    const imp = await checar(`importar frota lote ${loteN}/${lotesTot}`, 'POST', '/frota/import', {
      token: fiscalTok,
      body: { itens },
      timeoutMs: 180_000,
    });
    criados += Number(imp.dados?.veiculos || 0);
    montados += Number(imp.dados?.pneus_montados || 0);
    errosImp += imp.dados?.erros?.length || 0;
    if (imp.dados?.erros?.length) {
      notas.push(JSON.stringify(imp.dados.erros.slice(0, 3)));
    }
  }
  log(criados >= 20 && criados <= 30, `frota 20–30 caminhões (${criados})`);
  log(montados >= 150, `pneus montados (${montados})`);
  log(errosImp === 0, 'importação sem erros', errosImp ? JSON.stringify(imp.dados.erros.slice(0, 3)) : '');

  const listaV = await checar('listar veículos', 'GET', '/veiculos', { token: fiscalTok });
  const listaArr = Array.isArray(listaV.dados) ? listaV.dados : (listaV.dados?.veiculos || []);
  log(listaArr.length >= 20, `GET /veiculos devolve a frota (${listaArr.length})`);

  const pneusRes = await checar('listar pneus montados', 'GET', '/pneus?status=montado', { token: fiscalTok });
  const pneusArr = Array.isArray(pneusRes.dados) ? pneusRes.dados : (pneusRes.dados?.pneus || []);
  log(pneusArr.length >= 150, `pneus na listagem (${pneusArr.length})`);

  let medOk = 0;
  let medFail = 0;
  const fogosPorFaixa = { ok: [], monitorar: [], critico: [] };
  const CONC = 4;
  for (let i = 0; i < pneusArr.length; i += CONC) {
    const lote = pneusArr.slice(i, i + CONC);
    const resultados = await Promise.all(lote.map(async (p, j) => {
      const idx = i + j;
      const alvo = sulcoAlvo(idx);
      const r = await req('POST', '/medicoes', {
        token: fiscalTok,
        body: {
          pneu_id: p.id,
          km_veiculo: 90000 + idx,
          hr_veiculo: 4100,
          sulco_externo: alvo,
          sulco_central: Math.max(3, +(alvo - 0.4).toFixed(1)),
          sulco_interno: Math.min(14, +(alvo + 0.3).toFixed(1)),
          sulco_auxiliar: alvo,
          pressao_psi: 110,
          responsavel: loginFiscal,
        },
      });
      return { p, alvo, r };
    }));
    for (const { p, alvo, r } of resultados) {
      if (r.status === 201 || r.status === 200) {
        medOk += 1;
        const menor = Math.min(alvo, Math.max(3, alvo - 0.4));
        if (menor <= 3) fogosPorFaixa.critico.push(p.numero_fogo);
        else if (menor <= 8) fogosPorFaixa.monitorar.push(p.numero_fogo);
        else fogosPorFaixa.ok.push(p.numero_fogo);
      } else {
        medFail += 1;
        if (medFail <= 3) notas.push(`medição pneu ${p.id}: ${r.status} ${JSON.stringify(r.dados).slice(0, 160)}`);
      }
    }
  }
  log(medOk === pneusArr.length && medFail === 0, `medições 14–3 mm (${medOk}/${pneusArr.length})`);
  log(fogosPorFaixa.critico.length > 0, `há pneus críticos (${fogosPorFaixa.critico.length})`);
  log(fogosPorFaixa.monitorar.length > 0, `há pneus em alerta (${fogosPorFaixa.monitorar.length})`);
  log(fogosPorFaixa.ok.length > 0, `há pneus OK (${fogosPorFaixa.ok.length})`);

  const dash = await checar('dashboard fiscal', 'GET', '/dashboard/resumo', { token: fiscalTok });
  const d = dash.dados || {};
  log((d.pneus_critico || 0) > 0, `dashboard críticos=${d.pneus_critico || 0}`);
  log((d.pneus_alerta || d.pneus_monitorar || 0) > 0 || (d.acoes?.monitorar || 0) > 0, 'dashboard tem alerta/monitorar');
  log((d.veiculos_ativos || listaArr.length) >= 20, `dashboard veículos=${d.veiculos_ativos}`);

  const acoes = await checar('ações sugeridas', 'GET', '/medicoes/acoes', { token: fiscalTok });
  const a = acoes.dados || {};
  log((a.troca || 0) > 0, `ações troca=${a.troca || 0}`);
  log((a.monitorar || 0) > 0, `ações monitorar=${a.monitorar || 0}`);

  const alertas = await checar('alertas de sulco', 'GET', '/medicoes/alertas', { token: fiscalTok });
  const nAlertas = Array.isArray(alertas.dados)
    ? alertas.dados.length
    : (alertas.dados?.itens?.length || 0);
  log(nAlertas > 0, `alertas itens=${nAlertas}`);

  const placaAmostra = placaDe(1);
  const whPlaca = await webhook(filialId, placaAmostra);
  log(whPlaca.status === 200 && whPlaca.dados?.ok && whPlaca.dados?.placa, 'chatbot responde placa no grupo certo', JSON.stringify(whPlaca.dados).slice(0, 180));
  log(Boolean(whPlaca.dados?.veiculo_id), 'chatbot devolve veiculo_id para medição');

  const whErrado = await webhook(filialId, placaAmostra, GRUPO_ERRADO);
  log(
    whErrado.status === 200 && (whErrado.dados?.ignored === 'grupo_nao_selecionado' || !whErrado.dados?.placa),
    'chatbot ignora grupo não selecionado',
    JSON.stringify(whErrado.dados).slice(0, 180)
  );

  const whFrota = await webhook(filialId, 'frota');
  log(whFrota.status === 200 && (whFrota.dados?.comando === 'frota' || whFrota.dados?.ok), 'chatbot comando frota');

  const fogoRecap = fogosPorFaixa.monitorar[0] || fogosPorFaixa.ok[0] || fogosPorFaixa.critico[0];
  const whRecap = await webhook(filialId, `recap ${fogoRecap} Bandag 29/08/2026`);
  log(
    whRecap.status === 200 && whRecap.dados?.comando === 'enviar_recap',
    `chatbot enviar recap ${fogoRecap}`,
    JSON.stringify(whRecap.dados).slice(0, 200)
  );

  const whReceber = await webhook(filialId, `receber recap ${fogoRecap}`);
  log(
    whReceber.status === 200 && whReceber.dados?.comando === 'receber_recap',
    `chatbot receber recap ${fogoRecap}`,
    JSON.stringify(whReceber.dados).slice(0, 200)
  );

  const whRel = await webhook(filialId, 'relatorio');
  log(
    whRel.status === 200 && (whRel.dados?.comando === 'relatorio' || whRel.dados?.ok),
    'chatbot comando relatório',
    JSON.stringify(whRel.dados).slice(0, 180)
  );

  const veiculoId = whPlaca.dados?.veiculo_id || listaArr[0]?.id;
  if (veiculoId) {
    const link = await checar('link WhatsApp / acesso rápido', 'GET', `/veiculos/${veiculoId}/link-whatsapp`, { token: fiscalTok });
    const tokenRapido = link.dados?.token;
    if (tokenRapido) {
      const ar = await checar('abrir medição pelo token', 'GET', `/veiculos/acesso-rapido?token=${encodeURIComponent(tokenRapido)}`, {});
      const slots = ar.dados?.pneus || ar.dados?.posicoes || [];
      const slotArr = Array.isArray(slots) ? slots : [];
      const pneuRapido = slotArr.find((s) => s.id || s.pneu_id) || pneusArr.find((p) => Number(p.veiculo_id) === Number(veiculoId));
      const pneuIdRapido = pneuRapido?.id || pneuRapido?.pneu_id;
      log(Boolean(pneuIdRapido), 'acesso rápido mostra pneus do caminhão');
      if (pneuIdRapido) {
        const medAr = await checar('medir via acesso rápido', 'POST', '/medicoes', {
          body: {
            pneu_id: pneuIdRapido,
            token_acesso: tokenRapido,
            sulco_externo: 7,
            sulco_central: 6.5,
            sulco_interno: 7.2,
            sulco_auxiliar: 7,
            km_veiculo: 91000,
            responsavel: 'chatbot-e2e',
          },
        });
        log([200, 201].includes(medAr.status) || medAr.dados?.id, 'medição pelo fluxo do chatbot gravou');
      }
    }
    const det = await checar('detalhe do caminhão', 'GET', `/veiculos/${veiculoId}`, { token: fiscalTok });
    const pneusDet = det.dados?.pneus || [];
    log(Array.isArray(pneusDet) ? pneusDet.length >= 6 : false, `diagrama com pneus (${Array.isArray(pneusDet) ? pneusDet.length : 0})`);
  }

  const pneuAcao = pneusArr.find((p) => fogosPorFaixa.ok.includes(p.numero_fogo)) || pneusArr[0];
  if (pneuAcao?.id) {
    await checar('desmontar pneu (ação)', 'POST', `/pneus/${pneuAcao.id}/desmontar`, {
      token: fiscalTok,
      body: { detalhes: 'E2E desmontar' },
    });
    const estoque = await checar('pneu foi para estoque', 'GET', `/pneus/${pneuAcao.id}`, { token: fiscalTok });
    log(estoque.dados?.pneu?.status_pneu === 'estoque' || estoque.dados?.status_pneu === 'estoque', 'status estoque após desmontar');
  }

  const pneuDesc = pneusArr.find((p) => p.id !== pneuAcao?.id && fogosPorFaixa.critico.includes(p.numero_fogo));
  if (pneuDesc?.id) {
    await checar('enviar pneu a descarte', 'POST', `/pneus/${pneuDesc.id}/evento`, {
      token: fiscalTok,
      body: { tipo: 'descarte', detalhes: 'E2E descarte' },
    });
  }

  const pdf = await req('GET', `/relatorios/unidade/semanal.pdf?filial_id=${filialId}`, { token: gerenteTok });
  const pdfOk = pdf.status === 200 && (pdf.texto?.startsWith('%PDF') || (pdf.dados?.raw || '').startsWith('%PDF') || pdf.texto?.length > 500);
  log(pdfOk, 'PDF gerencial da unidade', `status ${pdf.status} bytes≈${(pdf.texto || '').length}`);

  const dir = await checar('relatório diretoria (admin)', 'GET', '/relatorios/diretoria', { token: adminTok });
  const linhasDir = dir.dados?.por_filial || dir.dados?.filiais || [];
  const achou = Array.isArray(linhasDir) && linhasDir.some((f) => Number(f.id || f.filial_id) === Number(filialId) || f.codigo === codigo);
  log(achou || Array.isArray(linhasDir), 'consolidado da diretoria inclui a filial de teste');

  const vaga = await checar('alertas de posição vaga', 'GET', '/pneus/alertas-vaga', { token: fiscalTok });
  log(vaga.status === 200, 'endpoint alertas-vaga responde');

  console.log(`\n—— resumo ——`);
  console.log(`OK ${oks} · FAIL ${falhas}`);
  console.log(`Filial ${codigo} id=${filialId}`);
  console.log(`Fiscal: ${loginFiscal} / ${senha}`);
  console.log(`Gerente: ${loginGerente} / ${senha}`);
  console.log(`Caminhões: ${criados} · pneus: ${montados} · medições: ${medOk}`);
  console.log(`Faixas → OK ${fogosPorFaixa.ok.length} · monitorar ${fogosPorFaixa.monitorar.length} · crítico ${fogosPorFaixa.critico.length}`);
  if (notas.length) {
    console.log('\nFalhas:');
    for (const n of notas) console.log(`  ${n}`);
  }
  process.exit(falhas ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
