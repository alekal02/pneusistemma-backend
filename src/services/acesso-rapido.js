/**
 * Tokens de acesso rápido (links WhatsApp sem JWT)
 * tipos: medir | cadastrar_veiculo | cadastrar_pneu | troca
 */
import { randomBytes } from 'crypto';
import { getDb, classificarSulco } from '../database.js';
import { config } from '../config.js';
import { getLimites, limitesDoVeiculo, menorSulco } from '../limites.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { diagnosticarPerfil, sugerirAcao, percentualVida } from '../diagnostico.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import {
  POSICOES_PNEU,
  LAYOUTS_PNEU,
  LAYOUT_PADRAO,
  labelPosicao,
  papelPosicao,
  sqlOrderPosicao,
  getLayout,
  labelTipoPneu,
} from '../pneus-layouts.js';

export const TIPOS_TOKEN_ACESSO = ['medir', 'cadastrar_veiculo', 'cadastrar_pneu', 'troca'];

const PATH_POR_TIPO = {
  medir: '/veiculo-acesso-rapido',
  cadastrar_veiculo: '/acesso-rapido/veiculo',
  cadastrar_pneu: '/acesso-rapido/pneu',
  troca: '/acesso-rapido/troca',
};

export function linkAcessoRapido(tipo, token) {
  const path = PATH_POR_TIPO[tipo] || PATH_POR_TIPO.medir;
  return `${config.frontendUrl.replace(/\/$/, '')}${path}?token=${token}`;
}

/**
 * @param {{ tipo?: string, veiculoId?: number|null, filialId: number, whatsappOrigem?: string|null }} opts
 */
export async function gerarTokenAcessoRapido({
  tipo = 'medir',
  veiculoId = null,
  filialId,
  whatsappOrigem = null,
}) {
  const tipoOk = TIPOS_TOKEN_ACESSO.includes(tipo) ? tipo : 'medir';
  if ((tipoOk === 'medir' || tipoOk === 'troca') && !veiculoId) {
    throw new Error('veiculoId é obrigatório para este tipo de link');
  }
  if (!filialId) throw new Error('filialId é obrigatório');

  const db = getDb();
  const token = randomBytes(32).toString('hex');
  await db.prepare(`
    INSERT INTO tokens_acesso_rapido (token, veiculo_id, filial_id, tipo, whatsapp_origem, expira_em)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime', '+24 hours'))
  `).run(token, veiculoId || null, filialId, tipoOk, whatsappOrigem);

  const link = linkAcessoRapido(tipoOk, token);
  if (/localhost|127\.0\.0\.1/i.test(link)) {
    console.warn(
      '[acesso-rapido] FRONTEND_URL aponta para localhost — o link não abre no celular. '
      + 'Defina o IP da rede em backend/.env (ex.: http://10.0.0.231:5173).'
    );
  }
  return { token, link, tipo: tipoOk };
}

export async function validarTokenAcessoRapido(token, tiposPermitidos = null) {
  if (!token) return null;
  const db = getDb();
  const row = await db.prepare(`
    SELECT * FROM tokens_acesso_rapido
    WHERE token = ? AND expira_em > datetime('now', 'localtime')
  `).get(token);
  if (!row) return null;
  const tipo = row.tipo || 'medir';
  if (Array.isArray(tiposPermitidos) && tiposPermitidos.length && !tiposPermitidos.includes(tipo)) {
    return null;
  }
  return { ...row, tipo };
}

export async function marcarTokenUsado(tokenId) {
  const db = getDb();
  await db.prepare(`
    UPDATE tokens_acesso_rapido
    SET usado_em = COALESCE(usado_em, datetime('now', 'localtime'))
    WHERE id = ?
  `).run(tokenId);
}

export async function listarEstoqueFilial(filialId, limite = 40) {
  const db = getDb();
  return db.prepare(`
    SELECT id, numero_fogo, marca, modelo, tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu
    FROM pneus
    WHERE filial_id = ? AND ativo = 1 AND status_pneu = 'estoque'
    ORDER BY LOWER(COALESCE(numero_fogo, '')), id
    LIMIT ?
  `).all(filialId, limite);
}

