/**
 * Operações de frota usadas pelo menu WhatsApp (escopo por filial_id).
 */
import { getDb } from '../database.js';
import { registrarMovimentacao, travarPneu } from './pneu-movimentacao.js';
import { comSavepoint, ehViolacaoUnique } from '../db-utils.js';
import { getLimites, classificarSulco, limitesDoVeiculo, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao, desgastePorKm } from '../diagnostico.js';
import { notificarGerentesAposMedicao } from './alertas-whatsapp.js';
import { avaliarAlertaPerfil, pesoAlerta, rotuloAlerta } from '../medicao-perfil.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import { camposTipoVeiculo } from '../equipamento-tipos.js';
import { colunaExiste, filtroCadastroCompleto } from '../schema-colunas.js';
import { comRetryFogoUnico, resolverNumeroFogo } from '../numero-fogo.js';
import {
  LAYOUT_PADRAO,
  TIPOS_PNEU,
  CONDICOES_PNEU,
  getLayout,
  labelPosicao,
  validarMontagem,
  aplicarLayoutPneus,
  papelPosicao,
  layoutParaNovoVeiculo,
} from '../pneus-layouts.js';

function erroOps(mensagem, status) {
  return Object.assign(new Error(mensagem), { status });
}

function trilhaWhatsApp(auditoria, base) {
  const texto = String(base || '').trim();
  const phone = String(auditoria?.telefone || '').replace(/\D/g, '');
  const quem = (phone.length >= 10 ? phone : '') || String(auditoria?.login || '').trim();
  if (!quem) return { usuario: null, detalhes: texto || null };
  const partes = [];
  if (texto) partes.push(texto);
  if (!/whatsapp/i.test(texto)) partes.push('WhatsApp');
  if (phone.length >= 10 && !texto.includes(phone)) partes.push(phone);
  if (auditoria?.grupo) partes.push(`grupo ${auditoria.grupo}`);
  if (auditoria?.unidade) partes.push(`unidade ${auditoria.unidade}`);
  return { usuario: phone.length >= 10 ? phone : quem, detalhes: partes.join(' · ') };
}

async function andCadastro(db, tabela, qualificado = 'cadastro_completo') {
  return `AND ${await filtroCadastroCompleto(db, tabela, qualificado)}`;
}

export function cadastroEstaCompleto(row) {
  return row != null && Number(row.cadastro_completo ?? 1) === 1;
}

function assertVeiculoOperacional(veiculo) {
  if (!veiculo) throw erroOps('Veículo não encontrado', 404);
  if (!cadastroEstaCompleto(veiculo)) {
    throw erroOps(
      'Veículo em pré-cadastro: conclua o cadastro no link web antes de operar',
      400
    );
  }
}

function assertPneuOperacional(pneu) {
  if (!pneu) throw erroOps('Pneu não encontrado', 404);
  if (!cadastroEstaCompleto(pneu)) {
    throw erroOps(
      'Pneu em pré-cadastro: conclua o cadastro no link web antes de operar',
      400
    );
  }
}

function falharTxSeTeste() {
  if (process.env.PNEU_TEST_FALHAR_TX === '1') {
    throw erroOps('falha simulada na transação', 500);
  }
}

/**
 * Valida o pneu substituto (filial, estoque, posição, validarMontagem) sem alterar o banco.
 */
export async function validarSubstitutoEstoque({ filialId, pneuEstoqueId, veiculoId, posicao }) {
  const db = getDb();
  const id = parseInt(pneuEstoqueId, 10);
  if (!id) {
    throw erroOps('Informe o pneu do estoque para ocupar a posição', 400);
  }
  const estoque = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(id);
  if (!estoque) {
    throw erroOps('Pneu do estoque não encontrado', 404);
  }
  if (Number(estoque.filial_id) !== Number(filialId)) {
    throw erroOps('Pneu substituto pertence a outra filial', 400);
  }
  if (Number(estoque.ativo) !== 1) {
    throw erroOps('Pneu substituto indisponível (inativo)', 400);
  }
  assertPneuOperacional(estoque);
  if (estoque.status_pneu !== 'estoque') {
    const motivo = estoque.status_pneu === 'montado'
      ? 'já está montado'
      : estoque.status_pneu === 'recapagem'
        ? 'está em recapagem'
        : estoque.status_pneu === 'descarte'
          ? 'está no descarte'
          : `está em ${estoque.status_pneu}`;
    throw erroOps(`Pneu substituto indisponível (${motivo})`, 400);
  }
  const veiculo = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoId, filialId);
  if (!veiculo) {
    throw erroOps('Veículo não encontrado', 404);
  }
  assertVeiculoOperacional(veiculo);
  const pos = String(posicao || '').trim().toUpperCase();
  const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
  if (!layout.posicoes.includes(pos)) {
    throw erroOps(`Posição ${pos} inválida neste veículo`, 400);
  }
  const validacao = validarMontagem({
    condicao: estoque.condicao,
    tipo_pneu: estoque.tipo_pneu,
    posicao: pos,
  });
  if (!validacao.ok) {
    throw erroOps(validacao.erros.join(' '), 400);
  }
  return { estoque, veiculo, posicao: pos };
}

function hojeIso() {
  return new Date().toISOString().split('T')[0];
}

export async function buscarVeiculoPorPlaca(filialId, placaLimpa) {
  const db = getDb();
  const rows = await db.prepare(`
    SELECT v.*, f.nome as filial_nome,
      REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') AS placa_norm
    FROM veiculos v
    JOIN filiais f ON f.id = v.filial_id
    WHERE v.ativo = 1 AND v.filial_id = ?
      ${await andCadastro(db, 'veiculos', 'v.cadastro_completo')}
      AND REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') LIKE ?
    ORDER BY v.placa
    LIMIT 15
  `).all(filialId, `%${placaLimpa}%`);

  const exatos = rows.filter((v) => {
    const p = String(v.placa_norm || '').replace(/[^A-Z0-9]/gi, '');
    return p === placaLimpa;
  });
  return exatos.length ? exatos : rows;
}

export async function listarFrota(filialId) {
  const db = getDb();
  const rows = await db.prepare(`
    SELECT id, placa, apelido, tipo, layout_pneus
    FROM veiculos
    WHERE ativo = 1 AND filial_id = ?
      ${await andCadastro(db, 'veiculos')}
    ORDER BY placa
  `).all(filialId);
  const out = [];
  for (const v of rows || []) {
    const pneus = await db.prepare(`
      SELECT
        m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.sulco_mm,
        m.inspecao_danos, m.hr_veiculo
      FROM pneus p
      LEFT JOIN medicoes m ON m.pneu_id = p.id
        AND m.id = (SELECT id FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1)
      WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
    `).all(v.id);
    let menor = null;
    let pior = null;
    let temMedicao = false;
    for (const p of pneus || []) {
      const m = menorSulco(p);
      if (m != null) {
        menor = menor == null ? m : Math.min(menor, m);
        temMedicao = true;
      }
      if (p.inspecao_danos) temMedicao = true;
      const aval = avaliarAlertaPerfil(p, {
        tipo: v.tipo,
        layout: v.layout_pneus,
        hr_veiculo: p.hr_veiculo,
      });
      if (!pior || pesoAlerta(aval) < pesoAlerta(pior)) pior = aval;
    }
    out.push({
      ...v,
      menor_sulco: menor,
      status_sulco: pior?.status_sulco ?? null,
      status_label: rotuloAlerta(pior, temMedicao),
      acao_sugerida: pior?.acao?.codigo || null,
      acao_label: pior?.acao?.label || null,
    });
  }
  return out;
}

