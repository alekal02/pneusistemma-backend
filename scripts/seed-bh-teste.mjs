/**
 * Carga de teste na filial BH: 10 truck + 10 toco com pneus montados e 20 no estoque.
 * Login da unidade: bhteste / bh123
 *
 *   node scripts/seed-bh-teste.mjs
 */
const BASE = (process.env.API_URL || 'http://localhost:3000/api').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const TRUCK_POS = ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3EE', '3EI', '3DI', '3DE'];
const TOCO_POS = ['1E', '1D', '2EE', '2EI', '2DI', '2DE'];
const MARCAS = [
  { marca: 'Michelin', modelo: 'X Multi D', medida: '295/80R22.5' },
  { marca: 'Goodyear', modelo: 'KMax S', medida: '295/80R22.5' },
  { marca: 'Pirelli', modelo: 'FG01', medida: '275/80R22.5' },
  { marca: 'Bridgestone', modelo: 'R268', medida: '295/80R22.5' },
];

async function req(metodo, caminho, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto.slice(0, 400) }; }
  return { status: res.status, dados };
}

function tipoPneu(pos) {
  return (pos === '1E' || pos === '1D') ? 'direcional' : (pos.endsWith('I') ? 'misto' : 'borrachudo');
}

function spec(i) {
  return MARCAS[i % MARCAS.length];
}

function itensFrota() {
  const itens = [];
  let fogo = 1;

  for (let n = 1; n <= 10; n++) {
    const placa = `BHT1A${String(n).padStart(2, '0')}`;
    const km = String(40000 + n * 1370);
    for (const pos of TRUCK_POS) {
      const p = spec(fogo);
      itens.push({
        status: 'montado',
        placa,
        apelido: `Truck BH ${String(n).padStart(2, '0')}`,
        tipo_veiculo: 'Truck / Tração',
        layout_pneus: 'truck_10',
        km_atual: km,
        hr_atual: String(1800 + n * 40),
        posicao: pos,
        numero_fogo: `BHF${String(fogo).padStart(4, '0')}`,
        tipo_pneu: tipoPneu(pos),
        condicao: 'novo',
        vida_recap: '0',
        marca: p.marca,
        modelo: p.modelo,
        medida: p.medida,
        dot: `122${n % 10}`,
        sulco_inicial_mm: pos.startsWith('1') ? '16' : '18',
        observacoes: `Carga teste BH · ${placa} ${pos}`,
      });
      fogo += 1;
    }
  }

  for (let n = 1; n <= 10; n++) {
    const placa = `BHC1B${String(n).padStart(2, '0')}`;
    const km = String(22000 + n * 890);
    for (const pos of TOCO_POS) {
      const p = spec(fogo);
      itens.push({
        status: 'montado',
        placa,
        apelido: `Toco BH ${String(n).padStart(2, '0')}`,
        tipo_veiculo: 'Toco / Mini',
        layout_pneus: 'toco_6',
        km_atual: km,
        hr_atual: String(900 + n * 25),
        posicao: pos,
        numero_fogo: `BHF${String(fogo).padStart(4, '0')}`,
        tipo_pneu: tipoPneu(pos),
        condicao: 'novo',
        vida_recap: '0',
        marca: p.marca,
        modelo: p.modelo,
        medida: p.medida,
        dot: `032${n % 10}`,
        sulco_inicial_mm: pos.startsWith('1') ? '15' : '17',
        observacoes: `Carga teste BH · ${placa} ${pos}`,
      });
      fogo += 1;
    }
  }

  for (let n = 1; n <= 20; n++) {
    const p = spec(fogo);
    const recap = n % 5 === 0;
    itens.push({
      status: 'estoque',
      numero_fogo: `BHF${String(fogo).padStart(4, '0')}`,
      tipo_pneu: n % 3 === 0 ? 'direcional' : (n % 3 === 1 ? 'misto' : 'borrachudo'),
      condicao: recap ? 'recapado' : 'novo',
      vida_recap: recap ? '1' : '0',
      marca: p.marca,
      modelo: p.modelo,
      medida: p.medida,
      dot: `242${n % 10}`,
      sulco_inicial_mm: recap ? '14' : '16',
      custo: recap ? '920,00' : '1.850,00',
      nota_fiscal: `NF-BH-${String(n).padStart(4, '0')}`,
      observacoes: 'Estoque teste BH',
    });
    fogo += 1;
  }

  return itens;
}

