import { Router } from 'express';
import { getDb } from '../database.js';
import { comSavepoint, ehViolacaoUnique } from '../db-utils.js';
import { getLimites, limitesDoVeiculo, adicionarDias } from '../limites.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { percentualVida } from '../diagnostico.js';
import { avaliarAlertaPerfil } from '../medicao-perfil.js';
import {
  validarMontagem,
  papelPosicao,
  labelPosicao,
  TIPOS_PNEU,
  CONDICOES_PNEU,
  STATUS_PNEU,
  getLayout,
  LAYOUT_PADRAO,
  labelTipoPneu,
  TRATAMENTOS_DESCARTE,
  labelTratamentoDescarte,
} from '../pneus-layouts.js';
import {
  requireAuth,
  requireFilial,
  filialScopeId,
  assertPneuDaFilial,
  assertVeiculoDaFilial,
} from '../auth.js';
import {
  parseCsv,
  toCsv,
  PNEU_TEMPLATE_HEADERS,
  PNEU_TEMPLATE_ROWS,
  mapTipoPneu,
  mapCondicao,
  placaDaLinha,
  encaixarPosicaoNoLayout,
} from '../csv-utils.js';
import { registrarMovimentacao, atualizarKmHrVeiculo, travarPneu } from '../services/pneu-movimentacao.js';
import { calcularCiclos } from '../services/pneu-ciclo.js';
import {
  trocarPorEstoque,
  moverOuTrocarNaFrota,
} from '../services/whatsapp-ops.js';
import {
  consultarProximoFogo,
  criarGeradorNumeroFogo,
  comRetryFogoUnico,
  resolverNumeroFogo,
  assertFogoLivre,
} from '../numero-fogo.js';

const router = Router();

/** Únicas movimentações operacionais do pneu */
const TIPOS_MOVIMENTACAO = ['montagem', 'retirada', 'mudanca_posicao'];

router.use(requireAuth);
router.use(requireFilial);

function usuarioDe(req) {
  return req.user?.login || null;
}

async function ultimoSulcoPneu(db, pneuId) {
  const row = await db.prepare(`
    SELECT sulco_externo, sulco_central, sulco_interno, sulco_auxiliar, sulco_mm
    FROM medicoes WHERE pneu_id = ?
    ORDER BY data_medicao DESC, id DESC LIMIT 1
  `).get(pneuId);
  if (!row) return null;
  const vals = [row.sulco_externo, row.sulco_central, row.sulco_interno, row.sulco_auxiliar, row.sulco_mm]
    .map((v) => (v == null || v === '' ? NaN : Number(v)))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return Math.min(...vals);
}