/** Mesmo payload de GET /veiculos/:id */
export async function montarDetalheVeiculo(veiculoId, filialId = null) {
  const db = getDb();

  let veiculo;
  if (filialId != null) {
    veiculo = await db.prepare(`
      SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
    `).get(veiculoId, filialId);
  } else {
    veiculo = await db.prepare(`
      SELECT * FROM veiculos WHERE id = ? AND ativo = 1
    `).get(veiculoId);
  }
  if (!veiculo) return null;
  const limites = limitesDoVeiculo(veiculo);

  const orderSql = sqlOrderPosicao('p.posicao');
  const pneus = await db.prepare(`
    SELECT p.*,
      um.sulco_externo as ult_sulco_ext,
      um.sulco_central as ult_sulco_cent,
      um.sulco_interno as ult_sulco_int,
      um.sulco_auxiliar as ult_sulco_aux,
      um.diagnostico as ult_diagnostico,
      um.acao_sugerida as ult_acao,
      um.data_medicao as ult_medicao
    FROM pneus p
    ${SQL_LATERAL_ULTIMA_MEDICAO}
    WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
    ORDER BY ${orderSql}
  `).all(veiculoId);

  const basePneus = pneus.map((p) => {
    const row = {
      sulco_externo: p.ult_sulco_ext,
      sulco_central: p.ult_sulco_cent,
      sulco_interno: p.ult_sulco_int,
      sulco_auxiliar: p.ult_sulco_aux,
    };
    const menor = menorSulco(row);
    const diag = diagnosticarPerfil(row, limites.diagnostico_tolerancia_mm, {
      papel: papelPosicao(p.posicao),
      posicao: p.posicao,
    });
    const sulcoRef = p.sulco_inicial_mm ?? limites.sulco_novo_mm;

    return {
      ...p,
      _row: row,
      posicao_label: labelPosicao(p.posicao),
      papel_posicao: papelPosicao(p.posicao),
      padrao: p.tipo_pneu,
      padrao_label: labelTipoPneu(p.tipo_pneu),
      menor_sulco: menor,
      status_sulco: classificarSulco(menor, limites),
      diagnostico: diag.codigo,
      diagnostico_label: diag.label,
      diagnostico_desc: diag.descricao || '',
      vida_util_pct: percentualVida(menor, sulcoRef, limites.sulco_critico_mm),
      vida_label: p.vida_recap > 0
        ? `${p.vida_recap}ª recap`
        : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
      ultima_medicao: p.ult_medicao || menor != null
        ? {
          data: p.ult_medicao || null,
          sulco_externo: p.ult_sulco_ext,
          sulco_central: p.ult_sulco_cent,
          sulco_interno: p.ult_sulco_int,
          sulco_auxiliar: p.ult_sulco_aux,
          menor_sulco: menor,
        }
        : null,
    };
  });

  const pneusComStatus = basePneus.map((p) => {
    const candidatos = basePneus.filter((c) => c.id !== p.id);
    const acao = sugerirAcao(p.menor_sulco, limites, p.vida_recap || 0, {
      pontos: p._row,
      candidatos,
      posicaoAtual: p.posicao,
    });
    const { _row, ...rest } = p;
    return {
      ...rest,
      acao_sugerida: acao.codigo,
      acao_label: acao.label,
      acao_motivo: acao.motivo,
      desvio_mm: acao.desvio_mm ?? null,
      rodizio_sugestao: acao.rodizio_sugestao || null,
    };
  });

  const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
  const posicoesLayout = (LAYOUTS_PNEU[veiculo.layout_pneus]
    ? layout.posicoes
    : layout.posicoes).map((codigo) => ({
    codigo,
    label: labelPosicao(codigo),
    papel: papelPosicao(codigo),
    montado: pneusComStatus.some((p) => p.posicao === codigo),
  }));

  const medicoes = await db.prepare(`
    SELECT m.*, p.posicao, p.numero_fogo
    FROM medicoes m
    JOIN pneus p ON m.pneu_id = p.id
    WHERE p.veiculo_id = ?
    ORDER BY m.data_medicao DESC, m.id DESC
    LIMIT 20
  `).all(veiculoId);

  return {
    ...veiculo,
    tipo: normalizarTipoVeiculo(veiculo.tipo),
    pneus: pneusComStatus,
    posicoes_layout: posicoesLayout,
    layout: {
      id: veiculo.layout_pneus || LAYOUT_PADRAO,
      nome: layout.nome,
      posicoes: layout.posicoes,
    },
    medicoes,
    posicoes: POSICOES_PNEU,
    limites,
    token_valido: true,
  };
}

export async function resumoStatusPneusVeiculo(veiculoId) {
  const detalhe = await montarDetalheVeiculo(veiculoId);
  if (!detalhe) return { criticos: 0, alertas: 0, ok: 0, ultimaMedicao: null };

  const criticos = detalhe.pneus.filter((p) => p.status_sulco === 'critico').length;
  const alertas = detalhe.pneus.filter((p) => p.status_sulco === 'alerta').length;
  const ok = detalhe.pneus.filter((p) => p.status_sulco === 'ok').length;

  const ultima = detalhe.medicoes?.[0] || null;
  let ultimaMedicao = null;
  if (ultima) {
    const menor = menorSulco(ultima);
    ultimaMedicao = {
      data_medicao: ultima.data_medicao,
      posicao: ultima.posicao,
      numero_fogo: ultima.numero_fogo,
      menor_sulco: menor,
    };
  }

  return { criticos, alertas, ok, ultimaMedicao };
}

/**
 * Resumo leve para resposta WhatsApp (evita montarDetalheVeiculo completo).
 */
export async function resumoStatusPneusVeiculoRapido(veiculoId) {
  const db = getDb();

  const veiculo = await db.prepare(`
    SELECT tipo, layout_pneus FROM veiculos WHERE id = ?
  `).get(veiculoId);
  const limites = limitesDoVeiculo(veiculo || {});

  const rows = await db.prepare(`
    SELECT
      p.posicao,
      p.numero_fogo,
      m.data_medicao,
      m.sulco_externo,
      m.sulco_central,
      m.sulco_interno,
      m.sulco_auxiliar
    FROM pneus p
    LEFT JOIN medicoes m ON m.id = (
      SELECT id FROM medicoes
      WHERE pneu_id = p.id
      ORDER BY data_medicao DESC, id DESC
      LIMIT 1
    )
    WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
  `).all(veiculoId);

  let criticos = 0;
  let alertas = 0;
  let ok = 0;
  let ultimaMedicao = null;

  for (const r of rows) {
    const menor = menorSulco(r);
    const status = classificarSulco(menor, limites);
    if (status === 'critico') criticos += 1;
    else if (status === 'alerta') alertas += 1;
    else if (status === 'ok') ok += 1;

    if (r.data_medicao) {
      if (!ultimaMedicao || String(r.data_medicao) > String(ultimaMedicao.data_medicao)) {
        ultimaMedicao = {
          data_medicao: r.data_medicao,
          posicao: r.posicao,
          numero_fogo: r.numero_fogo,
          menor_sulco: menor,
        };
      }
    }
  }

  return { criticos, alertas, ok, ultimaMedicao };
}