export async function buscarPlacaFilial(filialId, placaTexto) {
  const db = getDb();
  const placaLimpa = String(placaTexto || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!placaLimpa) return null;
  return db.prepare(`
    SELECT v.*
    FROM veiculos v
    WHERE v.filial_id = ?
      AND REPLACE(REPLACE(UPPER(v.placa), '-', ''), ' ', '') = ?
    LIMIT 1
  `).get(filialId, placaLimpa);
}

export async function criarVeiculo(filialId, {
  placa, apelido = null, tipo = 'Truck / Tração', km_atual = 0, hr_atual = 0, layout_pneus = null,
  marca = null, modelo = null, preCadastro = false,
}) {
  const db = getDb();
  const tipoNorm = normalizarTipoVeiculo(tipo) || 'Truck / Tração';
  const tipoCampos = camposTipoVeiculo(tipoNorm);
  const layoutId = preCadastro ? null : layoutParaNovoVeiculo(tipoNorm, layout_pneus);
  const temCadastro = await colunaExiste(db, 'veiculos', 'cadastro_completo');
  const placaOk = String(placa).trim().toUpperCase();
  try {
    return await db.transaction(async () => {
      const result = await db.prepare(`
      INSERT INTO veiculos (
        placa, apelido, tipo, tipo_codigo, marca, modelo, km_atual, hr_atual, layout_pneus,
        filial_id, ativo${temCadastro ? ', cadastro_completo' : ''}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1${temCadastro ? ', ?' : ''})
    `).run(
        ...[
          placaOk,
          apelido?.trim() || null,
          tipoCampos.tipo,
          tipoCampos.tipo_codigo,
          marca?.trim() || null,
          modelo?.trim() || null,
          Number(km_atual) || 0,
          Number(hr_atual) || 0,
          layoutId,
          filialId,
          ...(temCadastro ? [preCadastro ? 0 : 1] : []),
        ]
      );
      const id = result.lastInsertRowid;
      if (!id) throw erroOps('O banco não confirmou o veículo', 500);
      if (preCadastro) {
        return { id, placa: placaOk, layoutId: null, total_posicoes: 0, preCadastro: true };
      }
      const posicoes = await aplicarLayoutPneus(db, id, layoutId, null);
      return { id, placa: placaOk, layoutId, total_posicoes: posicoes.length, preCadastro: false };
    });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      const e = new Error('Placa já cadastrada');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

export async function completarVeiculo(filialId, veiculoId, {
  marca, modelo, tipo, km_atual, layout_pneus, apelido, ano = null,
}) {
  const db = getDb();
  const veiculo = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ?
  `).get(veiculoId, filialId);
  if (!veiculo) throw erroOps('Veículo não encontrado', 404);
  const modeloOk = String(modelo || '').trim();
  const marcaOk = String(marca || '').trim();
  const tipoNorm = normalizarTipoVeiculo(tipo || veiculo.tipo) || veiculo.tipo;
  const tipoCampos = camposTipoVeiculo(tipoNorm);
  const layoutId = layoutParaNovoVeiculo(tipoNorm, layout_pneus || veiculo.layout_pneus);
  if (!modeloOk) throw erroOps('Modelo é obrigatório para concluir o cadastro', 400);
  if (!marcaOk) throw erroOps('Fabricante é obrigatório para concluir o cadastro', 400);
  if (!layoutId) throw erroOps('Configuração dos eixos é obrigatória', 400);

  const temCadastro = await colunaExiste(db, 'veiculos', 'cadastro_completo');
  return db.transaction(async () => {
    await db.prepare(`
    UPDATE veiculos SET
      marca = ?, modelo = ?, tipo = ?, tipo_codigo = ?,
      km_atual = COALESCE(?, km_atual), apelido = COALESCE(?, apelido),
      ano = COALESCE(?, ano)${temCadastro ? ', cadastro_completo = 1' : ''}, updated_at = NOW()
    WHERE id = ?
  `).run(
      marcaOk,
      modeloOk,
      tipoCampos.tipo,
      tipoCampos.tipo_codigo,
      km_atual != null ? Number(km_atual) : null,
      apelido != null ? (String(apelido).trim() || null) : null,
      ano != null ? Number(ano) : null,
      veiculoId
    );
    const posicoes = await aplicarLayoutPneus(db, veiculoId, layoutId, null);
    return { id: veiculoId, layoutId, total_posicoes: posicoes.length, placa: veiculo.placa };
  });
}

export async function criarPneuEstoque(filialId, {
  numero_fogo, marca = null, modelo, tipo_pneu = 'misto',
  condicao = 'novo', sulco_inicial_mm = null, preCadastro = false,
  auditoria = null,
}) {
  const db = getDb();
  const modeloOk = preCadastro ? (String(modelo || '').trim() || 'Pendente') : String(modelo || '').trim();
  if (!modeloOk) throw Object.assign(new Error('Modelo obrigatório'), { status: 400 });
  const tipo = TIPOS_PNEU.includes(tipo_pneu) ? tipo_pneu : 'misto';
  const cond = CONDICOES_PNEU.includes(condicao) ? condicao : 'novo';
  const vida = cond === 'recapado' ? 1 : 0;
  const temCadastro = await colunaExiste(db, 'pneus', 'cadastro_completo');
  try {
    return await db.transaction(async () => {
      const { result } = await comRetryFogoUnico(db, filialId, numero_fogo, (fogo) => (
        comSavepoint(db, () => db.prepare(`
      INSERT INTO pneus (
        veiculo_id, posicao, filial_id, marca, modelo, numero_fogo,
        tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, ativo
        ${temCadastro ? ', cadastro_completo' : ''}
      ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'estoque', 1${temCadastro ? ', ?' : ''})
    `).run(
          ...[
            filialId,
            marca?.trim() || null,
            modeloOk,
            fogo,
            tipo,
            cond,
            vida,
            sulco_inicial_mm != null ? Number(sulco_inicial_mm) : null,
            ...(temCadastro ? [preCadastro ? 0 : 1] : []),
          ]
        ))
      ));
      const row = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(result.lastInsertRowid);
      if (!row?.id) throw erroOps('O banco não confirmou o pneu', 500);
      if (!preCadastro && (auditoria?.telefone || auditoria?.login)) {
        const trilha = trilhaWhatsApp(auditoria, 'Cadastro no estoque');
        await registrarMovimentacao(db, {
          pneuId: row.id,
          tipo: 'entrada_estoque',
          data: hojeIso(),
          ciclo: row.vida_recap || 0,
          usuario: trilha.usuario,
          sulcoMm: row.sulco_inicial_mm,
          detalhes: trilha.detalhes,
        });
      }
      return row;
    });
  } catch (err) {
    if (err.status) throw err;
    if (ehViolacaoUnique(err)) {
      throw Object.assign(new Error('Já existe pneu com este nº de fogo'), { status: 409 });
    }
    throw err;
  }
}

export async function completarPneu(filialId, pneuId, {
  marca, modelo, tipo_pneu, condicao, sulco_inicial_mm, numero_fogo = null,
}) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw erroOps('Pneu não encontrado', 404);
  const modeloOk = String(modelo || '').trim();
  if (!modeloOk || /^pendente$/i.test(modeloOk)) {
    throw erroOps('Modelo é obrigatório para concluir o cadastro', 400);
  }
  const tipo = TIPOS_PNEU.includes(tipo_pneu) ? tipo_pneu : (pneu.tipo_pneu || 'misto');
  const cond = CONDICOES_PNEU.includes(condicao) ? condicao : (pneu.condicao || 'novo');
  const vida = cond === 'recapado' ? Math.max(Number(pneu.vida_recap) || 0, 1) : (Number(pneu.vida_recap) || 0);
  const temCadastro = await colunaExiste(db, 'pneus', 'cadastro_completo');
  await db.prepare(`
    UPDATE pneus SET
      marca = ?, modelo = ?, tipo_pneu = ?, condicao = ?, vida_recap = ?,
      sulco_inicial_mm = COALESCE(?, sulco_inicial_mm),
      numero_fogo = COALESCE(?, numero_fogo)
      ${temCadastro ? ', cadastro_completo = 1' : ''}
    WHERE id = ?
  `).run(
    marca?.trim() || null,
    modeloOk,
    tipo,
    cond,
    vida,
    sulco_inicial_mm != null && sulco_inicial_mm !== '' ? Number(sulco_inicial_mm) : null,
    numero_fogo ? String(numero_fogo).trim() : null,
    pneuId
  );
  return db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneuId);
}

export async function listarEstoque(filialId, limit = 20, busca = null) {
  const db = getDb();
  const termo = String(busca || '').trim();
  if (termo) {
    const like = `%${termo}%`;
    const semHifen = `%${termo.replace(/-/g, '')}%`;
    return db.prepare(`
      SELECT id, numero_fogo, marca, modelo, tipo_pneu, condicao
      FROM pneus
      WHERE filial_id = ? AND ativo = 1 AND status_pneu = 'estoque'
        ${await andCadastro(db, 'pneus')}
        AND (
          LOWER(numero_fogo) LIKE LOWER(?)
          OR LOWER(REPLACE(numero_fogo, '-', '')) LIKE LOWER(?)
          OR LOWER(COALESCE(marca, '')) LIKE LOWER(?)
          OR LOWER(COALESCE(modelo, '')) LIKE LOWER(?)
        )
      ORDER BY condicao DESC, numero_fogo
      LIMIT ?
    `).all(filialId, like, semHifen, like, like, limit);
  }
  return db.prepare(`
    SELECT id, numero_fogo, marca, modelo, tipo_pneu, condicao
    FROM pneus
    WHERE filial_id = ? AND ativo = 1 AND status_pneu = 'estoque'
      ${await andCadastro(db, 'pneus')}
    ORDER BY condicao DESC, numero_fogo
    LIMIT ?
  `).all(filialId, limit);
}

export async function prepararFogoCadastro(filialId, informado) {
  const db = getDb();
  const resolvido = await resolverNumeroFogo(db, filialId, informado);
  const existente = await buscarPneuPorFogo(filialId, resolvido.numero_fogo);
  return { numero_fogo: resolvido.numero_fogo, existente };
}

function fmtMm(valor) {
  return String(valor).replace('.', ',');
}

function textoSulcos(med, pneu) {
  const vals = [med?.sulco_externo, med?.sulco_central, med?.sulco_interno, med?.sulco_auxiliar]
    .filter((v) => v != null && v !== '');
  if (vals.length) return vals.map(fmtMm).join('/');
  if (med?.sulco_mm != null && med.sulco_mm !== '') return `${fmtMm(med.sulco_mm)} mm`;
  if (pneu?.sulco_inicial_mm != null && pneu.sulco_inicial_mm !== '') {
    return `${fmtMm(pneu.sulco_inicial_mm)} mm (inicial)`;
  }
  return 'sem medição';
}

function rotuloSituacaoSulco(status) {
  if (status === 'ok') return 'ok';
  if (status === 'alerta') return 'alerta';
  if (status === 'critico') return 'crítico';
  return 'sem medição';
}

function rotuloVidaPneu(pneu) {
  const vida = (Number(pneu?.vida_recap) || 0) + 1;
  return `${vida}ª vida`;
}

function localPneu(pneu) {
  if (pneu.status_pneu === 'montado') {
    const pos = pneu.posicao ? `${labelPosicao(pneu.posicao)} (${pneu.posicao})` : '?';
    return `montado em ${pneu.placa || '?'} / ${pos}`;
  }
  if (pneu.status_pneu === 'recapagem') return 'em recapagem';
  if (pneu.status_pneu === 'descarte') return 'no descarte';
  return 'estoque';
}

async function ultimaMedicaoPneu(pneuId) {
  const db = getDb();
  return db.prepare(`
    SELECT sulco_externo, sulco_central, sulco_interno, sulco_auxiliar, sulco_mm
    FROM medicoes
    WHERE pneu_id = ?
    ORDER BY data_medicao DESC, id DESC
    LIMIT 1
  `).get(pneuId);
}

async function situacaoSulcoPneu(pneu, med) {
  if (!med) return 'sem medição';
  const menor = menorSulco(med);
  let limites = getLimites();
  if (pneu.veiculo_id) {
    const veiculo = await getDb().prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
    if (veiculo) limites = limitesDoVeiculo(veiculo);
  }
  return rotuloSituacaoSulco(classificarSulco(menor, limites));
}

export async function textoConsultaFogo(filialId, fogo) {
  const pneu = await buscarPneuPorFogo(filialId, fogo);
  if (!pneu) return null;
  const med = await ultimaMedicaoPneu(pneu.id);
  const situacao = await situacaoSulcoPneu(pneu, med);
  return [
    `🛞 *${pneu.numero_fogo}*`,
    `Local: ${localPneu(pneu)}`,
    `Condição: ${pneu.condicao || '—'}`,
    `Sulcos: ${textoSulcos(med, pneu)}`,
    `Situação: ${situacao}`,
    `Vida: ${rotuloVidaPneu(pneu)}`,
  ].join('\n');
}

export async function textoConsultaPlaca(filialId, placa) {
  const limpa = String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!limpa) return 'Envie a placa. Ex.: *consultar placa ABC1D23*';
  const achados = await buscarVeiculoPorPlaca(filialId, limpa);
  const exatos = (achados || []).filter((v) => {
    const p = String(v.placa_norm || v.placa || '').replace(/[^A-Z0-9]/gi, '');
    return p === limpa;
  });
  if (!exatos.length) return `Placa *${limpa}* não encontrada nesta unidade.`;
  if (exatos.length > 1) {
    return `Várias placas:\n${exatos.map((v) => `• ${v.placa}`).join('\n')}`;
  }
  const veiculo = exatos[0];
  const db = getDb();
  const pneus = await db.prepare(`
    SELECT id, posicao, numero_fogo, sulco_inicial_mm, veiculo_id
    FROM pneus
    WHERE veiculo_id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'montado'
  `).all(veiculo.id, filialId);
  const ordem = getLayout(veiculo.layout_pneus)?.posicoes || [];
  pneus.sort((a, b) => {
    const ia = ordem.indexOf(String(a.posicao || '').toUpperCase());
    const ib = ordem.indexOf(String(b.posicao || '').toUpperCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const limites = limitesDoVeiculo(veiculo);
  const linhas = [`🚛 *${veiculo.placa}* — pneus montados`];
  if (!pneus.length) {
    linhas.push('Nenhum pneu montado.');
    return linhas.join('\n');
  }
  for (const pneu of pneus) {
    const med = await ultimaMedicaoPneu(pneu.id);
    const situacao = med
      ? rotuloSituacaoSulco(classificarSulco(menorSulco(med), limites))
      : 'sem medição';
    const pos = `${labelPosicao(pneu.posicao)} (${pneu.posicao})`;
    linhas.push(`• ${pos} — fogo *${pneu.numero_fogo}* — sulcos ${textoSulcos(med, pneu)} — ${situacao}`);
  }
  return linhas.join('\n');
}

export async function textoEstoqueUnidade(filialId, busca = null) {
  const rows = await listarEstoque(filialId, 40, busca);
  const titulo = busca
    ? `📦 Estoque — busca *${String(busca).trim()}*`
    : '📦 Estoque da unidade';
  if (!rows.length) {
    return busca
      ? `${titulo}\nNenhum pneu encontrado.`
      : `${titulo}\nNenhum pneu no estoque.`;
  }
  const grupos = new Map();
  for (const pneu of rows) {
    const chave = pneu.condicao === 'recapado' ? 'Recapados' : 'Novos';
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(pneu);
  }
  const linhas = [titulo];
  for (const nome of ['Novos', 'Recapados']) {
    const lista = grupos.get(nome);
    if (!lista?.length) continue;
    linhas.push(`*${nome}*`);
    for (const pneu of lista) {
      const desc = [pneu.marca, pneu.modelo].filter(Boolean).join(' ') || '—';
      linhas.push(`• *${pneu.numero_fogo}* — ${desc} · ${pneu.tipo_pneu || 'misto'}`);
    }
  }
  if (rows.length === 40) linhas.push('_Mostrando os primeiros 40._');
  return linhas.join('\n');
}

export async function buscarPneuPorFogo(filialId, fogo) {
  const db = getDb();
  const n = String(fogo || '').trim();
  return db.prepare(`
    SELECT p.*, v.placa
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.filial_id = ? AND p.ativo = 1
      AND LOWER(TRIM(p.numero_fogo)) = LOWER(?)
    LIMIT 1
  `).get(filialId, n);
}

/**
 * Match exato na filial; se não houver, parcial (hífen ignorado). Não cruza filial.
 */
export async function buscarPneusPorFogo(filialId, fogo, { limite = 8 } = {}) {
  const db = getDb();
  const n = String(fogo || '').trim();
  if (!n) return [];
  const exatos = await db.prepare(`
    SELECT p.*, v.placa
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.filial_id = ? AND p.ativo = 1
      AND LOWER(TRIM(p.numero_fogo)) = LOWER(?)
    ORDER BY p.numero_fogo
    LIMIT ?
  `).all(filialId, n, limite);
  if (exatos.length) return exatos;

  const compacto = n.replace(/[-\s]/g, '').toLowerCase();
  if (compacto.length < 3) return [];
  return db.prepare(`
    SELECT p.*, v.placa
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.filial_id = ? AND p.ativo = 1
      AND (
        LOWER(p.numero_fogo) LIKE '%' || LOWER(?) || '%'
        OR REPLACE(REPLACE(LOWER(p.numero_fogo), '-', ''), ' ', '') LIKE '%' || ? || '%'
      )
    ORDER BY p.numero_fogo
    LIMIT ?
  `).all(filialId, n, compacto, limite + 1);
}

export async function listarPneusMontados(veiculoId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, numero_fogo, posicao, marca, modelo
    FROM pneus
    WHERE veiculo_id = ? AND ativo = 1 AND status_pneu = 'montado'
    ORDER BY posicao
  `).all(veiculoId);
}

export async function posicoesLivres(veiculoId) {
  const db = getDb();
  const v = await db.prepare('SELECT * FROM veiculos WHERE id = ? AND ativo = 1').get(veiculoId);
  if (!v) return [];
  const layout = getLayout(v.layout_pneus || LAYOUT_PADRAO);
  const ocupadas = new Set(
    (await db.prepare(`
      SELECT posicao FROM pneus
      WHERE veiculo_id = ? AND ativo = 1 AND status_pneu = 'montado'
    `).all(veiculoId)).map((r) => r.posicao)
  );
  return layout.posicoes.filter((p) => !ocupadas.has(p));
}

export async function montarPneu({ filialId, pneuId, veiculoId, posicao, auditoria = null }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu === 'descarte') {
    throw Object.assign(new Error('Pneu descartado não pode ser montado'), { status: 400 });
  }
  if (pneu.status_pneu === 'montado') {
    throw Object.assign(new Error('Pneu já está montado'), { status: 400 });
  }
  assertPneuOperacional(pneu);
  const veiculo = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoId, filialId);
  if (!veiculo) throw Object.assign(new Error('Veículo não encontrado'), { status: 404 });
  assertVeiculoOperacional(veiculo);

  const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
  if (!layout.posicoes.includes(posicao)) {
    throw Object.assign(new Error(`Posição ${posicao} inválida neste veículo`), { status: 400 });
  }
  const validacao = validarMontagem({
    condicao: pneu.condicao,
    tipo_pneu: pneu.tipo_pneu,
    posicao,
  });
  if (!validacao.ok) {
    throw Object.assign(new Error(validacao.erros.join(' ')), { status: 400 });
  }
  const ocupado = await db.prepare(`
    SELECT id, numero_fogo FROM pneus
    WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
  `).get(veiculoId, posicao);
  if (ocupado) {
    throw Object.assign(
      new Error(`Posição ${posicao} ocupada${ocupado.numero_fogo ? ` (fogo ${ocupado.numero_fogo})` : ''}`),
      { status: 409 }
    );
  }

  const data = hojeIso();
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = ?, posicao = ?, status_pneu = 'montado',
        data_instalacao = ?, km_instalacao = ?, ativo = 1
      WHERE id = ?
    `).run(veiculoId, posicao, data, veiculo.km_atual || null, pneuId);
    const trilha = trilhaWhatsApp(auditoria, `WhatsApp · ${veiculo.placa} · ${labelPosicao(posicao)}`);
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId,
      tipo: 'montagem',
      data,
      km: veiculo.km_atual,
      hr: veiculo.hr_atual,
      posicao,
      detalhes: trilha.detalhes,
      usuario: trilha.usuario,
      placa: veiculo.placa,
    });
  });
  return { placa: veiculo.placa, posicao, label: labelPosicao(posicao), fogo: pneu.numero_fogo };
}

export function autorizarDesmontagemSimples(valor) {
  if (valor === true || valor === 1) return true;
  const s = String(valor ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'sim';
}

export async function desmontarPneu({
  filialId, pneuId, detalhes = null, km = undefined, hr = undefined, auditoria = null,
}) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT p.*, v.placa, v.km_atual, v.hr_atual
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.id = ? AND p.filial_id = ? AND p.ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw erroOps('Pneu não encontrado', 404);
  if (pneu.status_pneu !== 'montado' || !pneu.veiculo_id) {
    throw erroOps('Pneu não está montado', 400);
  }
  const data = hojeIso();
  const veiculoId = pneu.veiculo_id;
  const posicao = pneu.posicao;
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET veiculo_id = NULL, posicao = NULL, status_pneu = 'estoque', data_instalacao = NULL
      WHERE id = ?
    `).run(pneuId);
    const trilha = trilhaWhatsApp(
      auditoria,
      detalhes?.trim() || `WhatsApp · retirou de ${pneu.placa || ''}`,
    );
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId,
      tipo: 'retirada',
      data,
      km: km !== undefined ? km : pneu.km_atual,
      hr: hr !== undefined ? hr : pneu.hr_atual,
      posicao,
      detalhes: trilha.detalhes,
      usuario: trilha.usuario,
      placa: pneu.placa,
    });
  });
  return {
    fogo: pneu.numero_fogo,
    placa: pneu.placa,
    posicao,
    veiculo_id: veiculoId,
    estava_montado: true,
  };
}

