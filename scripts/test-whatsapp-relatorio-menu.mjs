/**
 * Menu de relatório do WhatsApp usa o catálogo de equipamentos.
 * Sem banco: node scripts/test-whatsapp-relatorio-menu.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EQUIPAMENTO_TIPOS } from '../src/equipamento-tipos.js';
import {
  gerarPdfRelatorioSemanal,
  resolverFiltroRelatorio,
  veiculoPassaFiltroRelatorio,
} from '../src/services/relatorio-semanal-pdf.js';
import { linhasTabelaFrota, veiculosComDiagrama } from '../src/services/relatorio-frota-visual-pdf.js';
import { parseComandoNatural } from '../src/services/whatsapp-comandos.js';
import {
  opcoesMenuRelatorio,
  textoMenu,
  textoTiposRelatorio,
  tipoRelatorioDaResposta,
} from '../src/services/whatsapp-menu.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const menuSrc = fs.readFileSync(path.join(root, 'src/services/whatsapp-menu.js'), 'utf8');

const opcoes = opcoesMenuRelatorio();
assert.deepEqual(opcoes.slice(0, 5).map((o) => o.id), [
  'todos',
  'caminhao_compactador',
  'trator',
  'mini_carregadeira',
  'giro_zero',
]);
assert.equal(opcoes[1].label, 'Caminhão/Compactador');
const extrasCatalogo = EQUIPAMENTO_TIPOS
  .map((t) => t.codigo)
  .filter((codigo) => !['trator', 'mini_carregadeira', 'giro_zero'].includes(codigo));
assert.deepEqual(opcoes.slice(5).map((o) => o.id), extrasCatalogo);

const texto = textoTiposRelatorio();
assert.ok(texto.includes('2️⃣ Caminhão/Compactador'));
assert.ok(texto.includes('caminhao, caminhoes e caminhao/compactador'));
for (const t of EQUIPAMENTO_TIPOS) {
  assert.ok(texto.includes(t.label), `menu sem ${t.label}`);
}
assert.ok(texto.includes('Truck / Tração'));
assert.ok(texto.includes('Trator'));
assert.ok(texto.includes('Mini carregadeira'));
assert.ok(texto.includes('Giro zero'));

const porNumero = Object.fromEntries(opcoes.map((o, i) => [String(i + 1), o.id]));
assert.equal(porNumero['1'], 'todos');
assert.equal(porNumero['2'], 'caminhao_compactador');
assert.equal(porNumero['3'], 'trator');
assert.equal(porNumero['4'], 'mini_carregadeira');
assert.equal(porNumero['5'], 'giro_zero');
for (const [n, id] of Object.entries(porNumero)) {
  assert.equal(tipoRelatorioDaResposta(String(n)), id, `opção ${n}`);
}
assert.equal(tipoRelatorioDaResposta('0'), null);
assert.equal(tipoRelatorioDaResposta('99'), null);
assert.equal(tipoRelatorioDaResposta('xyz'), null);

assert.equal(tipoRelatorioDaResposta('todos'), 'todos');
assert.equal(tipoRelatorioDaResposta('trator'), 'trator');
assert.equal(tipoRelatorioDaResposta('skid'), 'mini_carregadeira');
assert.equal(tipoRelatorioDaResposta('giro'), 'giro_zero');
assert.equal(tipoRelatorioDaResposta('truck'), 'truck_tracao');
assert.equal(tipoRelatorioDaResposta('compactador'), 'compactador');
assert.equal(tipoRelatorioDaResposta('Toco / Mini'), 'toco_mini');

const frasesGrupo = ['caminhao', 'caminhoes', 'caminhao/compactador', 'Caminhão/Compactador'];
const filtroGrupoDireto = resolverFiltroRelatorio('caminhao_compactador');
for (const frase of frasesGrupo) {
  const id = tipoRelatorioDaResposta(frase);
  assert.equal(id, 'caminhao_compactador', frase);
  const peloMenu = resolverFiltroRelatorio(id);
  const peloTexto = resolverFiltroRelatorio(frase);
  assert.equal(peloMenu.id, peloTexto.id, frase);
  assert.deepEqual(peloMenu.codigos, peloTexto.codigos, frase);
  assert.deepEqual(peloMenu.codigos, filtroGrupoDireto.codigos, frase);
}
assert.deepEqual(filtroGrupoDireto.codigos, ['compactador', 'truck_tracao', 'toco_mini', 'utilitario']);

for (const id of opcoes.map((o) => o.id)) {
  const filtro = resolverFiltroRelatorio(tipoRelatorioDaResposta(id) || id);
  assert.equal(filtro.id, id);
  if (id === 'todos') assert.equal(filtro.codigos, null);
  else if (id === 'caminhao_compactador') assert.deepEqual(filtro.codigos, filtroGrupoDireto.codigos);
  else assert.deepEqual(filtro.codigos, [id]);
}

const grupo = resolverFiltroRelatorio(tipoRelatorioDaResposta('2'));
assert.equal(grupo.id, 'caminhao_compactador');
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Compactador' }, grupo.id), true);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Truck / Tração' }, grupo.id), true);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Trator' }, grupo.id), false);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Compactador' }, 'caminhao'), true);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Trator' }, 'caminhoes'), false);

const frota = [
  { filial_id: 1, ativo: 1, tipo: 'Compactador', tipo_codigo: 'compactador', placa: 'A1' },
  { filial_id: 1, ativo: 1, tipo: 'Trator', tipo_codigo: 'trator', placa: 'T1' },
  { filial_id: 2, ativo: 1, tipo: 'Compactador', tipo_codigo: 'compactador', placa: 'B1' },
  { filial_id: 1, ativo: 0, tipo: 'Truck / Tração', tipo_codigo: 'truck_tracao', placa: 'X1' },
];
function frotaDaUnidade(filialId, tipo) {
  return frota.filter((v) => v.filial_id === filialId && v.ativo === 1 && veiculoPassaFiltroRelatorio(v, tipo));
}
assert.deepEqual(frotaDaUnidade(1, tipoRelatorioDaResposta('caminhao')).map((v) => v.placa), ['A1']);
assert.deepEqual(frotaDaUnidade(2, tipoRelatorioDaResposta('caminhoes')).map((v) => v.placa), ['B1']);
assert.deepEqual(frotaDaUnidade(1, tipoRelatorioDaResposta('3')).map((v) => v.placa), ['T1']);
assert.deepEqual(frotaDaUnidade(2, tipoRelatorioDaResposta('trator')).map((v) => v.placa), []);
const relatorioSrc = fs.readFileSync(path.join(root, 'src/services/relatorio-semanal-pdf.js'), 'utf8');
assert.match(relatorioSrc, /FROM veiculos[\s\S]*WHERE filial_id = \?/);
assert.match(menuSrc, /gerarRelatorioSemanalPdfBuffer\(ctx\.filialId/);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Caminhao Basculante', tipo_codigo: null }, 'Caminhao Basculante'), true);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Truck / Tração', tipo_codigo: 'truck_tracao' }, 'Caminhao Basculante'), false);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Truckado', tipo_codigo: null }, 'todos'), true);
assert.equal(veiculoPassaFiltroRelatorio({ tipo: 'Truckado', tipo_codigo: null }, null), true);

assert.equal(parseComandoNatural('manda o 0501-0042 para o estoque')?.tipo, 'estoque');
assert.equal(parseComandoNatural('relatorio') , null);
assert.match(menuSrc, /parseComandoNatural\(texto\)/);
assert.match(menuSrc, /pedirTipoRelatorio/);

assert.match(menuSrc, /gerarRelatorioSemanalPdfBuffer\(ctx\.filialId/);
assert.match(menuSrc, /case 'medir':/);
assert.match(menuSrc, /case 'troca_link':/);
assert.match(menuSrc, /case 'recap':/);
assert.match(menuSrc, /case 'descarte':/);
assert.match(menuSrc, /case 'estoque':/);

const menu = textoMenu();
for (const linha of [
  '1️⃣ Medir pneu (placa → link)',
  '2️⃣ Cadastrar equipamento (link)',
  '3️⃣ Cadastrar pneu estoque (link)',
  '4️⃣ Trocar / montar (placa → link)',
  '5️⃣ Enviar pneu → estoque (nº fogo)',
  '6️⃣ Enviar pneu → recap (nº fogo)',
  '7️⃣ Enviar pneu → descarte (nº fogo)',
  '8️⃣ Relatório da frota (PDF por tipo)',
  '9️⃣ Frota (placas + sulco)',
]) {
  assert.ok(menu.includes(linha), linha);
}

const filtroTruck = resolverFiltroRelatorio(tipoRelatorioDaResposta('2'));
assert.equal(filtroTruck.id, 'caminhao_compactador');
assert.equal(filtroTruck.label, 'Caminhao/Compactador');
const pdfDadosFrota = [{
  placa: 'TST1A23',
  tipo: 'Truck / Tração',
  tipo_codigo: 'truck_tracao',
  status_sulco: 'ok',
  status_label: 'OK',
  menor_sulco: 10,
  pneus: [{
    posicao: '1E',
    menor_sulco: 10,
    status_sulco: 'ok',
    status_label: 'OK',
    diagnostico: 'OK',
    acao: 'OK',
    motivo: 'Desgaste uniforme.',
  }],
}, {
  placa: 'TRK0001',
  tipo: 'Truckado',
  tipo_codigo: null,
  pneus: [],
}];
const pdf = await gerarPdfRelatorioSemanal({
  titulo: `Relatorio semanal - ${filtroTruck.label}`,
  filtro_tipo: filtroTruck.id,
  filtro_label: filtroTruck.label,
  unidade_relatorio: 'km',
  gerado_em: new Date().toISOString(),
  gerado_por: 'teste',
  periodo: { label: '01/10 a 08/10' },
  filial: { nome: 'Unidade teste', codigo: 'TST' },
  limites: { critico_mm: 3, monitorar_ate_mm: 6, prazo_recap_dias: 15 },
  resumo: {
    veiculos: 1,
    pneus_montados: 1,
    pneus_estoque: 0,
    pneus_em_recapagem: 0,
    pneus_descarte: 0,
    sulco_ok: 1,
    sulco_monitorar: 0,
    sulco_critico: 0,
    sem_medicao: 0,
    movimentacoes_semana: 0,
  },
  frota: pdfDadosFrota,
  prioridades: { troca: [], monitorar: [], rodizio: [] },
  diagnosticos: [],
  medicoes_semana_lista: [],
  estoque: [],
  estoque_resumo: { total: 0, novos: 0, recapados: 0, criticos: 0, alerta: 0, sem_medicao: 0, por_padrao: {} },
  em_recapagem: [],
  historico: [],
  descarte: [],
});
assert.ok(Buffer.isBuffer(pdf));
assert.ok(pdf.length > 500);
assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
const placasTabela = linhasTabelaFrota(pdfDadosFrota).map((l) => l.placa);
assert.deepEqual(placasTabela, ['TST1A23', 'TRK0001']);
assert.equal(linhasTabelaFrota(pdfDadosFrota).find((l) => l.placa === 'TRK0001').status, 'Sem pneu montado');
assert.deepEqual(veiculosComDiagrama(pdfDadosFrota).map((v) => v.placa), ['TST1A23']);
function textoDoConteudoPdf(conteudo) {
  return conteudo.replace(/<([0-9A-Fa-f]+)>/g, (_, hex) => {
    let s = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return s;
  });
}

function pdfContem(buf, texto) {
  const raw = buf.toString('latin1');
  if (raw.includes(texto)) return true;
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  for (const m of raw.matchAll(re)) {
    let corpo = m[1];
    if (corpo.endsWith('\r\n')) corpo = corpo.slice(0, -2);
    else if (corpo.endsWith('\n') || corpo.endsWith('\r')) corpo = corpo.slice(0, -1);
    try {
      const textoStream = textoDoConteudoPdf(zlib.inflateSync(Buffer.from(corpo, 'latin1')).toString('latin1'));
      if (textoStream.includes(texto)) return true;
    } catch {
      /* trecho que não é stream compactado */
    }
  }
  return false;
}
assert.ok(pdfContem(pdf, 'TRK0001'), 'PDF sem a placa do veiculo sem pneu montado');
assert.ok(pdfContem(pdf, 'TST1A23'));
assert.ok(pdfContem(pdf, 'Sem pneu montado'));

console.log('menu relatorio whatsapp ok');
