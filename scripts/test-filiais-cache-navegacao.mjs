/**
 * Cache do painel de filiais e memória de navegação.
 * Não abre Neon e não grava dado operacional.
 */
import assert from 'node:assert/strict';
import {
  decidirCargaFiliais,
  gravacaoInvalidaFiliais,
  seloComum,
  chaveMemoriaFiliais,
  criarMemoriaFiliais,
  VALIDADE_NAVEGACAO_FILIAIS_MS,
} from '../../frontend/src/filiais-navegacao.js';
import { limparCacheColunas } from '../src/schema-colunas.js';
import {
  carregarPainelFiliais,
  calcularResumoFilial,
  estatisticasPainelFiliais,
  invalidarPainelFiliais,
  limparCachePainelFiliais,
  revisaoPainelFiliais,
} from '../src/services/filiais-painel.js';
import { definirRelogioFrotaExecutiva } from '../src/services/frota-executiva-compartilhada.js';

let agora = 1_000_000;
definirRelogioFrotaExecutiva(() => agora);

function dbContado() {
  const consultas = [];
  const db = {
    prepare(sql) {
      const texto = String(sql).replace(/\s+/g, ' ').trim();
      return {
        get() {
          consultas.push(texto);
          return Promise.resolve(null);
        },
        all(...params) {
          consultas.push(texto);
          const filial = Number(Array.isArray(params[0]) ? params[0][0] : params[0]);
          if (/FROM veiculos/i.test(texto) && !/JOIN/i.test(texto)) {
            return Promise.resolve(params.map((id) => ({
              id: Number(id) * 10,
              filial_id: Number(id),
              tipo: 'Truck / Tração',
              layout_pneus: 'truck_10',
              km_atual: 1000,
              hr_atual: 0,
            })));
          }
          if (/GROUP BY filial_id/i.test(texto)) {
            return Promise.resolve(params.map((id) => ({
              filial_id: Number(Array.isArray(id) ? id[0] : id),
              em_recapagem: 0,
              em_descarte: 0,
              em_estoque: 0,
            })));
          }
          if (/status_pneu = 'montado'/i.test(texto)) return Promise.resolve([]);
          if (/status_pneu = 'recapagem'/i.test(texto)) return Promise.resolve([]);
          return Promise.resolve([]);
        },
      };
    },
  };
  return { db, consultas };
}

function dados(consultas) {
  return consultas.filter((sql) => /FROM veiculos|FROM pneus|status_pneu = 'recapagem'/i.test(sql));
}

async function testarNavegacao() {
  assert.equal(seloComum(['a', 'a', 'a']), 'a');
  assert.equal(seloComum(['a', 'b', 'a']), null);
  assert.equal(seloComum(['a', null, 'a']), null);
  assert.equal(gravacaoInvalidaFiliais('/api/filiais/3/reset-senha', 'POST'), false);
  assert.equal(gravacaoInvalidaFiliais('/api/filiais/3', 'PUT'), true);
  assert.equal(gravacaoInvalidaFiliais('/api/medicoes', 'POST'), true);
  assert.equal(gravacaoInvalidaFiliais('/api/filiais', 'GET'), false);
  assert.notEqual(
    chaveMemoriaFiliais({ id: 1, papel: 'admin', login: 'admin' }),
    chaveMemoriaFiliais({ id: 2, papel: 'gerente', filial_id: 9, login: 'g' }),
  );

  let relogio = 10_000;
  const memoria = criarMemoriaFiliais(() => relogio);
  memoria.gravar('admin', { revisao: 's1' });
  assert.equal(decidirCargaFiliais({
    salvo: memoria.ler('admin'),
    revisaoAtual: 's1',
    telaPronta: true,
    agora: relogio,
  }), 'reusar');
  assert.equal(decidirCargaFiliais({
    salvo: memoria.ler('admin'),
    revisaoAtual: 's2',
    telaPronta: true,
    agora: relogio,
  }), 'rede');
  assert.equal(decidirCargaFiliais({
    salvo: memoria.ler('admin'),
    revisaoAtual: null,
    redeOk: false,
    telaPronta: true,
    agora: relogio,
  }), 'erro-rede');
  relogio += VALIDADE_NAVEGACAO_FILIAIS_MS;
  assert.equal(memoria.ler('admin', relogio), null);
  assert.equal(decidirCargaFiliais({
    salvo: { revisao: 's1', em: 10_000 },
    revisaoAtual: 's1',
    telaPronta: true,
    agora: relogio,
  }), 'rede');
}