/**
 * Envio ao estoque: troca atômica se houver substituto; desmontagem simples só com autorização explícita.
 */
export async function enviarAoEstoqueOuTrocar({
  filialId,
  pneuId,
  pneuEstoqueId = null,
  permitirVazio = false,
  detalhes = null,
  km,
  hr,
}) {
  const substId = parseInt(pneuEstoqueId, 10) || null;
  if (substId) {
    const troca = await trocarPorEstoque({
      filialId,
      pneuMontadoId: pneuId,
      pneuEstoqueId: substId,
    });
    return { modo: 'troca', ...troca };
  }
  if (permitirVazio) {
    const r = await desmontarPneu({ filialId, pneuId, detalhes, km, hr });
    return { modo: 'desmontagem_simples', ...r };
  }
  throw erroOps(
    'Informe o pneu do estoque para ocupar a posição, ou autorize desmontagem simples (permitir_vazio)',
    400,
  );
}

export async function registrarRecap({ filialId, pneuId, pneuEstoqueId = null, auditoria = null }) {
  const db = getDb();
  const limites = getLimites();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw erroOps('Pneu não encontrado', 404);
  if (pneu.status_pneu === 'recapagem') {
    throw erroOps('Pneu já está em recapagem', 400);
  }
  if (pneu.status_pneu === 'descarte') {
    throw erroOps('Pneu já está no descarte', 400);
  }
  const novaVida = (pneu.vida_recap || 0) + 1;
  if (novaVida > (limites.max_recaps || 6)) {
    throw erroOps(`Limite de recaps atingido (${limites.max_recaps})`, 400);
  }
  const data = hojeIso();
  const estavaMontado = pneu.status_pneu === 'montado' && pneu.veiculo_id;
  const veiculoId = pneu.veiculo_id || null;
  const posicao = pneu.posicao || null;
  let placa = null;
  let substituto = null;
  if (estavaMontado) {
    const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
    placa = veiculo?.placa || null;
    if (!pneuEstoqueId) {
      throw erroOps('Informe o pneu do estoque para ocupar a posição', 400);
    }
    if (Number(pneuEstoqueId) === Number(pneuId)) {
      throw erroOps('O pneu substituto deve ser outro pneu do estoque', 400);
    }
    substituto = await validarSubstitutoEstoque({
      filialId,
      pneuEstoqueId,
      veiculoId,
      posicao,
    });
  }
  let montagem = null;
  await db.transaction(async () => {
    const locked = await travarPneu(db, pneuId);
    if (!locked || locked.status_pneu === 'recapagem' || locked.status_pneu === 'descarte') {
      throw Object.assign(new Error('Pneu já está em recapagem'), { status: 400 });
    }
    const vida = (locked.vida_recap || 0) + 1;
    if (vida > (limites.max_recaps || 6)) {
      throw Object.assign(new Error(`Limite de recaps atingido (${limites.max_recaps})`), { status: 400 });
    }
    if (estavaMontado) {
      const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
      const retirada = trilhaWhatsApp(auditoria, 'WhatsApp · retirou para recap');
      await registrarMovimentacao(db, {
        pneuId,
        veiculoId: pneu.veiculo_id,
        tipo: 'retirada',
        data,
        km: veiculo?.km_atual,
        hr: veiculo?.hr_atual,
        posicao: pneu.posicao,
        detalhes: retirada.detalhes,
        usuario: retirada.usuario,
        placa: veiculo?.placa,
      });
    }
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = NULL, posicao = NULL, status_pneu = 'recapagem',
        vida_recap = ?, condicao = 'recapado', data_instalacao = NULL
      WHERE id = ? AND status_pneu IS DISTINCT FROM 'recapagem'
    `).run(vida, pneuId);
    const envio = trilhaWhatsApp(
      auditoria,
      estavaMontado
        ? `WhatsApp · enviou à recap (${novaVida}ª vida) · origem ${placa || ''} ${posicao || ''}`.trim()
        : `WhatsApp · enviou à recap (${novaVida}ª vida) · origem estoque`,
    );
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId: estavaMontado ? veiculoId : null,
      tipo: 'recap',
      data,
      km: null,
      hr: null,
      posicao: estavaMontado ? posicao : null,
      detalhes: envio.detalhes,
      usuario: envio.usuario,
      placa,
      ciclo: locked.vida_recap || 0,
    });
    if (estavaMontado && substituto) {
      falharTxSeTeste();
      montagem = await montarPneu({
        filialId,
        pneuId: substituto.estoque.id,
        veiculoId,
        posicao,
        auditoria,
      });
    }
  });
  return {
    fogo: pneu.numero_fogo,
    vida: (pneu.vida_recap || 0) + 1,
    estava_montado: Boolean(estavaMontado),
    veiculo_id: veiculoId,
    posicao,
    placa,
    substituto: montagem,
  };
}

/** Recap concluído: pneu volta ao estoque para reuso */
export async function devolverRecapAoEstoque({ filialId, pneuId, auditoria = null }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw Object.assign(new Error('Pneu não encontrado'), { status: 404 });
  if (pneu.status_pneu !== 'recapagem') {
    throw Object.assign(new Error('Pneu não está em recapagem'), { status: 400 });
  }
  const data = hojeIso();
  await db.transaction(async () => {
    const locked = await travarPneu(db, pneuId);
    if (!locked || locked.status_pneu !== 'recapagem') {
      throw Object.assign(new Error('Pneu não está em recapagem'), { status: 400 });
    }
    await db.prepare(`
      UPDATE pneus SET
        status_pneu = 'estoque',
        condicao = 'recapado',
        veiculo_id = NULL,
        posicao = NULL,
        data_instalacao = NULL
      WHERE id = ? AND status_pneu = 'recapagem'
    `).run(pneuId);
    const volta = trilhaWhatsApp(
      auditoria,
      `WhatsApp · recap concluído · voltou ao estoque (${pneu.vida_recap || 1}ª vida)`,
    );
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId: null,
      tipo: 'retorno_recap',
      data,
      km: null,
      hr: null,
      posicao: null,
      detalhes: volta.detalhes,
      usuario: volta.usuario,
      placa: null,
      ciclo: pneu.vida_recap || 0,
    });
  });
  return {
    fogo: pneu.numero_fogo,
    vida: pneu.vida_recap || 1,
    mensagem: `Fogo ${pneu.numero_fogo} voltou ao estoque (recapado)`,
  };
}

/**
 * Troca o pneu montado por outro do estoque na mesma posição (validação + transação única).
 */
export async function trocarPorEstoque({ filialId, pneuMontadoId, pneuEstoqueId, auditoria = null }) {
  const db = getDb();
  const montado = await db.prepare(`
    SELECT * FROM pneus
    WHERE id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'montado'
  `).get(pneuMontadoId, filialId);
  if (!montado) throw erroOps('Pneu montado não encontrado', 404);
  if (!montado.veiculo_id || !montado.posicao) {
    throw erroOps('Pneu montado sem veículo/posição', 400);
  }
  if (Number(pneuEstoqueId) === Number(pneuMontadoId)) {
    throw erroOps('O pneu substituto deve ser outro pneu do estoque', 400);
  }

  const { estoque } = await validarSubstitutoEstoque({
    filialId,
    pneuEstoqueId,
    veiculoId: montado.veiculo_id,
    posicao: montado.posicao,
  });

  const { retirado, montagem } = await db.transaction(async () => {
    const retiradoTx = await desmontarPneu({ filialId, pneuId: montado.id, auditoria });
    falharTxSeTeste();
    const montagemTx = await montarPneu({
      filialId,
      pneuId: estoque.id,
      veiculoId: montado.veiculo_id,
      posicao: montado.posicao,
      auditoria,
    });
    return { retirado: retiradoTx, montagem: montagemTx };
  });
  return {
    mensagem: `Trocou fogo ${retirado.fogo} → ${montagem.fogo} em ${montagem.label}`,
    retirado,
    montado: montagem,
  };
}

/**
 * Move o pneu para outro veículo/posição da frota.
 * Se a posição destino estiver ocupada, troca os dois pneus (swap).
 */
export async function moverOuTrocarNaFrota({
  filialId,
  pneuId,
  veiculoDestinoId,
  posicaoDestino,
  detalhes = null,
}) {
  const db = getDb();
  const posDest = String(posicaoDestino || '').trim().toUpperCase();
  if (!posDest) {
    throw Object.assign(new Error('Informe a posição de destino'), { status: 400 });
  }

  const origem = await db.prepare(`
    SELECT p.*, v.placa as placa_origem, v.km_atual as km_origem, v.hr_atual as hr_origem
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1
    WHERE p.id = ? AND p.filial_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
  `).get(pneuId, filialId);
  if (!origem) {
    throw Object.assign(new Error('Pneu montado não encontrado'), { status: 404 });
  }

  const veiculoDest = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoDestinoId, filialId);
  if (!veiculoDest) {
    throw Object.assign(new Error('Veículo de destino não encontrado'), { status: 404 });
  }
  assertVeiculoOperacional(veiculoDest);

  const layoutDest = getLayout(veiculoDest.layout_pneus || LAYOUT_PADRAO);
  if (!layoutDest.posicoes.includes(posDest)) {
    throw Object.assign(new Error(`Posição ${posDest} inválida no veículo ${veiculoDest.placa}`), { status: 400 });
  }

  if (Number(origem.veiculo_id) === Number(veiculoDest.id) && origem.posicao === posDest) {
    throw Object.assign(new Error('Pneu já está nesta posição'), { status: 400 });
  }

  const valOrigem = validarMontagem({
    condicao: origem.condicao,
    tipo_pneu: origem.tipo_pneu,
    posicao: posDest,
  });
  if (!valOrigem.ok) {
    throw Object.assign(new Error(valOrigem.erros.join(' ')), { status: 400 });
  }

  const ocupante = await db.prepare(`
    SELECT p.*, v.placa as placa_ocupante
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.veiculo_id = ? AND p.posicao = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
  `).get(veiculoDest.id, posDest, origem.id);

  const data = hojeIso();
  const posOrigem = origem.posicao;
  const veiculoOrigemId = origem.veiculo_id;
  const placaOrigem = origem.placa_origem;

  if (ocupante) {
    const valOcupante = validarMontagem({
      condicao: ocupante.condicao,
      tipo_pneu: ocupante.tipo_pneu,
      posicao: posOrigem,
    });
    if (!valOcupante.ok) {
      throw Object.assign(
        new Error(`Não dá para trocar: pneu fogo ${ocupante.numero_fogo} não serve em ${labelPosicao(posOrigem)}. ${valOcupante.erros.join(' ')}`),
        { status: 400 }
      );
    }

    await db.transaction(async () => {
      // Libera destino temporariamente (evita unique parcial)
      await db.prepare(`
        UPDATE pneus SET posicao = NULL WHERE id = ?
      `).run(ocupante.id);

      await db.prepare(`
        UPDATE pneus SET veiculo_id = ?, posicao = ?, data_instalacao = COALESCE(data_instalacao, ?)
        WHERE id = ?
      `).run(veiculoDest.id, posDest, data, origem.id);

      await db.prepare(`
        UPDATE pneus SET veiculo_id = ?, posicao = ?, data_instalacao = COALESCE(data_instalacao, ?)
        WHERE id = ?
      `).run(veiculoOrigemId, posOrigem, data, ocupante.id);

      const detBase = detalhes?.trim()
        || `Troca na frota · ${placaOrigem} ${labelPosicao(posOrigem)} ↔ ${veiculoDest.placa} ${labelPosicao(posDest)}`;

      await registrarMovimentacao(db, {
        pneuId: origem.id,
        veiculoId: veiculoDest.id,
        tipo: 'mudanca_posicao',
        data,
        km: veiculoDest.km_atual,
        hr: veiculoDest.hr_atual,
        posicao: posDest,
        detalhes: `${detBase} · fogo ${origem.numero_fogo}`,
        placa: veiculoDest.placa,
      });
      await registrarMovimentacao(db, {
        pneuId: ocupante.id,
        veiculoId: veiculoOrigemId,
        tipo: 'mudanca_posicao',
        data,
        km: origem.km_origem,
        hr: origem.hr_origem,
        posicao: posOrigem,
        detalhes: `${detBase} · fogo ${ocupante.numero_fogo}`,
        placa: placaOrigem,
      });
    });

    return {
      modo: 'troca',
      mensagem: `Trocou fogo ${origem.numero_fogo} (${placaOrigem} ${labelPosicao(posOrigem)}) ↔ fogo ${ocupante.numero_fogo} (${veiculoDest.placa} ${labelPosicao(posDest)})`,
      origem: {
        id: origem.id,
        fogo: origem.numero_fogo,
        de: { veiculo_id: veiculoOrigemId, placa: placaOrigem, posicao: posOrigem },
        para: { veiculo_id: veiculoDest.id, placa: veiculoDest.placa, posicao: posDest },
      },
      destino: {
        id: ocupante.id,
        fogo: ocupante.numero_fogo,
        de: { veiculo_id: veiculoDest.id, placa: veiculoDest.placa, posicao: posDest },
        para: { veiculo_id: veiculoOrigemId, placa: placaOrigem, posicao: posOrigem },
      },
    };
  }

  // Posição livre: só move
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE pneus SET veiculo_id = ?, posicao = ?, data_instalacao = COALESCE(data_instalacao, ?)
      WHERE id = ?
    `).run(veiculoDest.id, posDest, data, origem.id);

    await registrarMovimentacao(db, {
      pneuId: origem.id,
      veiculoId: veiculoDest.id,
      tipo: 'mudanca_posicao',
      data,
      km: veiculoDest.km_atual,
      hr: veiculoDest.hr_atual,
      posicao: posDest,
      detalhes: detalhes?.trim()
        || `Moveu na frota · ${placaOrigem} ${labelPosicao(posOrigem)} → ${veiculoDest.placa} ${labelPosicao(posDest)}`,
      placa: veiculoDest.placa,
    });
  });

  return {
    modo: 'mover',
    mensagem: `Moveu fogo ${origem.numero_fogo}: ${placaOrigem} ${labelPosicao(posOrigem)} → ${veiculoDest.placa} ${labelPosicao(posDest)}`,
    origem: {
      id: origem.id,
      fogo: origem.numero_fogo,
      de: { veiculo_id: veiculoOrigemId, placa: placaOrigem, posicao: posOrigem },
      para: { veiculo_id: veiculoDest.id, placa: veiculoDest.placa, posicao: posDest },
    },
  };
}