function enriquecerPrazoRecap(pneu, statusSulco, limites) {
  const prazoDias = limites.prazo_recap_dias ?? 15;
  if (statusSulco !== 'alerta' || !pneu.data_alerta_monitorar) {
    return {
      prazo_recap_dias: prazoDias,
      data_limite_recap: null,
      dias_restantes_recap: null,
    };
  }
  const limite = adicionarDias(pneu.data_alerta_monitorar, prazoDias);
  const hoje = new Date();
  const [y, m, d] = String(limite).split('-').map(Number);
  const fim = new Date(y, m - 1, d);
  const dias = Math.ceil((fim - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000);
  return {
    prazo_recap_dias: prazoDias,
    data_limite_recap: limite,
    dias_restantes_recap: dias,
  };
}

async function sincronizarAlertaMonitorar(db, pneuId, statusSulco, dataRef) {
  if (statusSulco === 'alerta') {
    await db.prepare(`
      UPDATE pneus SET data_alerta_monitorar = COALESCE(data_alerta_monitorar, ?)
      WHERE id = ?
    `).run(dataRef, pneuId);
  } else if (statusSulco === 'ok' || statusSulco === 'critico') {
    await db.prepare(`
      UPDATE pneus SET data_alerta_monitorar = NULL WHERE id = ?
    `).run(pneuId);
  }
}

function enriquecerPneu(pneu, ultimaMedicao = null, candidatos = []) {
  const limites = pneu.veiculo_id
    ? limitesDoVeiculo({ tipo: pneu.veiculo_tipo || pneu.tipo, layout_pneus: pneu.layout_pneus })
    : getLimites();
  const row = ultimaMedicao || {};
  const papel = pneu.posicao ? papelPosicao(pneu.posicao) : null;
  const aval = avaliarAlertaPerfil(row, {
    tipo: pneu.veiculo_tipo || pneu.tipo || null,
    layout: pneu.layout_pneus || null,
    limites,
    vidaRecap: pneu.vida_recap || 0,
    candidatos: candidatos.filter((c) => Number(c.id) !== Number(pneu.id)),
    posicao: pneu.posicao || null,
    papel,
    hr_veiculo: row.hr_veiculo,
    km_veiculo: row.km_veiculo,
  });
  const menor = aval.menor_sulco;
  const diagnostico = aval.diagnostico;
  const acao = aval.acao;
  const sulcoRef = pneu.sulco_inicial_mm ?? limites.sulco_novo_mm;
  const statusSulco = aval.status_sulco;
  const prazo = enriquecerPrazoRecap(pneu, statusSulco, limites);

  return {
    ...pneu,
    posicao_label: pneu.posicao ? labelPosicao(pneu.posicao) : null,
    papel_posicao: papel,
    padrao: pneu.tipo_pneu,
    padrao_label: labelTipoPneu(pneu.tipo_pneu),
    tipo_pneu_label: labelTipoPneu(pneu.tipo_pneu),
    tratamento_descarte: pneu.status_pneu === 'descarte'
      ? (pneu.tratamento_descarte || 'pendente')
      : (pneu.tratamento_descarte || null),
    tratamento_descarte_label: pneu.status_pneu === 'descarte'
      ? labelTratamentoDescarte(pneu.tratamento_descarte || 'pendente')
      : null,
    menor_sulco: menor,
    status_sulco: statusSulco,
    diagnostico: diagnostico.codigo,
    diagnostico_label: diagnostico.label,
    diagnostico_desc: diagnostico.descricao,
    acao_sugerida: acao.codigo,
    acao_label: acao.label,
    acao_motivo: acao.motivo,
    desvio_mm: acao.desvio_mm ?? null,
    rodizio_sugestao: acao.rodizio_sugestao || null,
    vida_util_pct: percentualVida(menor, sulcoRef, limites.sulco_critico_mm),
    vida_label: pneu.vida_recap > 0
      ? `${pneu.vida_recap}ª recap`
      : (pneu.condicao === 'novo' ? 'Novo' : 'Recapado'),
    ...prazo,
    ultima_medicao: ultimaMedicao
      ? {
        data: ultimaMedicao.data_medicao || ultimaMedicao.ult_medicao || null,
        sulco_externo: ultimaMedicao.sulco_externo ?? ultimaMedicao.ult_sulco_ext ?? null,
        sulco_central: ultimaMedicao.sulco_central ?? ultimaMedicao.ult_sulco_cent ?? null,
        sulco_interno: ultimaMedicao.sulco_interno ?? ultimaMedicao.ult_sulco_int ?? null,
        sulco_auxiliar: ultimaMedicao.sulco_auxiliar ?? ultimaMedicao.ult_sulco_aux ?? null,
        menor_sulco: menor,
      }
      : null,
  };
}

async function ultimaMedicaoDoPneu(db, pneuId) {
  const row = await db.prepare(`
    SELECT * FROM medicoes
    WHERE pneu_id = ?
    ORDER BY data_medicao DESC, id DESC
    LIMIT 1
  `).get(pneuId);
  return row || null;
}

router.get('/meta', (_req, res) => {
  res.json({
    tipos_pneu: TIPOS_PNEU,
    tipos_pneu_labels: {
      direcional: 'Direcional',
      misto: 'Misto (tração)',
      borrachudo: 'Borrachudo',
    },
    condicoes: CONDICOES_PNEU,
    status: STATUS_PNEU,
    vidas_recap: [0, 1, 2, 3, 4, 5, 6],
    tipos_movimentacao: TIPOS_MOVIMENTACAO,
  });
});

/** Próxima marca de fogo no padrão {codigo}-{sequencia} (ex.: 0110-0001) */
router.get('/proximo-fogo', async (req, res, next) => {
  try {
    const info = await consultarProximoFogo(getDb(), filialScopeId(req));
    res.json(info);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Planilha-modelo de pneus (CSV Excel BR) */
router.get('/import/modelo', (_req, res) => {
  const csv = toCsv(PNEU_TEMPLATE_HEADERS, PNEU_TEMPLATE_ROWS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-pneus.csv"');
  res.send(csv);
});

/** Importação em massa: estoque, ou já montado se a planilha tiver placa + posição */
router.post('/import', async (req, res, next) => {
  const filialId = filialScopeId(req);
  const db = getDb();

  let rows = Array.isArray(req.body?.itens) ? req.body.itens : null;
  if (!rows && req.body?.csv) {
    rows = parseCsv(req.body.csv).rows;
  }
  if (!rows?.length) {
    return res.status(400).json({ erro: 'Nenhuma linha para importar. Envie csv ou itens[].' });
  }

  const inseridos = [];
  const erros = [];
  const avisos = [];
  const cacheVeiculo = new Map();
  const ocupacao = new Set();
  const hoje = new Date().toISOString().split('T')[0];

  const findVeiculoPlaca = db.prepare(`
    SELECT id, placa, apelido, layout_pneus, km_atual, hr_atual
    FROM veiculos
    WHERE filial_id = ? AND ativo = 1 AND UPPER(TRIM(placa)) = ?
  `);
  const findVeiculoPlacaLimpa = db.prepare(`
    SELECT id, placa, apelido, layout_pneus, km_atual, hr_atual
    FROM veiculos
    WHERE filial_id = ? AND ativo = 1
      AND REPLACE(REPLACE(UPPER(TRIM(placa)), '-', ''), ' ', '') = ?
  `);
  const findOcupado = db.prepare(`
    SELECT id, numero_fogo FROM pneus
    WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
  `);
  const insertEstoque = db.prepare(`
    INSERT INTO pneus (
      veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, ativo, observacoes,
      custo, nota_fiscal
    ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estoque', 1, ?, ?, ?)
  `);
  const insertMontado = db.prepare(`
    INSERT INTO pneus (
      veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, data_instalacao,
      km_instalacao, ativo, observacoes, custo, nota_fiscal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'montado', ?, ?, 1, ?, ?, ?)
  `);

  async function acharVeiculo(placa) {
    const chave = placa.replace(/[^A-Z0-9]/g, '');
    if (cacheVeiculo.has(chave)) return cacheVeiculo.get(chave);
    let row = await findVeiculoPlaca.get(filialId, placa);
    if (!row && chave) {
      row = await findVeiculoPlacaLimpa.get(filialId, chave);
    }
    if (!row) return null;
    const layout = getLayout(row.layout_pneus || LAYOUT_PADRAO);
    const info = { ...row, layout };
    cacheVeiculo.set(chave, info);
    return info;
  }

  try {
    await db.transaction(async () => {
      const gerador = await criarGeradorNumeroFogo(db, filialId);
      for (const raw of rows) {
        const linha = raw.__linha || '?';
        const placa = placaDaLinha(raw);
        const posicaoInformada = String(raw.posicao || raw.posicao_pneu || raw.slot || '').trim();
        let veiculo = null;
        let posicao = '';

        if (placa && !posicaoInformada) {
          erros.push({ linha, placa, erro: 'Informe a posição (ex.: 1E, 2EE) para montar neste caminhão' });
          continue;
        }
        if (posicaoInformada && !placa) {
          erros.push({ linha, erro: 'Informe a placa do veículo para montar nesta posição' });
          continue;
        }

        if (placa) {
          veiculo = await acharVeiculo(placa);
          if (!veiculo) {
            erros.push({
              linha,
              placa,
              erro: `Veículo ${placa} não encontrado nesta unidade. Cadastre o caminhão antes de importar o pneu.`,
            });
            continue;
          }
          posicao = encaixarPosicaoNoLayout(posicaoInformada, veiculo.layout?.posicoes);
          if (!posicao) {
            erros.push({
              linha,
              placa,
              erro: `Posição ${String(posicaoInformada).toUpperCase()} não existe no layout de ${veiculo.placa} (${veiculo.layout?.id || veiculo.layout_pneus}). Use: ${(veiculo.layout?.posicoes || []).join(', ')}`,
            });
            continue;
          }
          const chaveSlot = `${veiculo.id}:${posicao}`;
          const jaBanco = ocupacao.has(chaveSlot)
            ? { numero_fogo: 'nesta planilha' }
            : await findOcupado.get(veiculo.id, posicao);
          if (jaBanco) {
            erros.push({
              linha,
              placa: veiculo.placa,
              erro: `Posição ${posicao} de ${veiculo.placa} já tem pneu${jaBanco.numero_fogo ? ` (fogo ${jaBanco.numero_fogo})` : ''}`,
            });
            continue;
          }
        }

        let fogo;
        let gerado = false;
        try {
          const alocado = gerador.alocar(raw.numero_fogo || raw.fogo);
          fogo = alocado.numero_fogo;
          gerado = alocado.gerado;
        } catch (err) {
          erros.push({ linha, erro: err.message });
          continue;
        }

        const tipo = mapTipoPneu(raw.tipo_pneu || raw.tipo);
        const cond = mapCondicao(raw.condicao);
        let vida = raw.vida_recap != null && raw.vida_recap !== ''
          ? parseInt(raw.vida_recap, 10)
          : (cond === 'recapado' ? 1 : 0);
        if (!Number.isFinite(vida) || vida < 0) vida = 0;
        if (cond === 'novo') vida = 0;

        const sulco = raw.sulco_inicial_mm != null && raw.sulco_inicial_mm !== ''
          ? parseFloat(String(raw.sulco_inicial_mm).replace(',', '.'))
          : null;
        const custo = raw.custo != null && raw.custo !== ''
          ? parseFloat(String(raw.custo).replace(',', '.'))
          : null;
        const marca = String(raw.marca || '').trim() || null;
        const modelo = String(raw.modelo || '').trim() || null;
        const medida = String(raw.medida || '').trim() || null;
        const dot = String(raw.dot || raw.dot_serie || raw.serie || '').trim() || null;
        const obs = String(raw.observacoes || raw.observacao || '').trim() || null;
        const custoOk = Number.isFinite(custo) ? custo : null;
        const sulcoOk = Number.isFinite(sulco) ? sulco : null;
        const nota = String(raw.nota_fiscal || raw.nota || '').trim() || null;

        if (veiculo) {
          const validacao = validarMontagem({ condicao: cond, tipo_pneu: tipo, posicao });
          if (validacao.avisos?.length) {
            avisos.push({ linha, numero_fogo: fogo, aviso: validacao.avisos.join(' ') });
          }
          if (!validacao.ok) {
            avisos.push({ linha, numero_fogo: fogo, aviso: validacao.erros.join(' ') });
          }
        }

        let gravou = false;
        for (let tentativa = 0; tentativa < 8 && !gravou; tentativa++) {
          try {
            if (!gerado) await assertFogoLivre(db, filialId, fogo);
            const result = await comSavepoint(db, async () => {
              if (veiculo) {
                const criado = await insertMontado.run(
                  veiculo.id,
                  posicao,
                  filialId,
                  marca,
                  modelo,
                  medida,
                  dot,
                  fogo,
                  tipo,
                  cond,
                  vida,
                  sulcoOk,
                  hoje,
                  veiculo.km_atual ?? 0,
                  obs,
                  custoOk,
                  nota
                );
                await registrarMovimentacao(db, {
                  pneuId: criado.lastInsertRowid,
                  veiculoId: veiculo.id,
                  tipo: 'montagem',
                  data: hoje,
                  km: veiculo.km_atual ?? 0,
                  hr: veiculo.hr_atual ?? null,
                  posicao,
                  detalhes: `Importação — montou em ${veiculo.placa} · ${labelPosicao(posicao)}`,
                  placa: veiculo.placa,
                  apelido: veiculo.apelido || null,
                  ciclo: Number.isFinite(vida) ? vida : 0,
                  usuario: usuarioDe(req),
                  custo: custoOk,
                });
                return criado;
              }
              const criadoEstoque = await insertEstoque.run(
                filialId,
                marca,
                modelo,
                medida,
                dot,
                fogo,
                tipo,
                cond,
                vida,
                sulcoOk,
                obs,
                custoOk,
                nota
              );
              await registrarMovimentacao(db, {
                pneuId: criadoEstoque.lastInsertRowid,
                veiculoId: null,
                tipo: 'entrada_estoque',
                data: hoje,
                ciclo: Number.isFinite(vida) ? vida : 0,
                usuario: usuarioDe(req),
                custo: custoOk,
                sulcoMm: sulcoOk,
                detalhes: 'Importação — entrada no estoque',
              });
              return criadoEstoque;
            });
            if (veiculo) ocupacao.add(`${veiculo.id}:${posicao}`);
            inseridos.push({
              id: result.lastInsertRowid,
              numero_fogo: fogo,
              tipo_pneu: tipo,
              condicao: cond,
              status_pneu: veiculo ? 'montado' : 'estoque',
              placa: veiculo?.placa || null,
              posicao: veiculo ? posicao : null,
            });
            gravou = true;
          } catch (err) {
            const colisao = ehViolacaoUnique(err) || err.status === 409;
            if (colisao && gerado && tentativa < 7) {
              fogo = gerador.alocar('').numero_fogo;
              continue;
            }
            erros.push({
              linha,
              numero_fogo: fogo,
              erro: colisao ? 'Nº de fogo já existe nesta filial' : err.message,
            });
            break;
          }
        }
      }
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    return next(err);
  }

  if (!inseridos.length && erros.length) {
    return res.status(400).json({
      erro: 'Nenhum pneu importado',
      inseridos: 0,
      erros,
    });
  }

  const nMontados = inseridos.filter((x) => x.status_pneu === 'montado').length;
  const nEstoque = inseridos.length - nMontados;
  const partes = [];
  if (nMontados) partes.push(`${nMontados} montado(s)`);
  if (nEstoque) partes.push(`${nEstoque} no estoque`);

  res.status(201).json({
    mensagem: `${inseridos.length} pneu(s) importado(s)${partes.length ? ` (${partes.join(', ')})` : ''}`,
    inseridos: inseridos.length,
    montados: nMontados,
    estoque: nEstoque,
    detalhes: inseridos,
    erros,
    avisos,
  });
});

/** Lista pneus da filial (estoque / montados / descarte / todos) */
router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const status = (req.query.status || 'todos').toLowerCase();
    const q = (req.query.q || '').trim();

    // Descarte grava ativo=0 — precisa entrar na listagem ao filtrar
    let where = status === 'descarte'
      ? 'p.filial_id = ? AND p.status_pneu = \'descarte\''
      : 'p.ativo = 1 AND p.filial_id = ?';
    const params = [filialId];

    if (status === 'estoque') {
      where += ` AND p.status_pneu = 'estoque'`;
    } else if (status === 'montado') {
      where += ` AND p.status_pneu = 'montado'`;
    } else if (status === 'recapagem') {
      where += ` AND p.status_pneu = 'recapagem'`;
    } else if (status === 'descarte') {
      // already filtered above
    } else {
      where += ` AND p.status_pneu != 'descarte'`;
    }

    if (q) {
      where += ` AND (
      IFNULL(p.numero_fogo,'') LIKE ? OR IFNULL(p.marca,'') LIKE ?
      OR IFNULL(p.dot,'') LIKE ? OR IFNULL(v.placa,'') LIKE ?
    )`;
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const rows = await db.prepare(`
    SELECT p.*,
      v.placa as veiculo_placa, v.apelido as veiculo_apelido,
      v.tipo as veiculo_tipo, v.layout_pneus,
      um.sulco_externo as ult_sulco_ext,
      um.sulco_central as ult_sulco_cent,
      um.sulco_interno as ult_sulco_int,
      um.sulco_auxiliar as ult_sulco_aux,
      um.data_medicao as ult_medicao
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    ${SQL_LATERAL_ULTIMA_MEDICAO}
    WHERE ${where}
    ORDER BY
      CASE p.status_pneu
        WHEN 'estoque' THEN 0
        WHEN 'montado' THEN 1
        WHEN 'recapagem' THEN 2
        WHEN 'descarte' THEN 3
        ELSE 4
      END,
      p.numero_fogo, p.id DESC
  `).all(...params);

    res.json(rows.map((p) => {
      const temMedicao = p.ult_sulco_ext != null || p.ult_sulco_cent != null
        || p.ult_sulco_int != null || p.ult_sulco_aux != null || p.ult_medicao;
      const ultima = temMedicao
        ? {
          data_medicao: p.ult_medicao,
          sulco_externo: p.ult_sulco_ext,
          sulco_central: p.ult_sulco_cent,
          sulco_interno: p.ult_sulco_int,
          sulco_auxiliar: p.ult_sulco_aux,
        }
        : null;
      return enriquecerPneu(p, ultima);
    }));
  } catch (err) {
    next(err);
  }
});

/** Cria pneu no estoque */
router.post('/', async (req, res, next) => {
  const {
    marca, modelo, medida, dot, numero_fogo,
    tipo_pneu, condicao, vida_recap, sulco_inicial_mm, observacoes,
    custo, nota_fiscal,
  } = req.body;

  if (!modelo?.trim()) {
    return res.status(400).json({ erro: 'Modelo do pneu é obrigatório' });
  }

  const filialId = filialScopeId(req);
  const db = getDb();
  const tipo = tipo_pneu || 'misto';
  const cond = condicao || 'novo';
  if (!TIPOS_PNEU.includes(tipo)) {
    return res.status(400).json({ erro: `Padrão inválido. Use: ${TIPOS_PNEU.join(', ')}` });
  }
  if (!CONDICOES_PNEU.includes(cond)) {
    return res.status(400).json({ erro: `Condição inválida. Use: ${CONDICOES_PNEU.join(', ')}` });
  }
  const vida = vida_recap != null ? parseInt(vida_recap, 10) : 0;
  const custoNum = custo != null && custo !== '' ? parseFloat(String(custo).replace(',', '.')) : null;

  try {
    const { result } = await comRetryFogoUnico(db, filialId, numero_fogo, (fogoOk) => (
      db.prepare(`
      INSERT INTO pneus (
        veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
        tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, ativo, observacoes,
        custo, nota_fiscal
      ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estoque', 1, ?, ?, ?)
    `).run(
        filialId,
        marca?.trim() || null,
        modelo.trim(),
        medida?.trim() || null,
        dot?.trim() || null,
        fogoOk,
        tipo,
        cond,
        Number.isFinite(vida) ? vida : 0,
        sulco_inicial_mm != null ? parseFloat(sulco_inicial_mm) : null,
        observacoes?.trim() || null,
        Number.isFinite(custoNum) ? custoNum : null,
        nota_fiscal?.trim() || null
      )
    ));

    const pneu = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(result.lastInsertRowid);
    await registrarMovimentacao(db, {
      pneuId: pneu.id,
      veiculoId: null,
      tipo: 'entrada_estoque',
      data: new Date().toISOString().split('T')[0],
      ciclo: pneu.vida_recap || 0,
      usuario: usuarioDe(req),
      custo: pneu.custo,
      sulcoMm: pneu.sulco_inicial_mm,
      detalhes: 'Entrada no estoque',
    });
    res.status(201).json({
      mensagem: 'Pneu cadastrado no estoque',
      pneu: enriquecerPneu(pneu),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Já existe um pneu com este nº de fogo na filial' });
    }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const pneu = await assertPneuDaFilial(req.params.id, filialScopeId(req), { incluirInativos: true });
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });

    const db = getDb();
    const limites = pneu.veiculo_id
      ? limitesDoVeiculo({ tipo: pneu.veiculo_tipo, layout_pneus: pneu.layout_pneus })
      : getLimites();
    const medicoes = await db.prepare(`
    SELECT m.*
    FROM medicoes m
    WHERE m.pneu_id = ?
    ORDER BY m.data_medicao DESC, m.id DESC
    LIMIT 50
  `).all(req.params.id);

    const medicoesComStatus = medicoes.map((m) => {
      const aval = avaliarAlertaPerfil(m, {
        tipo: pneu.veiculo_tipo || null,
        layout: pneu.layout_pneus || null,
        limites,
        vidaRecap: pneu.vida_recap || 0,
        posicao: pneu.posicao || null,
        papel: pneu.posicao ? papelPosicao(pneu.posicao) : null,
        hr_veiculo: m.hr_veiculo,
        km_veiculo: m.km_veiculo,
      });
      return {
        ...m,
        menor_sulco: aval.menor_sulco,
        status_sulco: aval.status_sulco,
        diagnostico_label: aval.diagnostico.label,
        acao_sugerida: aval.acao.codigo,
        acao_label: aval.acao.label,
        veiculo_placa: m.veiculo_placa || null,
        veiculo_apelido: m.veiculo_apelido || null,
        posicao: m.posicao || null,
        ciclo: m.ciclo ?? null,
      };
    });

    const movimentacoes = await db.prepare(`
    SELECT m.*
    FROM movimentacoes m
    WHERE m.pneu_id = ?
    ORDER BY m.data_evento DESC, m.id DESC
    LIMIT 80
  `).all(req.params.id);

    const histMed = await db.prepare(`
      SELECT id, data_medicao, km_veiculo, hr_veiculo,
        sulco_externo, sulco_central, sulco_interno, sulco_auxiliar, sulco_mm,
        veiculo_id, veiculo_placa, veiculo_apelido, posicao, ciclo, created_at
      FROM medicoes WHERE pneu_id = ?
    `).all(pneu.id);
    const histMov = await db.prepare(`
      SELECT id, tipo, data_evento, km_veiculo, hr_veiculo, posicao, sulco_mm,
        sulco_antes, sulco_depois, veiculo_id, veiculo_placa, veiculo_apelido,
        ciclo, custo, motivo, usuario, detalhes, created_at
      FROM movimentacoes WHERE pneu_id = ?
    `).all(pneu.id);
    const ciclos = calcularCiclos({ movimentacoes: histMov, medicoes: histMed });

    const ultima = medicoes[0] || null;
    let candidatos = [];
    if (pneu.veiculo_id) {
      candidatos = await db.prepare(`
        SELECT p.id, p.posicao, p.numero_fogo,
          (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
          (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
          (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
          (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux
        FROM pneus p
        WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
      `).all(pneu.veiculo_id, pneu.id);
    }

    // Placa atual do caminhão (se montado)
    let veiculoPlaca = pneu.veiculo_placa || null;
    if (!veiculoPlaca && pneu.veiculo_id) {
      const v = await db.prepare('SELECT placa FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
      veiculoPlaca = v?.placa || null;
    }

    const padraoLabel = labelTipoPneu(pneu.tipo_pneu);
    const labelsTipo = {
      entrada_estoque: 'Entrou no estoque',
      montagem: 'Colocou no caminhão',
      retirada: 'Retirou do caminhão',
      desmontagem: 'Retirou do caminhão',
      mudanca_posicao: 'Mudou de posição (rodízio)',
      recap: 'Enviou à recapagem',
      enviar_recap: 'Enviou à recapagem',
      retorno_recap: 'Recap concluído · voltou ao estoque',
      descarte: 'Enviou ao descarte',
    };

    res.json({
      ...enriquecerPneu(pneu, ultima, candidatos),
      veiculo_placa: veiculoPlaca,
      medicoes: medicoesComStatus,
      ciclos,
      movimentacoes: movimentacoes.map((m) => ({
        ...m,
        tipo_label: labelsTipo[m.tipo] || m.tipo,
        padrao: pneu.tipo_pneu,
        padrao_label: padraoLabel,
        condicao: pneu.condicao,
        veiculo_placa: m.veiculo_placa || null,
        veiculo_apelido: m.veiculo_apelido || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const {
    marca, modelo, medida, dot, numero_fogo,
    tipo_pneu, condicao,
    vida_recap, sulco_inicial_mm,
    data_instalacao, km_instalacao, observacoes,
    custo, nota_fiscal,
  } = req.body;

  const db = getDb();
  let atual;
  try {
    atual = await assertPneuDaFilial(req.params.id, filialScopeId(req));
  } catch (err) {
    return next(err);
  }
  if (!atual) return res.status(404).json({ erro: 'Pneu não encontrado' });

  const tipoFinal = tipo_pneu != null ? mapTipoPneu(tipo_pneu) : atual.tipo_pneu;
  const condFinal = condicao != null ? mapCondicao(condicao) : atual.condicao;
  if (!TIPOS_PNEU.includes(tipoFinal)) {
    return res.status(400).json({ erro: `Padrão inválido. Use: ${TIPOS_PNEU.join(', ')}` });
  }
  if (!CONDICOES_PNEU.includes(condFinal)) {
    return res.status(400).json({ erro: `Condição inválida. Use: ${CONDICOES_PNEU.join(', ')}` });
  }

  const modeloFinal = modelo != null ? String(modelo).trim() : atual.modelo;
  if (!modeloFinal) {
    return res.status(400).json({ erro: 'Modelo do pneu é obrigatório' });
  }

  const custoNum = custo != null && custo !== ''
    ? parseFloat(String(custo).replace(',', '.'))
    : atual.custo;

  const filialId = filialScopeId(req);
  let fogo = atual.numero_fogo;

  try {
    if (numero_fogo != null && String(numero_fogo).trim()) {
      const resolvido = await resolverNumeroFogo(db, filialId, numero_fogo);
      if (!resolvido.gerado) {
        fogo = resolvido.numero_fogo;
        const atualNorm = String(atual.numero_fogo || '').trim().toUpperCase();
        if (String(fogo).trim().toUpperCase() !== atualNorm) {
          await assertFogoLivre(db, filialId, fogo, { ignorarId: atual.id });
        }
      }
    }

    await db.prepare(`
      UPDATE pneus SET
        marca = ?,
        modelo = ?,
        medida = ?,
        dot = ?,
        numero_fogo = ?,
        tipo_pneu = ?,
        condicao = ?,
        vida_recap = COALESCE(?, vida_recap),
        sulco_inicial_mm = COALESCE(?, sulco_inicial_mm),
        data_instalacao = COALESCE(?, data_instalacao),
        km_instalacao = COALESCE(?, km_instalacao),
        observacoes = ?,
        custo = ?,
        nota_fiscal = ?
      WHERE id = ? AND ativo = 1
    `).run(
      marca?.trim() || null,
      modeloFinal,
      medida?.trim() || null,
      dot?.trim() || null,
      fogo || null,
      tipoFinal,
      condFinal,
      vida_recap != null ? parseInt(vida_recap, 10) : null,
      sulco_inicial_mm != null ? parseFloat(sulco_inicial_mm) : null,
      data_instalacao || null,
      km_instalacao != null ? parseInt(km_instalacao, 10) : null,
      observacoes?.trim() || null,
      Number.isFinite(custoNum) ? custoNum : null,
      nota_fiscal != null ? (String(nota_fiscal).trim() || null) : atual.nota_fiscal,
      Number(req.params.id)
    );

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(req.params.id);
    res.json({
      mensagem: 'Pneu atualizado',
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, atualizado.id)),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Já existe um pneu com este nº de fogo na filial' });
    }
    next(err);
  }
});

/** Monta pneu do estoque em uma posição do veículo */
router.post('/:id/montar', async (req, res, next) => {
  const { veiculo_id, posicao, km_veiculo, hr_veiculo, data_evento } = req.body;
  if (!veiculo_id || !posicao) {
    return res.status(400).json({ erro: 'Informe veiculo_id e posicao' });
  }

  try {
    const filialId = filialScopeId(req);
    const pneu = await assertPneuDaFilial(req.params.id, filialId);
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });

    if (pneu.status_pneu === 'descarte' || !pneu.ativo) {
      return res.status(400).json({ erro: 'Pneu descartado não pode ser montado' });
    }
    if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
      return res.status(400).json({
        erro: `Pneu já montado em ${pneu.placa || 'veículo'} (${pneu.posicao}). Retire ou mude de posição.`,
      });
    }

    const veiculo = await assertVeiculoDaFilial(veiculo_id, filialId);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
    if (!layout.posicoes.includes(posicao)) {
      return res.status(400).json({
        erro: `Posição ${posicao} não faz parte do layout do veículo`,
      });
    }

    const validacao = validarMontagem({
      condicao: pneu.condicao,
      tipo_pneu: pneu.tipo_pneu,
      posicao,
    });
    if (!validacao.ok) {
      return res.status(400).json({ erro: validacao.erros.join(' '), avisos: validacao.avisos });
    }

    const db = getDb();
    const ocupado = await db.prepare(`
      SELECT id, numero_fogo FROM pneus
      WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
    `).get(veiculo_id, posicao);

    if (ocupado) {
      return res.status(409).json({
        erro: `Posição ${posicao} já tem pneu montado${ocupado.numero_fogo ? ` (fogo ${ocupado.numero_fogo})` : ''}. Retire antes.`,
      });
    }

    const data = data_evento || new Date().toISOString().split('T')[0];
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : veiculo.km_atual;
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : veiculo.hr_atual;

    await db.transaction(async () => {
      await db.prepare(`
        UPDATE pneus SET
          veiculo_id = ?,
          posicao = ?,
          filial_id = ?,
          status_pneu = 'montado',
          data_instalacao = ?,
          km_instalacao = COALESCE(?, km_instalacao),
          ativo = 1
        WHERE id = ?
      `).run(veiculo_id, posicao, filialId, data, km, pneu.id);

      await registrarMovimentacao(db, {
        pneuId: pneu.id,
        veiculoId: veiculo_id,
        tipo: 'montagem',
        data,
        km,
        hr,
        posicao,
        detalhes: `Colocou no caminhão ${veiculo.placa} · ${labelPosicao(posicao)}`,
        placa: veiculo.placa,
        apelido: veiculo.apelido || null,
        usuario: usuarioDe(req),
        ciclo: pneu.vida_recap || 0,
      });
      await atualizarKmHrVeiculo(db, veiculo_id, filialId, km, hr);
    });

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);
    res.json({
      mensagem: `Pneu montado em ${labelPosicao(posicao)}`,
      avisos: validacao.avisos,
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, pneu.id)),
    });
  } catch (err) {
    next(err);
  }
});

/** Retira pneu → estoque */
router.post('/:id/desmontar', async (req, res, next) => {
  const { km_veiculo, hr_veiculo, data_evento, detalhes } = req.body || {};
  try {
    const filialId = filialScopeId(req);
    const pneu = await assertPneuDaFilial(req.params.id, filialId);
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });

    if (pneu.status_pneu !== 'montado' || !pneu.veiculo_id) {
      return res.status(400).json({ erro: 'Pneu não está montado' });
    }

    const db = getDb();
    const data = data_evento || new Date().toISOString().split('T')[0];
    const veiculoId = pneu.veiculo_id;
    const posicao = pneu.posicao;
    const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculoId);
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : (veiculo?.km_atual ?? null);
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : (veiculo?.hr_atual ?? null);

    await db.transaction(async () => {
      await db.prepare(`
        UPDATE pneus SET
          veiculo_id = NULL,
          posicao = NULL,
          status_pneu = 'estoque',
          data_instalacao = NULL
        WHERE id = ?
      `).run(pneu.id);

      await registrarMovimentacao(db, {
        pneuId: pneu.id,
        veiculoId,
        tipo: 'retirada',
        data,
        km,
        hr,
        posicao,
        detalhes: detalhes?.trim() || `Retirou do caminhão ${veiculo?.placa || ''}`.trim(),
        placa: veiculo?.placa || null,
        apelido: veiculo?.apelido || null,
        usuario: usuarioDe(req),
        ciclo: pneu.vida_recap || 0,
      });
      if (veiculoId) await atualizarKmHrVeiculo(db, veiculoId, filialId, km, hr);
    });

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);
    res.json({
      mensagem: 'Pneu retirado e enviado ao estoque',
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, pneu.id)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Troca o pneu montado por outro do estoque (mesma posição).
 * Body: { montar_pneu_id }
 */
router.post('/:id/trocar-estoque', async (req, res, next) => {
  try {
    const filialId = filialScopeId(req);
    const montarId = parseInt(req.body?.montar_pneu_id, 10);
    if (!montarId) return res.status(400).json({ erro: 'Informe montar_pneu_id (pneu do estoque)' });
    const result = await trocarPorEstoque({
      filialId,
      pneuMontadoId: parseInt(req.params.id, 10),
      pneuEstoqueId: montarId,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Move o pneu para outro veículo/posição da frota.
 * Se ocupado, troca os dois. Body: { veiculo_id, posicao }
 */
router.post('/:id/mover-frota', async (req, res, next) => {
  try {
    const filialId = filialScopeId(req);
    const veiculoId = parseInt(req.body?.veiculo_id, 10);
    const posicao = req.body?.posicao;
    if (!veiculoId || !posicao) {
      return res.status(400).json({ erro: 'Informe veiculo_id e posicao de destino' });
    }
    const result = await moverOuTrocarNaFrota({
      filialId,
      pneuId: parseInt(req.params.id, 10),
      veiculoDestinoId: veiculoId,
      posicaoDestino: posicao,
      detalhes: req.body?.detalhes || null,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Muda de posição no mesmo caminhão */
router.post('/:id/reposicionar', async (req, res, next) => {
  const { posicao, km_veiculo, hr_veiculo, data_evento } = req.body || {};
  if (!posicao) {
    return res.status(400).json({ erro: 'Informe a nova posicao' });
  }

  try {
    const filialId = filialScopeId(req);
    const pneu = await assertPneuDaFilial(req.params.id, filialId);
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });
    if (pneu.status_pneu !== 'montado' || !pneu.veiculo_id) {
      return res.status(400).json({ erro: 'Pneu precisa estar montado no caminhão' });
    }
    if (pneu.posicao === posicao) {
      return res.status(400).json({ erro: 'Pneu já está nesta posição' });
    }

    const veiculo = await assertVeiculoDaFilial(pneu.veiculo_id, filialId);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
    if (!layout.posicoes.includes(posicao)) {
      return res.status(400).json({ erro: `Posição ${posicao} não faz parte do layout do veículo` });
    }

    const validacao = validarMontagem({
      condicao: pneu.condicao,
      tipo_pneu: pneu.tipo_pneu,
      posicao,
    });
    if (!validacao.ok) {
      return res.status(400).json({ erro: validacao.erros.join(' '), avisos: validacao.avisos });
    }

    const db = getDb();
    const ocupado = await db.prepare(`
      SELECT id, numero_fogo FROM pneus
      WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado' AND id != ?
    `).get(pneu.veiculo_id, posicao, pneu.id);

    if (ocupado) {
      return res.status(409).json({
        erro: `Posição ${posicao} já tem pneu${ocupado.numero_fogo ? ` (fogo ${ocupado.numero_fogo})` : ''}. Retire ou troque antes.`,
      });
    }

    const data = data_evento || new Date().toISOString().split('T')[0];
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : veiculo.km_atual;
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : veiculo.hr_atual;
    const posicaoAnterior = pneu.posicao;

    await db.transaction(async () => {
      await db.prepare(`
        UPDATE pneus SET posicao = ? WHERE id = ?
      `).run(posicao, pneu.id);

      await registrarMovimentacao(db, {
        pneuId: pneu.id,
        veiculoId: pneu.veiculo_id,
        tipo: 'mudanca_posicao',
        data,
        km,
        hr,
        posicao,
        posicaoAnterior,
        detalhes: `${labelPosicao(posicaoAnterior)} → ${labelPosicao(posicao)} · ${veiculo.placa}`,
        placa: veiculo.placa,
        apelido: veiculo.apelido || null,
        usuario: usuarioDe(req),
        ciclo: pneu.vida_recap || 0,
      });
      await atualizarKmHrVeiculo(db, pneu.veiculo_id, filialId, km, hr);
    });

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);
    res.json({
      mensagem: `Posição alterada para ${labelPosicao(posicao)}`,
      avisos: validacao.avisos,
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, pneu.id)),
    });
  } catch (err) {
    next(err);
  }
});

/** Eventos especiais (recap/descarte/retorno) — rastreiam ciclo de vida do pneu */
router.post('/:id/evento', async (req, res, next) => {
  const { tipo, data_evento, km_veiculo, hr_veiculo, detalhes, sulco_mm, custo, motivo } = req.body;
  const tiposOk = ['recap', 'descarte', 'retorno_recap'];
  if (!tiposOk.includes(tipo)) {
    return res.status(400).json({
      erro: `tipo deve ser: ${tiposOk.join(', ')}. Para movimentar use montar / desmontar / reposicionar.`,
    });
  }

  try {
    const pneu = await assertPneuDaFilial(req.params.id, filialScopeId(req));
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });

    const db = getDb();
    const limites = getLimites();
    const data = data_evento || new Date().toISOString().split('T')[0];
    const filialId = filialScopeId(req);
    const custoNum = custo != null && custo !== '' ? parseFloat(String(custo).replace(',', '.')) : null;
    const custoOk = Number.isFinite(custoNum) ? custoNum : null;
    const cicloAtual = pneu.vida_recap || 0;
    const sulcoAntes = await ultimoSulcoPneu(db, pneu.id);

    if (tipo === 'retorno_recap') {
      if (pneu.status_pneu !== 'recapagem') {
        return res.status(400).json({ erro: 'Pneu não está em recapagem' });
      }
      const sulcoInformado = sulco_mm != null && sulco_mm !== '' ? parseFloat(sulco_mm) : NaN;
      if (!Number.isFinite(sulcoInformado) || sulcoInformado <= 0) {
        return res.status(400).json({
          erro: 'Informe o sulco após o recap (sulco_mm em mm) para devolver ao estoque',
        });
      }
      await db.transaction(async () => {
        const locked = await travarPneu(db, pneu.id);
        if (!locked || locked.status_pneu !== 'recapagem') {
          const err = new Error('Pneu não está em recapagem');
          err.status = 400;
          throw err;
        }
        await db.prepare(`
          UPDATE pneus SET
            status_pneu = 'estoque',
            condicao = 'recapado',
            veiculo_id = NULL,
            posicao = NULL,
            sulco_inicial_mm = ?,
            data_instalacao = NULL,
            data_alerta_monitorar = NULL
          WHERE id = ? AND status_pneu = 'recapagem'
        `).run(sulcoInformado, pneu.id);
        await registrarMovimentacao(db, {
          pneuId: pneu.id,
          veiculoId: null,
          tipo: 'retorno_recap',
          data,
          km: null,
          hr: null,
          posicao: null,
          sulcoMm: sulcoInformado,
          sulcoDepois: sulcoInformado,
          sulcoAntes,
          detalhes: detalhes || `Recap concluído · sulco ${sulcoInformado} mm · voltou ao estoque (${pneu.vida_recap || 1}ª vida)`,
          placa: null,
          ciclo: cicloAtual,
          usuario: usuarioDe(req),
          custo: custoOk,
        });
        await db.prepare(`
          INSERT INTO medicoes (
            pneu_id, data_medicao,
            sulco_externo, sulco_central, sulco_interno, sulco_auxiliar,
            responsavel, observacoes, diagnostico, acao_sugerida, ciclo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', 'ok', ?)
        `).run(
          pneu.id,
          data,
          sulcoInformado,
          sulcoInformado,
          sulcoInformado,
          sulcoInformado,
          usuarioDe(req) || 'retorno_recap',
          `Sulco após recap: ${sulcoInformado} mm`,
          cicloAtual
        );
      });
    } else if (tipo === 'recap') {
      if (pneu.status_pneu === 'recapagem') {
        return res.status(400).json({ erro: 'Pneu já está em recapagem' });
      }
      if (pneu.status_pneu === 'descarte') {
        return res.status(400).json({ erro: 'Pneu já está no descarte' });
      }
      const novaVida = (pneu.vida_recap || 0) + 1;
      if (novaVida > limites.max_recaps) {
        return res.status(400).json({
          erro: `Limite de recaps atingido (${limites.max_recaps}). Indique troca/descarte.`,
        });
      }

      let placaOrigem = null;
      let apelidoOrigem = null;
      const veiculoOrigemId = pneu.veiculo_id || null;
      const posicaoOrigem = pneu.posicao || null;
      await db.transaction(async () => {
        const locked = await travarPneu(db, pneu.id);
        if (!locked || locked.status_pneu === 'recapagem' || locked.status_pneu === 'descarte') {
          const err = new Error('Pneu já está em recapagem');
          err.status = 400;
          throw err;
        }
        if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
          const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
          placaOrigem = veiculo?.placa || null;
          apelidoOrigem = veiculo?.apelido || null;
          const km = km_veiculo != null ? parseInt(km_veiculo, 10) : (veiculo?.km_atual ?? null);
          const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : (veiculo?.hr_atual ?? null);
          await registrarMovimentacao(db, {
            pneuId: pneu.id,
            veiculoId: pneu.veiculo_id,
            tipo: 'retirada',
            data,
            km,
            hr,
            posicao: pneu.posicao,
            detalhes: 'Retirou para iniciar processo de recap',
            placa: placaOrigem,
            apelido: apelidoOrigem,
            usuario: usuarioDe(req),
            ciclo: cicloAtual,
            sulcoAntes,
          });
          await atualizarKmHrVeiculo(db, pneu.veiculo_id, filialId, km, hr);
        }
        await db.prepare(`
          UPDATE pneus SET
            vida_recap = ?,
            condicao = 'recapado',
            status_pneu = 'recapagem',
            veiculo_id = NULL,
            posicao = NULL,
            data_instalacao = NULL,
            km_instalacao = COALESCE(?, km_instalacao),
            data_alerta_monitorar = NULL
          WHERE id = ? AND status_pneu IS DISTINCT FROM 'recapagem'
        `).run(
          novaVida,
          km_veiculo != null ? parseInt(km_veiculo, 10) : null,
          pneu.id
        );
        await registrarMovimentacao(db, {
          pneuId: pneu.id,
          veiculoId: veiculoOrigemId,
          tipo: 'recap',
          data,
          km: km_veiculo != null ? parseInt(km_veiculo, 10) : null,
          hr: hr_veiculo != null ? parseFloat(hr_veiculo) : null,
          posicao: posicaoOrigem,
          detalhes: detalhes || `Enviado à recap (${novaVida}ª vida)`,
          placa: placaOrigem,
          apelido: apelidoOrigem,
          usuario: usuarioDe(req),
          ciclo: cicloAtual,
          sulcoAntes,
          custo: custoOk,
        });
      });
    } else if (tipo === 'descarte') {
      await db.transaction(async () => {
        let placaDescarte = null;
        let apelidoDescarte = null;
        if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
          const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
          placaDescarte = veiculo?.placa || null;
          apelidoDescarte = veiculo?.apelido || null;
          const km = km_veiculo != null ? parseInt(km_veiculo, 10) : (veiculo?.km_atual ?? null);
          const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : (veiculo?.hr_atual ?? null);
          await registrarMovimentacao(db, {
            pneuId: pneu.id,
            veiculoId: pneu.veiculo_id,
            tipo: 'retirada',
            data,
            km,
            hr,
            posicao: pneu.posicao,
            detalhes: 'Retirou para descarte',
            placa: placaDescarte,
            apelido: apelidoDescarte,
            usuario: usuarioDe(req),
            ciclo: cicloAtual,
          });
        }
        await db.prepare(`
          UPDATE pneus SET
            status_pneu = 'descarte',
            ativo = 0,
            veiculo_id = NULL,
            posicao = NULL,
            data_alerta_monitorar = NULL,
            tratamento_descarte = 'pendente',
            tratamento_descarte_obs = NULL,
            tratamento_descarte_em = ?,
            observacoes = COALESCE(observacoes || ' | ', '') || ?
          WHERE id = ?
        `).run(data, `descarte em ${data}${detalhes ? ` — ${detalhes}` : ''}`, pneu.id);
        await registrarMovimentacao(db, {
          pneuId: pneu.id,
          veiculoId: pneu.veiculo_id || null,
          tipo: 'descarte',
          data,
          km: km_veiculo != null ? parseInt(km_veiculo, 10) : null,
          hr: hr_veiculo != null ? parseFloat(hr_veiculo) : null,
          posicao: pneu.posicao || null,
          detalhes: motivo?.trim() || detalhes || 'Enviado ao estoque de descarte',
          placa: placaDescarte,
          apelido: apelidoDescarte,
          usuario: usuarioDe(req),
          ciclo: cicloAtual,
          motivo: motivo?.trim() || detalhes || null,
          sulcoAntes,
        });
      });
    }

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);

    res.status(201).json({
      mensagem: tipo === 'recap'
        ? 'Pneu enviado à recapagem — acompanhe no KPI Recap / aba Pneus'
        : tipo === 'retorno_recap'
          ? 'Recap concluído — pneu voltou ao estoque'
          : 'Pneu enviado ao estoque de descarte — defina o tratamento na aba Pneus',
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, pneu.id)),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Define o destino/tratamento de um pneu no estoque de descarte */
router.put('/:id/tratamento-descarte', async (req, res, next) => {
  const { tratamento, observacoes } = req.body || {};
  if (!TRATAMENTOS_DESCARTE.includes(tratamento)) {
    return res.status(400).json({
      erro: `tratamento deve ser: ${TRATAMENTOS_DESCARTE.join(', ')}`,
    });
  }
  try {
    const pneu = await assertPneuDaFilial(req.params.id, filialScopeId(req), { incluirInativos: true });
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });
    if (pneu.status_pneu !== 'descarte') {
      return res.status(400).json({ erro: 'Só pneus no estoque de descarte recebem tratamento' });
    }

    const db = getDb();
    const hoje = new Date().toISOString().split('T')[0];
    const obs = observacoes != null ? String(observacoes).trim() || null : pneu.tratamento_descarte_obs;

    await db.prepare(`
      UPDATE pneus SET
        tratamento_descarte = ?,
        tratamento_descarte_obs = ?,
        tratamento_descarte_em = ?
      WHERE id = ?
    `).run(tratamento, obs, hoje, pneu.id);

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);
    res.json({
      mensagem: `Tratamento: ${labelTratamentoDescarte(tratamento)}`,
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, pneu.id)),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