async function testarPainel() {
  limparCacheColunas();
  limparCachePainelFiliais();
  agora = 5_000_000;
  const { db, consultas } = dbContado();

  const antes = consultas.length;
  const [a, b, c] = await Promise.all([
    carregarPainelFiliais(db, [1, 2]),
    carregarPainelFiliais(db, [1, 2]),
    carregarPainelFiliais(db, [1, 2], { comPendencias: true }),
  ]);
  const ida = dados(consultas.slice(antes));
  assert.equal(ida.filter((sql) => /FROM veiculos/i.test(sql) && !/JOIN/i.test(sql)).length, 1);
  assert.equal(ida.filter((sql) => /status_pneu = 'montado'/i.test(sql)).length, 1);
  assert.equal(ida.filter((sql) => /p\.status_pneu = 'recapagem'/i.test(sql)).length, 1);
  assert.equal(a.get(1).veiculos.length, 1);
  assert.equal(b.get(2).veiculos.length, 1);
  assert.equal(c.get(1).veiculos.length, 1);
  assert.equal(c.has(99), false);
  const resumo = calcularResumoFilial(c.get(1));
  assert.equal(resumo.veiculos_ativos, 1);
  assert.equal(resumo.compras.pneus_para_comprar, 0);

  const marca = consultas.length;
  const fatia = await carregarPainelFiliais(db, [1], { comPendencias: true });
  assert.equal(dados(consultas.slice(marca)).length, 0, 'filial já coberta não relê o banco');
  assert.deepEqual([...fatia.keys()], [1]);
  assert.equal(fatia.has(2), false);

  const revisaoAdmin = revisaoPainelFiliais(null);
  const revisao1 = revisaoPainelFiliais([1]);
  const revisao2 = revisaoPainelFiliais([2]);
  invalidarPainelFiliais(2);
  assert.equal(revisaoPainelFiliais([1]), revisao1);
  assert.notEqual(revisaoPainelFiliais([2]), revisao2);
  assert.notEqual(revisaoPainelFiliais(null), revisaoAdmin);

  limparCachePainelFiliais();
  await carregarPainelFiliais(db, [1], { comPendencias: true });
  await carregarPainelFiliais(db, [2], { comPendencias: true });
  const isolado = consultas.length;
  invalidarPainelFiliais(2);
  const so1 = await carregarPainelFiliais(db, [1], { comPendencias: true });
  assert.equal(dados(consultas.slice(isolado)).length, 0, 'invalidar a outra filial preserva esta');
  assert.equal(so1.has(2), false);
  const deNovo2 = await carregarPainelFiliais(db, [2], { comPendencias: true });
  assert.ok(dados(consultas.slice(isolado)).some((sql) => /p\.status_pneu = 'recapagem'/i.test(sql)));
  assert.equal(deNovo2.has(1), false);

  const estavel = revisaoPainelFiliais([2]);
  const antesExpira = consultas.length;
  agora += 21_000;
  await carregarPainelFiliais(db, [2]);
  assert.equal(revisaoPainelFiliais([2]), estavel, 'expirar o cache não finge gravação');
  assert.ok(dados(consultas.slice(antesExpira)).length > 0);

  limparCachePainelFiliais();
  const falho = {
    prepare() {
      return {
        get: () => Promise.resolve(null),
        all: () => Promise.reject(new Error('rede caiu')),
      };
    },
  };
  await assert.rejects(() => carregarPainelFiliais(falho, [7]), /rede caiu/);
  await assert.rejects(() => carregarPainelFiliais(falho, [7]), /rede caiu/);
  const stats = estatisticasPainelFiliais();
  assert.equal(stats.entradas, 0);
  assert.equal(stats.emVoo, 0);
}

await testarNavegacao();
await testarPainel();
console.log('OK filiais cache navegacao');