export async function registrarDescarte({ filialId, pneuId, motivo = null, pneuEstoqueId = null, auditoria = null }) {
  const db = getDb();
  const pneu = await db.prepare(`
    SELECT p.*, v.placa, v.km_atual, v.hr_atual
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.id = ? AND p.filial_id = ? AND p.ativo = 1
  `).get(pneuId, filialId);
  if (!pneu) throw erroOps('Pneu não encontrado', 404);
  if (pneu.status_pneu === 'descarte') {
    throw erroOps('Pneu já está no descarte', 400);
  }
  const data = hojeIso();
  const estavaMontado = pneu.status_pneu === 'montado' && pneu.veiculo_id;
  const veiculoId = pneu.veiculo_id || null;
  const posicao = pneu.posicao || null;
  let substituto = null;
  if (estavaMontado) {
    if (!pneuEstoqueId) {
      throw erroOps('Informe o pneu do estoque para ocupar a posição', 400);
    }
    if (Number(pneuEstoqueId) === Number(pneuId)) {
      throw erroOps('O pneu substituto deve ser outro pneu do estoque', 400);
    }
    substituto = await validarSubstitutoEstoque({
      filialId,
      pneuEstoqueId,
      veiculoId,
      posicao,
    });
  }
  let montagem = null;
  await db.transaction(async () => {
    if (estavaMontado) {
      const retirada = trilhaWhatsApp(auditoria, 'WhatsApp · retirou para descarte');
      await registrarMovimentacao(db, {
        pneuId,
        veiculoId: pneu.veiculo_id,
        tipo: 'retirada',
        data,
        km: pneu.km_atual,
        hr: pneu.hr_atual,
        posicao: pneu.posicao,
        detalhes: retirada.detalhes,
        usuario: retirada.usuario,
        placa: pneu.placa,
      });
    }
    await db.prepare(`
      UPDATE pneus SET
        veiculo_id = NULL, posicao = NULL, status_pneu = 'descarte', ativo = 0,
        tratamento_descarte = 'pendente',
        tratamento_descarte_obs = ?,
        tratamento_descarte_em = ?,
        data_instalacao = NULL
      WHERE id = ?
    `).run(motivo?.trim() || null, data, pneuId);
    const descarte = trilhaWhatsApp(auditoria, motivo?.trim() || 'WhatsApp · enviou ao descarte');
    await registrarMovimentacao(db, {
      pneuId,
      veiculoId: estavaMontado ? veiculoId : null,
      tipo: 'descarte',
      data,
      km: pneu.km_atual,
      hr: pneu.hr_atual,
      posicao: estavaMontado ? posicao : null,
      detalhes: descarte.detalhes,
      usuario: descarte.usuario,
      placa: pneu.placa || null,
      ciclo: pneu.vida_recap || 0,
      motivo: motivo?.trim() || null,
    });
    if (estavaMontado && substituto) {
      falharTxSeTeste();
      montagem = await montarPneu({
        filialId,
        pneuId: substituto.estoque.id,
        veiculoId,
        posicao,
        auditoria,
      });
    }
  });
  return {
    fogo: pneu.numero_fogo,
    estava_montado: Boolean(estavaMontado),
    veiculo_id: veiculoId,
    posicao,
    placa: pneu.placa || null,
    substituto: montagem,
  };
}

