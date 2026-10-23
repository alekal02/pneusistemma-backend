/**
 * Invalidação do cache executivo depois de gravação confirmada.
 * Banco falso: não abre Neon, não grava e não roda migration.
 *
 * node scripts/test-invalidacao-executiva.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  lerFiltrosQuery,
  limparCacheExecutivo,
  obterResumoExecutivo,
} from '../src/services/dashboard-executivo.js';
import { consultarDiagnosticoExecutivo } from '../src/services/diagnostico-executivo.js';
import {
  chaveFrotaAtingeFilial,
  estatisticasFrotaExecutiva,
  obterFrotaExecutiva,
} from '../src/services/frota-executiva-compartilhada.js';
import {
  filialConfiavel,
  filialDaGravacao,
  gravacaoAlteraIndicadores,
  invalidarExecutivoAoConfirmar,
  invalidarOperacaoConfirmada,
} from '../src/services/invalidacao-executiva.js';
import { invalidarIndicadoresExecutivos } from '../src/services/dashboard-executivo.js';

const HOJE = '2026-10-22';
const POS = ['1E', '1D', '2EE', '2EI', '2DI', '2DE'];

function filial(id, nome, codigo, ativo, dia) {
  return { id, nome, codigo, ativo, dia_medicao: dia };
}

function veiculo(id, filialId, extra = {}) {
  return {
    id,
    placa: extra.placa || `AAA${id}`,
    apelido: '',
    tipo: 'Toco / Mini',
    tipo_codigo: 'toco_mini',
    layout_pneus: 'toco_6',
    filial_id: filialId,
    km_atual: 5000,
    hr_atual: null,
    ativo: 1,
    dia_medicao: 4,
    cadastro_completo: 1,
    filial_nome: extra.filial_nome || '',
    filial_dia_medicao: 4,
  };
}

function pneu(id, filialId, veiculoId, posicao, mm, extra = {}) {
  return {
    id,
    filial_id: filialId,
    veiculo_id: veiculoId,
    posicao,
    numero_fogo: extra.numero_fogo || `F${id}`,
    status_pneu: extra.status_pneu || 'montado',
    vida_recap: 0,
    condicao: null,
    recap_enviado_em: null,
    tipo_pneu: null,
    filial_nome: '',
    placa: '',
    apelido: '',
    tipo: 'Toco / Mini',
    tipo_codigo: 'toco_mini',
    layout_pneus: 'toco_6',
    km_atual: 99999,
    hr_atual: 99999,
    veiculo_filial_id: extra.veiculo_filial_id ?? filialId,
    veiculo_ativo: extra.veiculo_ativo ?? 1,
    dia_medicao: 4,
    filial_dia_medicao: 4,
    sulco_externo: mm,
    sulco_central: mm,
    sulco_interno: mm,
    sulco_auxiliar: mm,
    sulco_mm: null,
    pressao_psi: null,
    inspecao_danos: null,
    data_medicao: extra.data_medicao || '2026-10-20',
  };
}

function jogo(inicioId, filialId, veiculoId, mm) {
  return POS.map((pos, i) => pneu(inicioId + i, filialId, veiculoId, pos, mm));
}

function universo() {
  return {
    filiais: [
      filial(1, 'Unaí', '0107', 1, 4),
      filial(2, 'Aparecida', '0108', 1, 3),
      filial(3, 'Matriz', 'MATRIZ', 1, 1),
    ],
    veiculos: [
      veiculo(11, 1, { placa: 'UNA1001', filial_nome: 'Unaí' }),
      veiculo(22, 2, { placa: 'APA2002', filial_nome: 'Aparecida' }),
    ],
    pneus: [
      pneu(1, 1, 11, '1E', 3, { numero_fogo: 'CRIT-E' }),
      pneu(2, 1, 11, '1D', 3, { numero_fogo: 'CRIT-D' }),
      ...['2EE', '2EI', '2DI', '2DE'].map((pos, i) => pneu(3 + i, 1, 11, pos, 12)),
      ...jogo(20, 2, 22, 12),
    ],
  };
}

function tabela(sql) {
  const s = String(sql).toLowerCase();
  if (s.includes('from filiais')) return 'filiais';
  if (s.includes('from veiculos')) return 'veiculos';
  if (s.includes('from pneus')) return 'pneus';
  if (s.includes('from medicoes')) return 'medicoes';
  if (s.includes('alertas_posicao_vaga')) return 'vagas';
  return 'outra';
}

function criarDb(dados, { atrasoMs = 0 } = {}) {
  const contagem = {};
  return {
    contagem,
    prepare(sql) {
      const nome = tabela(sql);
      return {
        async all() {
          contagem[nome] = (contagem[nome] || 0) + 1;
          if (atrasoMs) await new Promise((resolve) => setTimeout(resolve, atrasoMs));
          if (nome === 'filiais') return dados.filiais.map((f) => ({ ...f }));
          if (nome === 'veiculos') return dados.veiculos.map((v) => ({ ...v }));
          if (nome === 'pneus') return dados.pneus.map((p) => ({ ...p }));
          return [];
        },
        async get() {
          contagem[nome] = (contagem[nome] || 0) + 1;
          return { c: 0 };
        },
      };
    },
  };
}

function criarDbComTrava(dados) {
  const contagem = {};
  let pneusLidos = 0;
  let liberarPrimeira = () => {};
  const porta = new Promise((resolve) => { liberarPrimeira = resolve; });
  return {
    contagem,
    pneusLidos: () => pneusLidos,
    liberarPrimeira,
    prepare(sql) {
      const nome = tabela(sql);
      return {
        async all() {
          contagem[nome] = (contagem[nome] || 0) + 1;
          const copia = nome === 'filiais'
            ? dados.filiais.map((f) => ({ ...f }))
            : nome === 'veiculos'
              ? dados.veiculos.map((v) => ({ ...v }))
              : nome === 'pneus'
                ? dados.pneus.map((p) => ({ ...p }))
                : [];
          if (nome === 'pneus') {
            pneusLidos += 1;
            if (pneusLidos === 1) await porta;
          }
          return copia;
        },
        async get() {
          contagem[nome] = (contagem[nome] || 0) + 1;
          return { c: 0 };
        },
      };
    },
  };
}

function foto(db) {
  return { ...db.contagem };
}

function delta(antes, depois, nome) {
  return (depois[nome] || 0) - (antes[nome] || 0);
}

function soma(contagem) {
  return Object.values(contagem).reduce((acc, n) => acc + n, 0);
}

function card(resumo, id) {
  return resumo.resumo.cards.find((item) => item.id === id).valor;
}

function filtros(query = {}) {
  return lerFiltrosQuery({ periodo: '30', ...query }, HOJE);
}

function sulco(p, mm) {
  p.sulco_externo = mm;
  p.sulco_central = mm;
  p.sulco_interno = mm;
  p.sulco_auxiliar = mm;
}

function disparar(middleware, req, status) {
  let finish = null;
  const res = {
    statusCode: status,
    on(evento, fn) {
      if (evento === 'finish') finish = fn;
    },
  };
  let seguiu = false;
  middleware(req, res, () => { seguiu = true; });
  assert.equal(seguiu, true);
  assert.equal(typeof finish, 'function');
  finish();
}

async function esperar(pronto) {
  const inicio = Date.now();
  while (!pronto()) {
    if (Date.now() - inicio > 2000) throw new Error('A leitura da frota não começou.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

assert.equal(chaveFrotaAtingeFilial('irrestrito|*', 2), true);
assert.equal(chaveFrotaAtingeFilial('irrestrito|2', 2), true);
assert.equal(chaveFrotaAtingeFilial('irrestrito|1', 2), false);
assert.equal(chaveFrotaAtingeFilial('1|*', 2), false);
assert.equal(chaveFrotaAtingeFilial('1,2|*', 2), true);
assert.equal(chaveFrotaAtingeFilial('1,2|1', 2), false);

assert.equal(gravacaoAlteraIndicadores({ method: 'GET', path: '/' }), false);
assert.equal(gravacaoAlteraIndicadores({ method: 'POST', path: '/2/reset-senha' }), false);
assert.equal(gravacaoAlteraIndicadores({ method: 'POST', path: '/', originalUrl: '/api/filiais/2/reset-senha' }), false);
assert.equal(gravacaoAlteraIndicadores({ method: 'POST', path: '/' }), true);
assert.equal(gravacaoAlteraIndicadores({ method: 'PUT', path: '/9' }), true);
assert.equal(gravacaoAlteraIndicadores({ method: 'DELETE', path: '/9' }), true);
assert.equal(filialDaGravacao({ user: { papel: 'filial', filial_id: 2 } }), 2);
assert.equal(filialDaGravacao({ user: { papel: 'gerente', filial_id: 1 } }), 1);
assert.equal(filialDaGravacao({ user: { papel: 'admin', filial_id: null }, acessoRapido: { filial_id: 2 } }), 2);
assert.equal(filialDaGravacao({ user: { papel: 'admin' } }), null);
assert.equal(filialConfiavel(2), 2);
assert.equal(filialConfiavel('2'), 2);
assert.equal(filialConfiavel(0), null);
assert.equal(filialConfiavel(''), null);
assert.equal(filialConfiavel('2abc'), null);
assert.equal(filialConfiavel(null), null);
assert.equal(filialDaGravacao({ user: { papel: 'gerente', filial_id: 'nao-sei' } }), null);
assert.equal(filialDaGravacao({ user: { papel: 'filial', filial_id: 0 } }), null);

const rotasComInvalidacao = [
  'medicoes.js', 'pneus.js', 'veiculos.js', 'filiais.js',
  'acesso-rapido.js', 'frota.js', 'configuracoes.js', 'dashboard.js',
];
const rotasSemInvalidacao = [
  'auth.js', 'usuarios.js', 'whatsapp.js', 'webhook.js', 'relatorios.js', 'presidente.js',
];
for (const nome of rotasComInvalidacao) {
  const texto = fs.readFileSync(new URL(`../src/routes/${nome}`, import.meta.url), 'utf8');
  assert.equal(texto.includes('invalidarExecutivoAoConfirmar'), true, nome);
}
for (const nome of rotasSemInvalidacao) {
  const texto = fs.readFileSync(new URL(`../src/routes/${nome}`, import.meta.url), 'utf8');
  assert.equal(texto.includes('invalidarExecutivoAoConfirmar'), false, nome);
}

const todas = filtros();
const soUna = filtros({ filial_id: '1' });

// Medição em outra filial: o agregado muda; o recorte da filial que não mediu fica.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  const antes = await obterResumoExecutivo(db, todas, HOJE);
  const criticosAntes = card(antes, 'criticos');
  const unaAntes = await obterResumoExecutivo(db, soUna, HOJE);
  const criticosUna = card(unaAntes, 'criticos');
  const aposCache = foto(db);
  const tCache = performance.now();
  const repetido = await obterResumoExecutivo(db, todas, HOJE);
  const msCache = performance.now() - tCache;
  assert.equal(card(repetido, 'criticos'), criticosAntes);
  assert.equal(delta(aposCache, foto(db), 'pneus'), 0);

  const medido = dados.pneus.find((p) => p.id === 20);
  sulco(medido, 2);
  const semInvalidar = foto(db);
  const aindaVelho = await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(card(aindaVelho, 'criticos'), criticosAntes);
  assert.equal(delta(semInvalidar, foto(db), 'pneus'), 0);

  invalidarIndicadoresExecutivos(2);
  const antesRede = foto(db);
  const tRede = performance.now();
  const novo = await obterResumoExecutivo(db, todas, HOJE);
  const msRede = performance.now() - tRede;
  const depoisRede = foto(db);
  assert.equal(card(novo, 'criticos'), criticosAntes + 1);
  assert.equal(delta(antesRede, depoisRede, 'pneus'), 1);
  assert.equal(delta(antesRede, depoisRede, 'veiculos'), 1);
  assert.equal(delta(antesRede, depoisRede, 'filiais'), 1);

  const unaSql = foto(db);
  const unaDepois = await obterResumoExecutivo(db, soUna, HOJE);
  assert.equal(card(unaDepois, 'criticos'), criticosUna);
  assert.equal(delta(unaSql, foto(db), 'pneus'), 0);

  const diagAntes = foto(db);
  const diag = await consultarDiagnosticoExecutivo(db, {});
  const aparecida = diag.filiais.find((f) => Number(f.id) === 2);
  assert.ok(aparecida);
  assert.equal(aparecida.pneus_criticos, 1);
  assert.equal(delta(diagAntes, foto(db), 'pneus'), 0);

  const bytesAntes = Buffer.byteLength(JSON.stringify(aindaVelho));
  const bytesDepois = Buffer.byteLength(JSON.stringify(novo));
  assert.ok(bytesDepois < bytesAntes * 2);
  console.log(JSON.stringify({
    cenario: 'medicao-filial-2',
    sqlAntesDaInvalidacao: 0,
    sqlDepois: {
      filiais: delta(antesRede, depoisRede, 'filiais'),
      veiculos: delta(antesRede, depoisRede, 'veiculos'),
      pneus: delta(antesRede, depoisRede, 'pneus'),
      vagas: delta(antesRede, depoisRede, 'vagas'),
      medicoes: delta(antesRede, depoisRede, 'medicoes'),
      outra: delta(antesRede, depoisRede, 'outra'),
      total: soma(depoisRede) - soma(antesRede),
    },
    msCache: Number(msCache.toFixed(2)),
    msDepois: Number(msRede.toFixed(2)),
    bytesAntes,
    bytesDepois,
  }));
}

// Movimentação: pneu sai de montado. Recapagem continua fora da contagem de montados.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  const antes = await obterResumoExecutivo(db, todas, HOJE);
  const montados = card(antes, 'montados');
  dados.pneus.find((p) => p.id === 21).status_pneu = 'descarte';
  invalidarIndicadoresExecutivos(2);
  const depois = await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(card(depois, 'montados'), montados - 1);

  dados.pneus.find((p) => p.id === 22).status_pneu = 'recapagem';
  invalidarIndicadoresExecutivos(2);
  const recap = await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(card(recap, 'montados'), montados - 2);
}

// Escopo de outra filial não é derrubado. Agregado que inclui a filial é.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterFrotaExecutiva(db, { escopo: [1] });
  await obterFrotaExecutiva(db, { escopo: [1, 2] });
  const leituras = estatisticasFrotaExecutiva().leituras;
  invalidarIndicadoresExecutivos(2);
  await obterFrotaExecutiva(db, { escopo: [1] });
  assert.equal(estatisticasFrotaExecutiva().leituras, leituras);
  await obterFrotaExecutiva(db, { escopo: [1, 2] });
  assert.equal(estatisticasFrotaExecutiva().leituras, leituras + 1);
}

// Falha, GET e reset de senha não limpam. Sucesso da filial 2 limpa o agregado.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterResumoExecutivo(db, todas, HOJE);
  await obterResumoExecutivo(db, soUna, HOJE);
  const mw = invalidarExecutivoAoConfirmar();
  const baseSql = foto(db);
  disparar(mw, { method: 'GET', path: '/', user: { papel: 'filial', filial_id: 2 } }, 200);
  disparar(mw, { method: 'POST', path: '/', user: { papel: 'filial', filial_id: 2 } }, 500);
  disparar(mw, { method: 'POST', path: '/2/reset-senha', user: { papel: 'admin' } }, 200);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(baseSql, foto(db), 'pneus'), 0);

  disparar(mw, { method: 'POST', path: '/', user: { papel: 'filial', filial_id: 2 } }, 201);
  const depoisFalha = foto(db);
  await obterResumoExecutivo(db, soUna, HOJE);
  assert.equal(delta(depoisFalha, foto(db), 'pneus'), 0);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(depoisFalha, foto(db), 'pneus'), 1);
}

// Admin sem filial no pedido limpa também o recorte da outra unidade.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterResumoExecutivo(db, soUna, HOJE);
  const mw = invalidarExecutivoAoConfirmar();
  disparar(mw, { method: 'PUT', path: '/limites', user: { papel: 'admin' } }, 200);
  const antes = foto(db);
  await obterResumoExecutivo(db, soUna, HOJE);
  assert.equal(delta(antes, foto(db), 'pneus'), 1);
}

// Chamadas simultâneas da mesma chave fazem uma leitura.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados, { atrasoMs: 30 });
  const [a, b] = await Promise.all([
    obterResumoExecutivo(db, todas, HOJE),
    obterResumoExecutivo(db, todas, HOJE),
  ]);
  assert.equal(card(a, 'montados'), card(b, 'montados'));
  assert.equal(db.contagem.pneus, 1);
  assert.equal(db.contagem.veiculos, 1);
  assert.equal(db.contagem.filiais, 1);
}

{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados, { atrasoMs: 30 });
  await Promise.all([
    obterFrotaExecutiva(db, {}),
    obterFrotaExecutiva(db, {}),
  ]);
  assert.equal(db.contagem.pneus, 1);
  assert.ok(estatisticasFrotaExecutiva().reusos >= 1);
  assert.equal(estatisticasFrotaExecutiva().leituras, 1);
}

// Leitura que já estava no ar não regrava o dado antigo por cima da medição.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDbComTrava(dados);
  const primeira = obterResumoExecutivo(db, todas, HOJE);
  await esperar(() => db.pneusLidos() >= 1);
  sulco(dados.pneus.find((p) => p.id === 20), 2);
  invalidarIndicadoresExecutivos(2);
  const segunda = await obterResumoExecutivo(db, todas, HOJE);
  db.liberarPrimeira();
  const velha = await primeira;
  const terceira = await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(card(segunda, 'criticos'), card(velha, 'criticos') + 1);
  assert.equal(card(terceira, 'criticos'), card(segunda, 'criticos'));
  assert.equal(db.contagem.pneus, 2);
}

// A invalidação só ocorre no finish, depois do COMMIT e do status de sucesso.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterResumoExecutivo(db, todas, HOJE);
  let finish = null;
  const res = {
    statusCode: 200,
    on(evento, fn) {
      if (evento === 'finish') finish = fn;
    },
  };
  invalidarExecutivoAoConfirmar()(
    { method: 'POST', path: '/import', user: { papel: 'filial', filial_id: 2 } },
    res,
    () => {},
  );
  const antesDoFinish = foto(db);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(antesDoFinish, foto(db), 'pneus'), 0);
  res.statusCode = 201;
  finish();
  const apos = foto(db);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(apos, foto(db), 'pneus'), 1);
}

// Lote: várias linhas confirmadas na mesma transação geram uma invalidação.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterResumoExecutivo(db, todas, HOJE);
  const mw = invalidarExecutivoAoConfirmar();
  disparar(mw, { method: 'POST', path: '/import', user: { papel: 'filial', filial_id: 2 } }, 201);
  const antes = foto(db);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(antes, foto(db), 'pneus'), 1);
  disparar(mw, { method: 'POST', path: '/import', user: { papel: 'filial', filial_id: 2 } }, 400);
  const depoisFalha = foto(db);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(depoisFalha, foto(db), 'pneus'), 0);
}

// Filial ilegível limpa o agregado e também o recorte de outra unidade.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterResumoExecutivo(db, todas, HOJE);
  await obterResumoExecutivo(db, soUna, HOJE);
  invalidarOperacaoConfirmada('nao-sei');
  const antes = foto(db);
  await obterResumoExecutivo(db, soUna, HOJE);
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(antes, foto(db), 'pneus'), 2);
}

// Presidente em consulta não grava. Recusa 403 não limpa o cache.
{
  limparCacheExecutivo();
  const dados = universo();
  const db = criarDb(dados);
  await obterResumoExecutivo(db, todas, HOJE);
  const antes = foto(db);
  disparar(
    invalidarExecutivoAoConfirmar(),
    { method: 'POST', path: '/', user: { papel: 'presidente' } },
    403,
  );
  await obterResumoExecutivo(db, todas, HOJE);
  assert.equal(delta(antes, foto(db), 'pneus'), 0);
}

const menu = fs.readFileSync(new URL('../src/services/whatsapp-menu.js', import.meta.url), 'utf8');
for (const nome of ['gravarMedicaoConfirmada', 'gravarMovimentacaoConfirmada']) {
  const inicio = menu.indexOf(`async function ${nome}`);
  assert.ok(inicio > 0, nome);
  const corpo = menu.slice(inicio, inicio + 2200);
  assert.ok(corpo.indexOf('await db.transaction') < corpo.indexOf('invalidarOperacaoConfirmada'), nome);
}
assert.ok(menu.includes('invalidarOperacaoConfirmada(ctx.filialId)'));

console.log('invalidacao executiva ok');
