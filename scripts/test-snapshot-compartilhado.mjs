/**
 * Compartilhamento do snapshot executivo.
 * Banco falso: não abre Neon, não grava e não roda migration.
 *
 * node scripts/test-snapshot-compartilhado.mjs
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { requireLeituraExecutiva } from '../src/auth.js';
import {
  lerFiltrosQuery,
  limparCacheExecutivo,
  obterResumoExecutivo,
  obterSnapshotCompleto,
} from '../src/services/dashboard-executivo.js';
import {
  consultarDiagnosticoExecutivo,
  filtrarFiliaisPorSituacao,
  montarDiagnosticoExecutivo,
} from '../src/services/diagnostico-executivo.js';
import {
  definirRelogioFrotaExecutiva,
  estatisticasFrotaExecutiva,
} from '../src/services/frota-executiva-compartilhada.js';

const POS = ['1E', '1D', '2EE', '2EI', '2DI', '2DE'];
const HOJE = '2026-10-22';
const AGORA = new Date('2026-10-22T15:00:00-03:00');

function filial(id, nome, codigo, ativo, dia) {
  return { id, nome, codigo, ativo, dia_medicao: dia };
}

function veiculo(id, filialId, extra = {}) {
  return {
    id,
    placa: extra.placa || `AAA${id}`,
    apelido: '',
    tipo: extra.tipo || 'Toco / Mini',
    tipo_codigo: extra.tipo_codigo || 'toco_mini',
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
    vida_recap: extra.vida_recap || 0,
    condicao: null,
    recap_enviado_em: null,
    tipo_pneu: null,
    filial_nome: '',
    placa: '',
    apelido: '',
    tipo: 'Toco / Mini',
    tipo_codigo: 'toco_mini',
    layout_pneus: 'toco_6',
    km_atual: extra.km_atual ?? 99999,
    hr_atual: extra.hr_atual ?? 99999,
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
    inspecao_danos: extra.inspecao_danos ?? null,
    data_medicao: extra.data_medicao || '2026-10-20',
  };
}

function jogo(inicioId, filialId, veiculoId, mm, extra = {}) {
  return POS.map((pos, i) => pneu(inicioId + i, filialId, veiculoId, pos, mm, extra));
}

const filiaisPequenas = [
  filial(1, 'Unaí', '0107', 1, 4),
  filial(2, 'Aparecida', '0108', 1, 3),
  filial(3, 'Matriz', 'MATRIZ', 1, 1),
  filial(4, 'E2E antiga', 'E2E9', 0, 2),
];

const veiculosPequenos = [
  veiculo(11, 1, { placa: 'UNA1001', filial_nome: 'Unaí' }),
  veiculo(22, 2, { placa: 'APA2002', filial_nome: 'Aparecida' }),
  veiculo(33, 3, { placa: 'MAT3003', filial_nome: 'Matriz' }),
  veiculo(44, 4, { placa: 'E2E4004', filial_nome: 'E2E antiga' }),
];

const pneusPequenos = [
  pneu(1, 1, 11, '1E', 3, { numero_fogo: 'CRIT-E' }),
  pneu(2, 1, 11, '1D', 3, { numero_fogo: 'CRIT-D' }),
  ...['2EE', '2EI', '2DI', '2DE'].map((pos, i) => pneu(3 + i, 1, 11, pos, 12)),
  pneu(9, 1, null, '', null, { status_pneu: 'estoque', veiculo_ativo: null, veiculo_filial_id: null }),
  ...jogo(20, 2, 22, 12),
  ...jogo(30, 3, 33, 12),
  ...jogo(40, 4, 44, 3),
  pneu(50, 2, 11, 'ESTEPE', 4, { veiculo_filial_id: 1, numero_fogo: 'CRUZADO' }),
];

function universoGrande() {
  const filiais = filiaisPequenas.map((f) => ({ ...f }));
  const veiculos = [];
  const pneus = [];
  let pid = 1000;
  for (const f of filiais) {
    for (let n = 0; n < 40; n += 1) {
      const id = f.id * 1000 + n;
      veiculos.push(veiculo(id, f.id, { placa: `G${id}`, filial_nome: f.nome }));
      pneus.push(...jogo(pid, f.id, id, 12));
      pid += 6;
    }
  }
  return { filiais, veiculos, pneus };
}

function criarDb(dados, { atrasoMs = 0, vagas = 8 } = {}) {
  const contagem = {};
  const chamadas = [];
  let emCurso = 0;
  const fila = [];
  async function ocupar() {
    if (emCurso >= vagas) await new Promise((resolve) => fila.push(resolve));
    emCurso += 1;
  }
  function liberar() {
    emCurso -= 1;
    const proximo = fila.shift();
    if (proximo) proximo();
  }
  function tabela(sql) {
    const s = String(sql).toLowerCase();
    if (s.includes('from filiais')) return 'filiais';
    if (s.includes('from veiculos')) return 'veiculos';
    if (s.includes('from pneus')) return 'pneus';
    if (s.includes('alertas_posicao_vaga')) return 'vagas';
    if (s.includes('from medicoes')) return 'medicoes';
    if (s.includes('from movimentacoes')) return 'movimentacoes';
    return 'outra';
  }
  return {
    contagem,
    chamadas,
    prepare(sql) {
      const nome = tabela(sql);
      return {
        async all(...params) {
          contagem[nome] = (contagem[nome] || 0) + 1;
          chamadas.push({ nome, params });
          await ocupar();
          try {
            if (atrasoMs) await new Promise((resolve) => setTimeout(resolve, atrasoMs));
            if (nome === 'filiais') return dados.filiais.map((f) => ({ ...f }));
            if (nome === 'veiculos') return dados.veiculos.map((v) => ({ ...v }));
            if (nome === 'pneus') return dados.pneus.map((p) => ({ ...p }));
            return [];
          } finally {
            liberar();
          }
        },
        async get(...params) {
          contagem[nome] = (contagem[nome] || 0) + 1;
          chamadas.push({ nome, params, get: true });
          return { c: 0 };
        },
      };
    },
  };
}

function paramsDe(chamadas, nome) {
  return chamadas.filter((c) => c.nome === nome && !c.get).map((c) => c.params);
}

function porta(middleware, user) {
  let status = 0;
  let body = null;
  let seguiu = false;
  const res = {
    status(codigo) { status = codigo; return this; },
    json(valor) { body = valor; return this; },
  };
  middleware({ user }, res, () => { seguiu = true; });
  return { status, body, seguiu };
}

function semGerado(diagnostico) {
  const { gerado_em, ...resto } = diagnostico;
  return resto;
}

const filtros = lerFiltrosQuery({ periodo: '30' }, HOJE);

function esperadoPequeno(incluirMatriz = false) {
  const ativas = filiaisPequenas.filter((f) => f.ativo === 1);
  const ids = new Set(ativas.map((f) => f.id));
  return montarDiagnosticoExecutivo({
    filiais: ativas,
    veiculos: veiculosPequenos.filter((v) => ids.has(v.filial_id)),
    pneus: pneusPequenos
      .filter((p) => p.status_pneu === 'montado' && Number(p.veiculo_ativo) === 1 && ids.has(Number(p.veiculo_filial_id)))
      .map((p) => ({
        id: p.id,
        veiculo_id: p.veiculo_id,
        filial_id: p.filial_id,
        posicao: p.posicao,
        numero_fogo: p.numero_fogo,
        vida_recap: p.vida_recap,
        condicao: p.condicao,
        tipo_pneu: p.tipo_pneu,
        sulco_externo: p.sulco_externo,
        sulco_central: p.sulco_central,
        sulco_interno: p.sulco_interno,
        sulco_auxiliar: p.sulco_auxiliar,
        sulco_mm: p.sulco_mm,
        inspecao_danos: p.inspecao_danos,
        data_medicao: p.data_medicao,
      })),
    incluirMatriz,
    agora: AGORA,
  });
}

limparCacheExecutivo();
definirRelogioFrotaExecutiva(() => 1_000);

const dbRegra = criarDb({ filiais: filiaisPequenas, veiculos: veiculosPequenos, pneus: pneusPequenos });
const [resumo, diagnostico] = await Promise.all([
  obterResumoExecutivo(dbRegra, filtros, HOJE),
  consultarDiagnosticoExecutivo(dbRegra, { escopo: null, incluirMatriz: false }),
]);

assert.deepEqual(paramsDe(dbRegra.chamadas, 'filiais').length, 1);
assert.equal(dbRegra.contagem.filiais, 1);
assert.equal(dbRegra.contagem.veiculos, 1);
assert.equal(dbRegra.contagem.pneus, 1);
assert.equal(dbRegra.contagem.vagas, 1);
assert.deepEqual(paramsDe(dbRegra.chamadas, 'filiais')[0], []);
assert.deepEqual(semGerado(diagnostico), semGerado(esperadoPequeno(false)));

const unai = diagnostico.filiais.find((f) => f.id === 1);
const aparecida = diagnostico.filiais.find((f) => f.id === 2);
assert.equal(diagnostico.filiais.some((f) => f.codigo === 'MATRIZ'), false);
assert.equal(diagnostico.filiais.some((f) => f.codigo === 'E2E9'), false);
assert.equal(unai.situacao, 'critica');
assert.equal(unai.pneus_montados, 7);
assert.equal(unai.pneus_criticos, 2);
assert.equal(unai.pct_critico, 28.6);
assert.equal(aparecida.situacao, 'controlada');
assert.equal(aparecida.pneus_montados, 6);
assert.equal(aparecida.pct_sem_alerta, 100);

const cardUnai = resumo.filiais.find((f) => f.id === 1);
assert.equal(resumo.filiais.some((f) => f.codigo === 'MATRIZ'), false);
assert.equal(resumo.filiais.some((f) => f.codigo === 'E2E9'), false);
assert.equal(cardUnai.pneus_criticos, unai.pneus_criticos);
assert.equal(cardUnai.situacao_executiva, 'critica');
assert.ok(resumo.opcoes.filiais.some((f) => f.codigo === 'MATRIZ'));
const estoque = (resumo.saude.localizacao || []).find((item) => item.id === 'estoque');
assert.equal(estoque.valor, 1);
assert.equal(unai.pneus_montados, 7);

const deNovo = await consultarDiagnosticoExecutivo(dbRegra, { escopo: null, incluirMatriz: false });
assert.equal(dbRegra.contagem.pneus, 1);
assert.equal(deNovo.gerado_em, diagnostico.gerado_em);

const comMatriz = await consultarDiagnosticoExecutivo(dbRegra, { escopo: null, incluirMatriz: true });
assert.equal(comMatriz.filiais.some((f) => f.codigo === 'MATRIZ'), true);
assert.equal(dbRegra.contagem.pneus, 1);

const soCritico = filtrarFiliaisPorSituacao(diagnostico, 'critico');
assert.deepEqual(soCritico.filiais.map((f) => f.id), [1]);

const porTipo = await consultarDiagnosticoExecutivo(dbRegra, { escopo: null, tipo: 'trator', incluirMatriz: false });
assert.equal(porTipo.filiais.every((f) => f.pneus_montados === 0), true);
assert.equal(dbRegra.contagem.pneus, 1);

const filtrosFilial = lerFiltrosQuery({ periodo: '30', filial_id: '1' }, HOJE);
const resumoFilial = await obterResumoExecutivo(dbRegra, filtrosFilial, HOJE);
const diagFilial = await consultarDiagnosticoExecutivo(dbRegra, { escopo: null, filialId: 1, incluirMatriz: false });
assert.deepEqual(diagFilial.filiais.map((f) => f.id), [1]);
assert.deepEqual(resumoFilial.filiais.map((f) => f.id), [1]);
assert.ok(resumoFilial.opcoes.filiais.length > 1);
assert.equal(dbRegra.contagem.pneus, 1, 'filtro de filial reaproveita a frota já lida');

const filtros7 = lerFiltrosQuery({ periodo: '7' }, HOJE);
const resumo7 = await obterResumoExecutivo(dbRegra, filtros7, HOJE);
assert.equal(resumo7.filtros.periodo.modo, '7');
assert.equal(resumo.filtros.periodo.modo, '30');
assert.equal(resumo7.filiais.find((f) => f.id === 1).pneus_criticos, 2);
assert.equal(dbRegra.contagem.pneus, 1, 'trocar o período não relê a frota dentro da validade');

const antesEscopo = dbRegra.contagem.pneus;
const escopo1 = await consultarDiagnosticoExecutivo(dbRegra, { escopo: [1], incluirMatriz: false });
const escopo2 = await consultarDiagnosticoExecutivo(dbRegra, { escopo: [2], incluirMatriz: false });
assert.deepEqual(escopo1.filiais.map((f) => f.id), [1]);
assert.deepEqual(escopo2.filiais.map((f) => f.id), [2]);
assert.equal(dbRegra.contagem.pneus, antesEscopo + 2);
const paramsEscopo = paramsDe(dbRegra.chamadas, 'pneus').slice(-2);
assert.deepEqual(paramsEscopo[0][0], [1]);
assert.deepEqual(paramsEscopo[1][0], [2]);
const escopo1b = await consultarDiagnosticoExecutivo(dbRegra, { escopo: [1], incluirMatriz: false });
assert.equal(escopo1b.filiais[0].nome, 'Unaí');
assert.equal(dbRegra.contagem.pneus, antesEscopo + 2);

const negadoFilial = porta(requireLeituraExecutiva, { papel: 'filial', filial_id: 1 });
const negadoGerente = porta(requireLeituraExecutiva, { papel: 'gerente', filial_id: 1 });
const livreAdmin = porta(requireLeituraExecutiva, { papel: 'admin' });
const livrePresidente = porta(requireLeituraExecutiva, { papel: 'presidente' });
assert.equal(negadoFilial.status, 403);
assert.equal(negadoGerente.status, 403);
assert.equal(livreAdmin.seguiu, true);
assert.equal(livrePresidente.seguiu, true);

definirRelogioFrotaExecutiva(() => 30_000);
const aposValidade = await consultarDiagnosticoExecutivo(dbRegra, { escopo: null, incluirMatriz: false });
assert.equal(dbRegra.contagem.pneus, antesEscopo + 3);
assert.notEqual(aposValidade.gerado_em, diagnostico.gerado_em);
assert.equal(aposValidade.filiais.find((f) => f.id === 1).situacao, 'critica');

const grande = universoGrande();
limparCacheExecutivo();
definirRelogioFrotaExecutiva(() => 1_000);
const dbCarga = criarDb(grande, { atrasoMs: 20, vagas: 3 });
const heap0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
const carga = await Promise.all([
  obterResumoExecutivo(dbCarga, filtros, HOJE),
  consultarDiagnosticoExecutivo(dbCarga, { escopo: null, incluirMatriz: false }),
]);
const msInicial = Math.round(performance.now() - t0);
const heapInicial = process.memoryUsage().heapUsed - heap0;
assert.equal(dbCarga.contagem.filiais, 1);
assert.equal(dbCarga.contagem.veiculos, 1);
assert.equal(dbCarga.contagem.pneus, 1);
assert.equal(carga[0].filiais.length, 2);
assert.equal(carga[1].filiais.length, 2);

limparCacheExecutivo();
const dbConcorrencia = criarDb(grande, { atrasoMs: 15, vagas: 4 });
const heap1 = process.memoryUsage().heapUsed;
const t1 = performance.now();
const pares = await Promise.all(Array.from({ length: 8 }, () => Promise.all([
  obterResumoExecutivo(dbConcorrencia, filtros, HOJE),
  consultarDiagnosticoExecutivo(dbConcorrencia, { escopo: null, incluirMatriz: false }),
])));
const msConcorrencia = Math.round(performance.now() - t1);
const heapConcorrencia = process.memoryUsage().heapUsed - heap1;
assert.equal(dbConcorrencia.contagem.pneus, 1);
assert.equal(dbConcorrencia.contagem.veiculos, 1);
assert.equal(dbConcorrencia.contagem.filiais, 1);
assert.equal(dbConcorrencia.contagem.vagas, 1);
assert.equal(new Set(pares.map((par) => par[1].gerado_em)).size, 1);
assert.ok(msConcorrencia < 1000, `concorrência levou ${msConcorrencia} ms`);

limparCacheExecutivo();
const dbPdf = criarDb(grande, { atrasoMs: 0, vagas: 8 });
await Promise.all([
  obterSnapshotCompleto(dbPdf, filtros, HOJE),
  consultarDiagnosticoExecutivo(dbPdf, { escopo: null, incluirMatriz: false }),
]);
assert.equal(dbPdf.contagem.pneus, 1);
assert.ok((dbPdf.contagem.medicoes || 0) >= 1);

const stats = estatisticasFrotaExecutiva();
console.log(JSON.stringify({
  inicial_ms: msInicial,
  inicial_sql: dbCarga.contagem,
  inicial_heap_mb: Math.round(heapInicial / 1024 / 10) / 100,
  concorrencia_ms: msConcorrencia,
  concorrencia_sql: dbConcorrencia.contagem,
  concorrencia_heap_mb: Math.round(heapConcorrencia / 1024 / 10) / 100,
  rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  leituras_frota: stats.leituras,
  reusos_frota: stats.reusos,
}));

limparCacheExecutivo();
definirRelogioFrotaExecutiva(() => 1_000);
let tentativasPneu = 0;
const dbFalha = {
  prepare(sql) {
    const nome = String(sql).toLowerCase();
    return {
      async all() {
        if (nome.includes('from pneus')) {
          tentativasPneu += 1;
          if (tentativasPneu === 1) throw new Error('leitura indisponível');
        }
        if (nome.includes('from filiais')) return filiaisPequenas.map((f) => ({ ...f }));
        if (nome.includes('from veiculos')) return veiculosPequenos.map((v) => ({ ...v }));
        if (nome.includes('from pneus')) return pneusPequenos.map((p) => ({ ...p }));
        return [];
      },
      async get() { return { c: 0 }; },
    };
  },
};
const falhaA = consultarDiagnosticoExecutivo(dbFalha, { escopo: [1], incluirMatriz: false });
const falhaB = consultarDiagnosticoExecutivo(dbFalha, { escopo: [1], incluirMatriz: false });
await assert.rejects(falhaA, /leitura indisponível/);
await assert.rejects(falhaB, /leitura indisponível/);
assert.equal(estatisticasFrotaExecutiva().emVoo, 0);
assert.equal(tentativasPneu, 1);
const depoisDaFalha = await consultarDiagnosticoExecutivo(dbFalha, { escopo: [1], incluirMatriz: false });
assert.equal(depoisDaFalha.filiais[0].id, 1);
assert.equal(tentativasPneu, 2);
const outroEscopo = await consultarDiagnosticoExecutivo(dbFalha, { escopo: [2], incluirMatriz: false });
assert.equal(outroEscopo.filiais[0].id, 2);
assert.equal(depoisDaFalha.filiais[0].nome, 'Unaí');

definirRelogioFrotaExecutiva(null);
limparCacheExecutivo();
console.log('snapshot compartilhado ok');