const SULCO_MIN_MM = 0;
const SULCO_MAX_MM = 40;

function pontosDeValores(valores) {
  const v = Array.isArray(valores) ? valores : [];
  return {
    sulco_externo: v[0] ?? null,
    sulco_central: v[1] ?? null,
    sulco_interno: v[2] ?? null,
    sulco_auxiliar: v[3] ?? null,
  };
}

function formatarValoresSulco(valores) {
  return (valores || []).map((n) => String(n)).join('/');
}

export function validarKmInformado(km, kmAtual) {
  if (km == null || km === '') return null;
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || n > 9999999) {
    return 'KM inválido';
  }
  const atual = Number(kmAtual);
  if (Number.isFinite(atual) && n < atual) {
    return `KM ${n} é menor que o atual (${atual})`;
  }
  return null;
}

export function validarValoresSulco(valores) {
  if (!Array.isArray(valores) || (valores.length !== 3 && valores.length !== 4)) {
    return 'Informe 3 ou 4 valores de sulco (ex.: 14,14,14)';
  }
  for (const n of valores) {
    if (!Number.isFinite(n) || n < SULCO_MIN_MM || n > SULCO_MAX_MM) {
      return `Sulco inválido (${n}). Use valores de ${SULCO_MIN_MM} a ${SULCO_MAX_MM} mm`;
    }
  }
  return null;
}

