/**
 * Leitura única da frota usada pela visão do presidente e pelo diagnóstico das filiais.
 *
 * Validade: 20 segundos (VALIDADE_SNAPSHOT_EXECUTIVO_MS), só como rede de
 * segurança. Gravação confirmada chama invalidarFrotaExecutiva(filialId) e
 * descarta na hora as chaves que incluem aquela filial. O agregado irrestrito
 * entra, porque a visão "todas" soma essa unidade. A chave de outra filial,
 * ou de um gerente que não a inclui, permanece.
 *
 * A chave é o escopo autorizado mais o filtro de filial.
 * - Leitura executiva (admin e presidente) usa escopo irrestrito: os dois papéis
 *   veem a mesma frota, então compartilham a mesma entrada.
 * - Gerente ou qualquer lista de filiais usa só esses ids. Essa entrada não é
 *   lida pelo escopo irrestrito, nem o contrário.
 * Usuários com permissões diferentes não reutilizam o resultado um do outro.
 *
 * Cada chave tem um selo. A leitura que já estava no ar guarda o resultado só
 * se o selo não mudou. Assim o dado antigo não reocupa a vaga depois da gravação,
 * e a leitura de uma filial não afetada ainda pode gravar a sua.
 *
 * Chamadas simultâneas da mesma chave esperam a mesma ida ao banco.
 */
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';

export const VALIDADE_SNAPSHOT_EXECUTIVO_MS = 20_000;

const MAX_ENTRADAS = 8;

let relogio = () => Date.now();
let geracao = 0;
const cache = new Map();
const voos = new Map();
const selo = new Map();
const contagem = { leituras: 0, reusos: 0 };

export function definirRelogioFrotaExecutiva(fn) {
  relogio = typeof fn === 'function' ? fn : (() => Date.now());
}

export function agoraCacheExecutivo() {
  return relogio();
}

export function limparCacheFrotaExecutiva() {
  geracao += 1;
  cache.clear();
  voos.clear();
  selo.clear();
  contagem.leituras = 0;
  contagem.reusos = 0;
}

function marcaAtual(chave) {
  return `${geracao}:${selo.get(chave) || 0}`;
}

/** true quando a chave agrega a filial ou está filtrada nela. */
export function chaveFrotaAtingeFilial(chave, filialId) {
  const id = Number(filialId);
  const [escopo, filial] = String(chave).split('|');
  const filialChave = filial === '*' || filial == null || filial === '' ? null : Number(filial);
  if (filialChave != null) return filialChave === id;
  if (escopo === 'irrestrito') return true;
  if (!escopo || escopo === 'vazio') return false;
  return escopo.split(',').map(Number).includes(id);
}

/**
 * filialId numérico: só as chaves dessa unidade e os agregados que a incluem.
 * Sem filial (admin ou importação): descarta todas as chaves.
 */
export function invalidarFrotaExecutiva(filialId = null) {
  const id = Number(filialId);
  const todas = !Number.isInteger(id) || id <= 0;
  const chaves = new Set([...cache.keys(), ...voos.keys()]);
  for (const chave of chaves) {
    if (!todas && !chaveFrotaAtingeFilial(chave, id)) continue;
    selo.set(chave, (selo.get(chave) || 0) + 1);
    cache.delete(chave);
    voos.delete(chave);
  }
}

export function estatisticasFrotaExecutiva() {
  return {
    leituras: contagem.leituras,
    reusos: contagem.reusos,
    entradas: cache.size,
    emVoo: voos.size,
  };
}