async function main() {
  console.log(`API ${BASE}`);

  const loginAdm = await req('POST', '/auth/login', {
    body: { login: ADMIN_USER, senha: ADMIN_PASS },
  });
  if (loginAdm.status !== 200 || !loginAdm.dados?.token) {
    throw new Error(`Admin não logou: ${loginAdm.status} ${JSON.stringify(loginAdm.dados)}`);
  }
  const adminTok = loginAdm.dados.token;

  const filiaisRes = await req('GET', '/filiais', { token: adminTok });
  const filiais = Array.isArray(filiaisRes.dados) ? filiaisRes.dados : (filiaisRes.dados?.filiais || []);
  console.log('Filiais:', filiais.map((f) => `${f.id} ${f.codigo} ${f.nome}`).join(' | ') || '(nenhuma)');

  let filial = filiais.find((f) => {
    const nome = String(f.nome || '').toLowerCase();
    const codigo = String(f.codigo || '').toUpperCase();
    return codigo === 'BH' || codigo === 'BHZ' || nome.includes('belo horizonte') || /\bbh\b/.test(nome);
  });

  if (!filial) {
    const criou = await req('POST', '/filiais', {
      token: adminTok,
      body: {
        nome: 'Belo Horizonte',
        codigo: 'BH',
        contrato: 'Contrato BH — teste local',
        login: 'bhteste',
        senha: 'bh123',
      },
    });
    if (![200, 201].includes(criou.status)) {
      throw new Error(`Criar filial BH: ${criou.status} ${JSON.stringify(criou.dados)}`);
    }
    filial = criou.dados?.filial || criou.dados;
    console.log('Filial BH criada', filial.id || filial);
  } else {
    console.log(`Filial BH existente id=${filial.id} ${filial.codigo}`);
  }

  const filialId = Number(filial.id || filial.filial_id);
  if (!filialId) throw new Error('Sem id da filial BH');

  const usersRes = await req('GET', '/usuarios', { token: adminTok });
  const usuarios = usersRes.dados?.usuarios || [];
  let user = usuarios.find((u) => String(u.login).toLowerCase() === 'bhteste');

  if (!user) {
    const criouUser = await req('POST', '/usuarios', {
      token: adminTok,
      body: {
        login: 'bhteste',
        senha: 'bh123',
        papel: 'filial',
        filial_id: filialId,
      },
    });
    if (![200, 201].includes(criouUser.status)) {
      throw new Error(`Criar bhteste: ${criouUser.status} ${JSON.stringify(criouUser.dados)}`);
    }
    user = criouUser.dados?.usuario;
    console.log('Usuário bhteste criado');
  } else {
    const reset = await req('POST', `/usuarios/${user.id}/reset-senha`, {
      token: adminTok,
      body: { senha: 'bh123' },
    });
    if (![200, 201].includes(reset.status)) {
      throw new Error(`Reset senha bhteste: ${reset.status} ${JSON.stringify(reset.dados)}`);
    }
    console.log('Senha de bhteste redefinida para bh123');
  }

  const loginBh = await req('POST', '/auth/login', {
    body: { login: 'bhteste', senha: 'bh123' },
  });
  if (loginBh.status !== 200 || !loginBh.dados?.token) {
    throw new Error(`bhteste não logou: ${loginBh.status} ${JSON.stringify(loginBh.dados)}`);
  }
  const tok = loginBh.dados.token;
  console.log('Login bhteste ok, papel', loginBh.dados.usuario?.papel);

  const itens = itensFrota();
  const TAM = 20;
  let veiculos = 0;
  let montados = 0;
  let estoque = 0;
  let erros = [];
  for (let i = 0; i < itens.length; i += TAM) {
    const lote = itens.slice(i, i + TAM);
    const loteN = Math.floor(i / TAM) + 1;
    const imp = await req('POST', '/frota/import', { token: tok, body: { itens: lote } });
    if (![200, 201].includes(imp.status) && !imp.dados?.veiculos && !imp.dados?.pneus_montados) {
      console.error(`Lote ${loteN} falhou`, imp.status, JSON.stringify(imp.dados).slice(0, 400));
      erros = erros.concat(imp.dados?.erros || [{ erro: imp.dados?.erro || 'falha' }]);
      continue;
    }
    veiculos += Number(imp.dados?.veiculos || 0);
    montados += Number(imp.dados?.pneus_montados || 0);
    estoque += Number(imp.dados?.pneus_estoque || 0);
    if (imp.dados?.erros?.length) erros = erros.concat(imp.dados.erros);
    console.log(`Lote ${loteN}: veiculos=${imp.dados?.veiculos || 0} montados=${imp.dados?.pneus_montados || 0} estoque=${imp.dados?.pneus_estoque || 0} erros=${imp.dados?.erros?.length || 0}`);
  }

  const listaV = await req('GET', '/veiculos', { token: tok });
  const veics = Array.isArray(listaV.dados) ? listaV.dados : (listaV.dados?.veiculos || []);
  const pEst = await req('GET', '/pneus?status=estoque', { token: tok });
  const pneusEst = Array.isArray(pEst.dados) ? pEst.dados : (pEst.dados?.pneus || []);
  const pMon = await req('GET', '/pneus?status=montado', { token: tok });
  const pneusMon = Array.isArray(pMon.dados) ? pMon.dados : (pMon.dados?.pneus || []);

  console.log('\n--- Resultado ---');
  console.log(`Veículos importados (novos nesta carga): ${veiculos}`);
  console.log(`Pneus montados importados: ${montados}`);
  console.log(`Pneus estoque importados: ${estoque}`);
  console.log(`GET veículos agora: ${veics.length}`);
  console.log(`GET pneus montados: ${pneusMon.length}`);
  console.log(`GET pneus estoque: ${pneusEst.length}`);
  if (erros.length) {
    console.log(`Erros (${erros.length}):`, JSON.stringify(erros.slice(0, 8)));
  }
  console.log('\nLogin da unidade BH: bhteste / bh123');
  console.log('http://localhost:5173/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