/**
 * Valida lote de medições WhatsApp (filial, layout, pneu montado, valores).
 * Não grava.
 */
export async function validarMedicoesWhatsApp({ filialId, veiculoId, linhas }) {
  const db = getDb();
  const veiculo = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoId, filialId);
  if (!veiculo) throw erroOps('Veículo não encontrado nesta unidade', 404);
  assertVeiculoOperacional(veiculo);

  const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
  const ok = [];
  const erros = [];
  const vistos = new Set();

  for (const linha of linhas || []) {
    const pos = String(linha.posicao || '').trim().toUpperCase();
    if (!pos) continue;
    if (vistos.has(pos)) {
      const idx = ok.findIndex((i) => i.posicao === pos);
      if (idx >= 0) ok.splice(idx, 1);
      const eidx = erros.findIndex((i) => i.posicao === pos);
      if (eidx >= 0) erros.splice(eidx, 1);
    }
    vistos.add(pos);

    if (linha.erro === 'posicao_desconhecida' || !layout.posicoes.includes(pos)) {
      erros.push({ posicao: pos, motivo: `posição inválida neste veículo` });
      continue;
    }
    const errVal = linha.erro === 'qtd_valores' || linha.erro === 'valores_invalidos'
      ? 'Informe 3 ou 4 valores de sulco (ex.: 14,14,14)'
      : validarValoresSulco(linha.valores);
    if (errVal) {
      erros.push({ posicao: pos, motivo: errVal });
      continue;
    }

    const pneu = await db.prepare(`
      SELECT p.*, v.placa, v.tipo as veiculo_tipo, v.layout_pneus, v.km_atual, v.hr_atual
      FROM pneus p
      JOIN veiculos v ON v.id = p.veiculo_id
      WHERE p.veiculo_id = ? AND p.filial_id = ? AND p.ativo = 1
        AND p.status_pneu = 'montado' AND UPPER(p.posicao) = ?
    `).get(veiculoId, filialId, pos);
    if (!pneu) {
      erros.push({ posicao: pos, motivo: 'sem pneu montado' });
      continue;
    }
    if (Number(pneu.filial_id) !== Number(filialId)) {
      erros.push({ posicao: pos, motivo: 'pneu de outra unidade' });
      continue;
    }
    assertPneuOperacional(pneu);

    const pontos = pontosDeValores(linha.valores);
    const menor = menorSulco(pontos);
    const limites = limitesDoVeiculo(veiculo);
    ok.push({
      posicao: pos,
      pneu_id: pneu.id,
      numero_fogo: pneu.numero_fogo,
      valores: linha.valores,
      ...pontos,
      menor,
      status_sulco: classificarSulco(menor, limites),
      km_atual: pneu.km_atual,
      hr_atual: pneu.hr_atual,
      vida_recap: pneu.vida_recap,
      veiculo_tipo: pneu.veiculo_tipo,
      layout_pneus: pneu.layout_pneus,
    });
  }

  return { veiculo, ok, erros };
}