function listaNumerica(valor) {
  if (!Array.isArray(valor) || !valor.length) return null;
  return [...new Set(valor.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    .sort((a, b) => a - b);
}

/**
 * null = sem restrição de ids (leitura executiva inteira).
 * [] = combinação impossível (escopo e filial não se cruzam).
 */
export function idsDaConsulta(escopo, filialId) {
  const lista = listaNumerica(escopo);
  const temFilial = filialId != null && filialId !== '';
  const filial = temFilial ? Number(filialId) : null;
  if (temFilial && (!Number.isInteger(filial) || filial <= 0)) return [];
  if (lista && temFilial) return lista.includes(filial) ? [filial] : [];
  if (lista) return lista;
  if (temFilial) return [filial];
  return null;
}

function chaveEscopo(escopo) {
  if (escopo == null) return 'irrestrito';
  const lista = listaNumerica(escopo);
  if (!lista) return 'vazio';
  return lista.join(',');
}

function chaveFrota(escopo, filialId) {
  const filial = filialId != null && filialId !== '' ? Number(filialId) : '*';
  return `${chaveEscopo(escopo)}|${filial}`;
}

function entradaFresca(chave) {
  const hit = cache.get(chave);
  if (!hit) return null;
  if (relogio() - hit.em >= VALIDADE_SNAPSHOT_EXECUTIVO_MS) return null;
  return hit.valor;
}

function guardar(chave, valor, marca) {
  if (marca !== marcaAtual(chave)) return;
  cache.set(chave, { em: relogio(), valor });
  if (cache.size <= MAX_ENTRADAS) return;
  const antigo = [...cache.entries()].sort((a, b) => a[1].em - b[1].em)[0];
  if (antigo) cache.delete(antigo[0]);
}

/**
 * Uma leitura por chave. Sucesso e falha encerram a promessa.
 * O finally sempre tira a chave do mapa, então a tentativa seguinte começa outra leitura.
 */
export function filaUnica(mapa, chave, produtor) {
  const existente = mapa.get(chave);
  if (existente) return existente;
  const voo = Promise.resolve()
    .then(() => produtor())
    .finally(() => {
      if (mapa.get(chave) === voo) mapa.delete(chave);
    });
  mapa.set(chave, voo);
  return voo;
}

function emVoo(chave, produtor) {
  const existente = voos.get(chave);
  if (existente) {
    contagem.reusos += 1;
    return existente;
  }
  const marca = marcaAtual(chave);
  return filaUnica(voos, chave, async () => {
    const valor = await produtor();
    guardar(chave, valor, marca);
    return valor;
  });
}

function fatiar(frota, filialId) {
  const id = Number(filialId);
  return {
    filiais: frota.filiais,
    veiculos: frota.veiculos.filter((v) => Number(v.filial_id) === id),
    pneus: frota.pneus.filter((p) => Number(p.filial_id) === id || Number(p.veiculo_filial_id) === id),
  };
}

async function carregar(db, escopo, filialId) {
  const ids = idsDaConsulta(escopo, filialId);
  if (ids && !ids.length) return { filiais: [], veiculos: [], pneus: [] };

  const catalogoRestrito = Array.isArray(escopo) && listaNumerica(escopo);
  const sqlFiliais = catalogoRestrito
    ? `SELECT id, nome, codigo, ativo, dia_medicao
       FROM filiais
       WHERE id = ANY(?::bigint[])
       ORDER BY nome`
    : `SELECT id, nome, codigo, ativo, dia_medicao
       FROM filiais
       ORDER BY nome`;
  const paramsFiliais = catalogoRestrito ? [[ids]] : [];

  const filtroIds = ids ? 'AND v.filial_id = ANY(?::bigint[])' : '';
  const paramsIds = ids ? [[ids]] : [];
  const filtroPneus = ids
    ? 'AND (p.filial_id = ANY(?::bigint[]) OR v.filial_id = ANY(?::bigint[]))'
    : '';
  // Dois arrays: .all(ids, ids). Um array só: .all([ids]), porque o pg desembrulha o único argumento.
  const paramsPneus = ids ? [ids, ids] : [];

  contagem.leituras += 1;
  const [filiais, veiculos, pneus] = await Promise.all([
    db.prepare(sqlFiliais).all(...paramsFiliais),
    db.prepare(`
      SELECT v.id, v.placa, v.apelido, v.tipo, v.tipo_codigo, v.layout_pneus, v.filial_id,
             v.km_atual, v.hr_atual, v.ativo, v.dia_medicao, v.cadastro_completo,
             f.nome AS filial_nome, f.dia_medicao AS filial_dia_medicao
      FROM veiculos v
      JOIN filiais f ON f.id = v.filial_id
      WHERE v.ativo = 1
      ${filtroIds}
    `).all(...paramsIds),
    db.prepare(`
      SELECT p.id, p.filial_id, p.veiculo_id, p.posicao, p.numero_fogo, p.status_pneu,
             p.vida_recap, p.condicao, p.recap_enviado_em, p.tipo_pneu,
             f.nome AS filial_nome,
             v.placa, v.apelido, v.tipo, v.tipo_codigo, v.layout_pneus, v.km_atual, v.hr_atual,
             v.filial_id AS veiculo_filial_id, v.ativo AS veiculo_ativo,
             v.dia_medicao, f.dia_medicao AS filial_dia_medicao,
             um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar, um.sulco_mm,
             um.pressao_psi, um.inspecao_danos, um.data_medicao
      FROM pneus p
      JOIN filiais f ON f.id = p.filial_id
      LEFT JOIN veiculos v ON v.id = p.veiculo_id
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1
        AND p.status_pneu IN ('montado', 'estoque', 'recapagem')
        ${filtroPneus}
    `).all(...paramsPneus),
  ]);

  return {
    filiais: filiais || [],
    veiculos: veiculos || [],
    pneus: pneus || [],
  };
}

/**
 * Frota bruta para o escopo. O catálogo de filiais da leitura irrestrita traz
 * todas as unidades (o seletor da visão precisa delas). Veículos e pneus
 * respeitam o filtro de filial. Escopo com lista só recebe essas filiais.
 */
export function obterFrotaExecutiva(db, { escopo = null, filialId = null } = {}) {
  const irrestrito = escopo == null;
  const chaveAmpla = chaveFrota(escopo, null);
  if (irrestrito) {
    const ampla = entradaFresca(chaveAmpla);
    if (ampla) {
      contagem.reusos += 1;
      return Promise.resolve(filialId != null && filialId !== '' ? fatiar(ampla, filialId) : ampla);
    }
    const vooAmplo = voos.get(chaveAmpla);
    if (vooAmplo) {
      contagem.reusos += 1;
      return vooAmplo.then((frota) => (
        filialId != null && filialId !== '' ? fatiar(frota, filialId) : frota
      ));
    }
  }

  const chave = chaveFrota(escopo, filialId);
  const direta = entradaFresca(chave);
  if (direta) {
    contagem.reusos += 1;
    return Promise.resolve(direta);
  }
  return emVoo(chave, () => carregar(db, escopo, filialId));
}