async function candidatosRodizio(db, veiculoId, pneuId) {
  const rows = await db.prepare(`
    SELECT p.id, p.posicao, p.numero_fogo,
      (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
      (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
      (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
      (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux
    FROM pneus p
    WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
  `).all(veiculoId, pneuId);
  return rows.map((c) => ({
    ...c,
    posicao_label: c.posicao,
    sulco_externo: c.ult_sulco_ext,
    sulco_central: c.ult_sulco_cent,
    sulco_interno: c.ult_sulco_int,
    sulco_auxiliar: c.ult_sulco_aux,
  }));
}

async function registrarUmaMedicao(db, {
  pneu, veiculo, pontos, filialId, data, km, hr, responsavel,
}) {
  const limites = limitesDoVeiculo(veiculo);
  const menor = menorSulco(pontos);
  const diag = diagnosticarPerfil(pontos, limites.diagnostico_tolerancia_mm, {
    papel: pneu.posicao ? papelPosicao(pneu.posicao) : null,
    posicao: pneu.posicao || null,
    limites,
  });
  const candidatos = pneu.veiculo_id
    ? await candidatosRodizio(db, pneu.veiculo_id, pneu.id)
    : [];
  const acao = sugerirAcao(menor, limites, pneu.vida_recap || 0, {
    pontos,
    candidatos,
    posicaoAtual: pneu.posicao || null,
  });
  const statusSulco = classificarSulco(menor, limites);

  const anterior = await db.prepare(`
    SELECT * FROM medicoes WHERE pneu_id = ?
    ORDER BY data_medicao DESC, id DESC LIMIT 1
  `).get(pneu.id);

  let desgaste = null;
  if (anterior && km != null) {
    desgaste = desgastePorKm(menorSulco(anterior), menor, anterior.km_veiculo, km);
  }

  if (pneu.sulco_inicial_mm == null && menor != null) {
    await db.prepare('UPDATE pneus SET sulco_inicial_mm = ? WHERE id = ?').run(menor, pneu.id);
  }

  if (statusSulco === 'alerta') {
    await db.prepare(`
      UPDATE pneus SET data_alerta_monitorar = COALESCE(data_alerta_monitorar, ?)
      WHERE id = ?
    `).run(data, pneu.id);
  } else if (statusSulco === 'ok' || statusSulco === 'critico') {
    await db.prepare(`UPDATE pneus SET data_alerta_monitorar = NULL WHERE id = ?`).run(pneu.id);
  }

  const mesmoNumero = (a, b) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Number(a) === Number(b);
  };
  const reaproveitar = Boolean(
    anterior
    && String(anterior.data_medicao) === String(data)
    && mesmoNumero(anterior.sulco_externo, pontos.sulco_externo)
    && mesmoNumero(anterior.sulco_central, pontos.sulco_central)
    && mesmoNumero(anterior.sulco_interno, pontos.sulco_interno)
    && mesmoNumero(anterior.sulco_auxiliar, pontos.sulco_auxiliar)
  );

  let medicaoId;
  if (reaproveitar) {
    await db.prepare(`
      UPDATE medicoes SET
        km_veiculo = ?, hr_veiculo = ?, responsavel = ?, observacoes = ?,
        diagnostico = ?, acao_sugerida = ?, desgaste_mm_km = ?, veiculo_placa = ?
      WHERE id = ?
    `).run(
      km ?? null, hr ?? null, responsavel, 'WhatsApp',
      diag.codigo, acao.codigo, desgaste, veiculo.placa, anterior.id
    );
    medicaoId = anterior.id;
  } else {
    const result = await db.prepare(`
      INSERT INTO medicoes (
        pneu_id, data_medicao, km_veiculo, hr_veiculo,
        sulco_externo, sulco_central, sulco_interno, sulco_auxiliar,
        responsavel, observacoes, diagnostico, acao_sugerida, desgaste_mm_km, veiculo_placa
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pneu.id, data, km ?? null, hr ?? null,
      pontos.sulco_externo, pontos.sulco_central, pontos.sulco_interno, pontos.sulco_auxiliar,
      responsavel, 'WhatsApp', diag.codigo, acao.codigo, desgaste, veiculo.placa
    );
    medicaoId = result.lastInsertRowid;
  }

  return {
    medicaoId,
    reaproveitar,
    menor,
    statusSulco,
    diag,
    acao,
    pneu,
  };
}

export async function registrarMedicoesWhatsApp({
  filialId, veiculoId, itens, responsavel, kmInformado = null,
}) {
  const db = getDb();
  const veiculo = await db.prepare(`
    SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
  `).get(veiculoId, filialId);
  if (!veiculo) throw erroOps('Veículo não encontrado nesta unidade', 404);
  assertVeiculoOperacional(veiculo);
  if (!itens?.length) throw erroOps('Nenhuma medição para salvar', 400);
  const errKm = validarKmInformado(kmInformado, veiculo.km_atual);
  if (errKm) throw erroOps(errKm, 400);
  const kmUso = kmInformado != null ? Number(kmInformado) : (veiculo.km_atual ?? null);

  const data = hojeIso();
  const agora = new Date();
  const hora = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  const resp = String(responsavel || `WhatsApp ${hora}`).trim();
  const gravados = [];

  await db.transaction(async () => {
    falharTxSeTeste();
    if (kmInformado != null) {
      await db.prepare(`
        UPDATE veiculos SET km_atual = MAX(km_atual, ?), updated_at = NOW()
        WHERE id = ? AND filial_id = ?
      `).run(kmUso, veiculoId, filialId);
      veiculo.km_atual = kmUso;
    }
    for (const item of itens) {
      const pneu = await db.prepare(`
        SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
      `).get(item.pneu_id, filialId);
      if (!pneu || pneu.status_pneu !== 'montado' || Number(pneu.veiculo_id) !== Number(veiculoId)) {
        throw erroOps(`Pneu da posição ${item.posicao} não está montado neste veículo`, 400);
      }
      const pontos = {
        sulco_externo: item.sulco_externo ?? null,
        sulco_central: item.sulco_central ?? null,
        sulco_interno: item.sulco_interno ?? null,
        sulco_auxiliar: item.sulco_auxiliar ?? null,
      };
      const r = await registrarUmaMedicao(db, {
        pneu,
        veiculo,
        pontos,
        filialId,
        data,
        km: kmUso,
        hr: veiculo.hr_atual,
        responsavel: resp,
      });
      gravados.push({
        posicao: item.posicao,
        pneu_id: pneu.id,
        medicao_id: r.medicaoId,
        menor: r.menor,
        status_sulco: r.statusSulco,
        diagnostico: r.diag.codigo,
        acao: r.acao.codigo,
        reaproveitar: r.reaproveitar,
        pneu,
        diag: r.diag,
        acaoObj: r.acao,
      });
    }
  });

  for (const g of gravados) {
    if (g.reaproveitar) continue;
    try {
      await notificarGerentesAposMedicao({
        statusSulco: g.status_sulco,
        diagnosticoLabel: g.diag.label,
        acaoLabel: g.acaoObj.label,
        menorSulco: g.menor,
        veiculo,
        pneu: g.pneu,
        medicaoId: g.medicao_id,
      });
    } catch (err) {
      console.error('[medicao-wa] alerta:', err.message);
    }
  }

  return {
    placa: veiculo.placa,
    data,
    hora,
    km: kmUso,
    responsavel: resp,
    total: gravados.length,
    itens: gravados,
  };
}

export function textoResumoMedicaoWa(placa, itens, { kmAtual = null, kmInformado = null } = {}) {
  const labelStatus = { ok: 'OK', alerta: 'Alerta', critico: 'Crítico', sem_dado: '-' };
  const kmTxt = kmInformado != null ? kmInformado : kmAtual;
  const linhas = [
    `📏 *${placa}*${kmTxt != null ? ` · KM ${kmTxt}` : ''}`,
    ...itens.map((i) => {
      const vals = formatarValoresSulco(i.valores);
      const st = labelStatus[i.status_sulco] || i.status_sulco;
      return `• ${i.posicao}: ${vals} — ${st}`;
    }),
    '',
    '*1* salva · *0* cancela',
  ];
  return linhas.join('\n');
}

export { labelPosicao, TIPOS_PNEU, CONDICOES_PNEU };
