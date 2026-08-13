import { Router } from 'express';
import { getDb, classificarSulco } from '../database.js';
import { comSavepoint, ehViolacaoUnique } from '../db-utils.js';
import { getLimites, menorSulco, adicionarDias } from '../limites.js';
import {
  diagnosticarPerfil,
  sugerirAcao,
  percentualVida,
} from '../diagnostico.js';
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
} from '../csv-utils.js';

const router = Router();

/** Únicas movimentações operacionais do pneu */
const TIPOS_MOVIMENTACAO = ['montagem', 'retirada', 'mudanca_posicao'];

router.use(requireAuth);
router.use(requireFilial);

async function ultimaMovimentacaoVeiculo(db, pneuId, veiculoId) {
  const row = await db.prepare(`
    SELECT * FROM movimentacoes
    WHERE pneu_id = ? AND veiculo_id = ?
      AND tipo IN ('montagem', 'retirada', 'mudanca_posicao', 'desmontagem')
    ORDER BY data_evento DESC, id DESC
    LIMIT 1
  `).get(pneuId, veiculoId);
  return row || null;
}

function deltaKmHr(anterior, kmAtual, hrAtual) {
  let kmRodado = null;
  let hrRodado = null;
  if (anterior?.km_veiculo != null && kmAtual != null) {
    const d = Number(kmAtual) - Number(anterior.km_veiculo);
    if (d >= 0) kmRodado = d;
  }
  if (anterior?.hr_veiculo != null && hrAtual != null) {
    const d = Number(hrAtual) - Number(anterior.hr_veiculo);
    if (d >= 0) hrRodado = Math.round(d * 10) / 10;
  }
  return { kmRodado, hrRodado };
}

async function registrarMovimentacao(db, {
  pneuId,
  veiculoId,
  tipo,
  data,
  km,
  hr,
  posicao,
  posicaoAnterior = null,
  detalhes = null,
  sulcoMm = null,
  placa = null,
}) {
  const anterior = veiculoId
    ? await ultimaMovimentacaoVeiculo(db, pneuId, veiculoId)
    : null;
  const { kmRodado, hrRodado } = deltaKmHr(anterior, km, hr);
  let placaFinal = placa || null;
  if (!placaFinal && veiculoId) {
    const v = await db.prepare('SELECT placa FROM veiculos WHERE id = ?').get(veiculoId);
    placaFinal = v?.placa || null;
  }

  return db.prepare(`
    INSERT INTO movimentacoes (
      pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
      posicao, posicao_anterior, sulco_mm, detalhes, km_rodado, hr_rodado, veiculo_placa
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pneuId,
    veiculoId,
    tipo,
    data,
    km,
    hr,
    posicao,
    posicaoAnterior,
    sulcoMm,
    detalhes,
    kmRodado,
    hrRodado,
    placaFinal
  );
}

async function atualizarKmHrVeiculo(db, veiculoId, filialId, km, hr) {
  if (km != null) {
    await db.prepare(`
      UPDATE veiculos SET km_atual = MAX(COALESCE(km_atual, 0), ?), updated_at = NOW()
      WHERE id = ? AND filial_id = ?
    `).run(km, veiculoId, filialId);
  }
  if (hr != null) {
    await db.prepare(`
      UPDATE veiculos SET hr_atual = MAX(COALESCE(hr_atual, 0), ?), updated_at = NOW()
      WHERE id = ? AND filial_id = ?
    `).run(hr, veiculoId, filialId);
  }
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
  const limites = getLimites();
  const row = ultimaMedicao || {};
  const menor = menorSulco(row);
  const papel = pneu.posicao ? papelPosicao(pneu.posicao) : null;
  const diagnostico = diagnosticarPerfil(row, limites.diagnostico_tolerancia_mm, {
    papel,
    posicao: pneu.posicao || null,
  });
  const acao = sugerirAcao(menor, limites, pneu.vida_recap || 0, {
    pontos: ultimaMedicao ? row : null,
    candidatos: candidatos.filter((c) => Number(c.id) !== Number(pneu.id)),
    posicaoAtual: pneu.posicao || null,
  });
  const sulcoRef = pneu.sulco_inicial_mm ?? limites.sulco_novo_mm;
  const statusSulco = classificarSulco(menor);
  const prazo = enriquecerPrazoRecap(pneu, statusSulco, limites);

  return {
    ...pneu,
    posicao_label: pneu.posicao ? labelPosicao(pneu.posicao) : null,
    papel_posicao: papel,
    padrao: pneu.tipo_pneu,
    padrao_label: labelTipoPneu(pneu.tipo_pneu),
    tipo_pneu_label: labelTipoPneu(pneu.tipo_pneu),
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

/** Planilha-modelo de pneus (CSV Excel BR) */
router.get('/import/modelo', (_req, res) => {
  const csv = toCsv(PNEU_TEMPLATE_HEADERS, PNEU_TEMPLATE_ROWS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-pneus.csv"');
  res.send(csv);
});

/** Importação em massa de pneus para o estoque */
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

  const insert = db.prepare(`
    INSERT INTO pneus (
      veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, ativo, observacoes,
      custo, nota_fiscal
    ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estoque', 1, ?, ?, ?)
  `);

  try {
    await db.transaction(async () => {
      for (const raw of rows) {
        const linha = raw.__linha || '?';
        const fogo = String(raw.numero_fogo || raw.fogo || '').trim();
        if (!fogo) {
          erros.push({ linha, erro: 'Nº de fogo obrigatório' });
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

        try {
          const result = await comSavepoint(db, () => insert.run(
            filialId,
            String(raw.marca || '').trim() || null,
            String(raw.modelo || '').trim() || null,
            String(raw.medida || '').trim() || null,
            String(raw.dot || '').trim() || null,
            fogo,
            tipo,
            cond,
            vida,
            Number.isFinite(sulco) ? sulco : null,
            String(raw.observacoes || '').trim() || null,
            Number.isFinite(custo) ? custo : null,
            String(raw.nota_fiscal || raw.nota || '').trim() || null
          ));
          inseridos.push({ id: result.lastInsertRowid, numero_fogo: fogo, tipo_pneu: tipo, condicao: cond });
        } catch (err) {
          if (ehViolacaoUnique(err)) {
            erros.push({ linha, numero_fogo: fogo, erro: 'Nº de fogo já existe nesta filial' });
          } else {
            erros.push({ linha, numero_fogo: fogo, erro: err.message });
          }
        }
      }
    });
  } catch (err) {
    return next(err);
  }

  if (!inseridos.length && erros.length) {
    return res.status(400).json({
      erro: 'Nenhum pneu importado',
      inseridos: 0,
      erros,
    });
  }

  res.status(201).json({
    mensagem: `${inseridos.length} pneu(s) importado(s) no estoque`,
    inseridos: inseridos.length,
    detalhes: inseridos,
    erros,
  });
});

/** Lista pneus da filial (estoque / montados / todos) */
router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const status = (req.query.status || 'todos').toLowerCase();
    const q = (req.query.q || '').trim();

    let where = 'p.ativo = 1 AND p.filial_id = ?';
    const params = [filialId];

    if (status === 'estoque') {
      where += ` AND p.status_pneu = 'estoque'`;
    } else if (status === 'montado') {
      where += ` AND p.status_pneu = 'montado'`;
    } else if (status === 'recapagem') {
      where += ` AND p.status_pneu = 'recapagem'`;
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
      (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
      (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
      (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
      (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux,
      (SELECT data_medicao FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_medicao
    FROM pneus p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE ${where}
    ORDER BY
      CASE p.status_pneu WHEN 'estoque' THEN 0 WHEN 'montado' THEN 1 ELSE 2 END,
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

  const fogo = numero_fogo?.trim();
  if (!fogo) {
    return res.status(400).json({ erro: 'Nº de fogo é obrigatório para cadastro no estoque' });
  }
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
    const result = await db.prepare(`
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
      fogo,
      tipo,
      cond,
      Number.isFinite(vida) ? vida : 0,
      sulco_inicial_mm != null ? parseFloat(sulco_inicial_mm) : null,
      observacoes?.trim() || null,
      Number.isFinite(custoNum) ? custoNum : null,
      nota_fiscal?.trim() || null
    );

    const pneu = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({
      mensagem: 'Pneu cadastrado no estoque',
      pneu: enriquecerPneu(pneu),
    });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Já existe um pneu com este nº de fogo na filial' });
    }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const pneu = await assertPneuDaFilial(req.params.id, filialScopeId(req));
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });

    const db = getDb();
    const limites = getLimites();
    const medicoes = await db.prepare(`
    SELECT m.*,
      COALESCE(m.veiculo_placa, v.placa) as veiculo_placa
    FROM medicoes m
    LEFT JOIN pneus p ON p.id = m.pneu_id
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    WHERE m.pneu_id = ?
    ORDER BY m.data_medicao DESC, m.id DESC
    LIMIT 50
  `).all(req.params.id);

    const medicoesComStatus = medicoes.map((m) => {
      const menor = menorSulco(m);
      const diag = diagnosticarPerfil(m, limites.diagnostico_tolerancia_mm, {
        papel: pneu.posicao ? papelPosicao(pneu.posicao) : null,
      });
      return {
        ...m,
        menor_sulco: menor,
        status_sulco: classificarSulco(menor),
        diagnostico_label: diag.label,
        veiculo_placa: m.veiculo_placa || pneu.placa || null,
      };
    });

    const movimentacoes = await db.prepare(`
    SELECT m.*,
      COALESCE(m.veiculo_placa, v.placa) as veiculo_placa
    FROM movimentacoes m
    LEFT JOIN veiculos v ON v.id = m.veiculo_id
    WHERE m.pneu_id = ?
      AND m.tipo IN ('montagem', 'retirada', 'mudanca_posicao', 'desmontagem')
    ORDER BY m.data_evento DESC, m.id DESC
    LIMIT 50
  `).all(req.params.id);

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
      montagem: 'Colocou no caminhão',
      retirada: 'Retirou do caminhão',
      desmontagem: 'Retirou do caminhão',
      mudanca_posicao: 'Mudou de posição',
    };

    res.json({
      ...enriquecerPneu(pneu, ultima, candidatos),
      veiculo_placa: veiculoPlaca,
      medicoes: medicoesComStatus,
      movimentacoes: movimentacoes.map((m) => ({
        ...m,
        tipo_label: labelsTipo[m.tipo] || m.tipo,
        padrao: pneu.tipo_pneu,
        padrao_label: padraoLabel,
        condicao: pneu.condicao,
        veiculo_placa: m.veiculo_placa || veiculoPlaca,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const {
    marca, modelo, medida, dot, numero_fogo,
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

  if (req.body.tipo_pneu != null && req.body.tipo_pneu !== atual.tipo_pneu) {
    return res.status(400).json({ erro: 'Padrão do pneu não pode ser alterado após o cadastro' });
  }
  if (req.body.condicao != null && req.body.condicao !== atual.condicao) {
    return res.status(400).json({ erro: 'Condição do pneu não pode ser alterada (use Registrar recap)' });
  }

  const fogo = numero_fogo != null ? String(numero_fogo).trim() : atual.numero_fogo;
  const modeloFinal = modelo != null ? String(modelo).trim() : atual.modelo;
  if (!modeloFinal) {
    return res.status(400).json({ erro: 'Modelo do pneu é obrigatório' });
  }

  const custoNum = custo != null && custo !== ''
    ? parseFloat(String(custo).replace(',', '.'))
    : atual.custo;

  try {
    await db.prepare(`
      UPDATE pneus SET
        marca = ?,
        modelo = ?,
        medida = ?,
        dot = ?,
        numero_fogo = ?,
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

/** Eventos especiais (recap/descarte) — não entram como movimentação operacional */
router.post('/:id/evento', async (req, res, next) => {
  const { tipo, data_evento, km_veiculo, hr_veiculo, detalhes, sulco_mm } = req.body;
  const tiposOk = ['recap', 'descarte'];
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

    if (tipo === 'recap') {
      const novaVida = (pneu.vida_recap || 0) + 1;
      if (novaVida > limites.max_recaps) {
        return res.status(400).json({
          erro: `Limite de recaps atingido (${limites.max_recaps}). Indique troca/descarte.`,
        });
      }

      await db.transaction(async () => {
        // Se estava montado, registra retirada antes
        if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
          const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
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
            placa: veiculo?.placa || null,
          });
          await atualizarKmHrVeiculo(db, pneu.veiculo_id, filialId, km, hr);
        }
        await db.prepare(`
          UPDATE pneus SET
            vida_recap = ?,
            condicao = 'recapado',
            status_pneu = 'estoque',
            veiculo_id = NULL,
            posicao = NULL,
            sulco_inicial_mm = COALESCE(?, sulco_inicial_mm),
            data_instalacao = NULL,
            km_instalacao = COALESCE(?, km_instalacao),
            data_alerta_monitorar = NULL
          WHERE id = ?
        `).run(
          novaVida,
          sulco_mm != null ? parseFloat(sulco_mm) : limites.sulco_novo_mm,
          km_veiculo != null ? parseInt(km_veiculo, 10) : null,
          pneu.id
        );
      });
    } else if (tipo === 'descarte') {
      await db.transaction(async () => {
        if (pneu.status_pneu === 'montado' && pneu.veiculo_id) {
          const veiculo = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
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
            placa: veiculo?.placa || null,
          });
        }
        await db.prepare(`
          UPDATE pneus SET
            status_pneu = 'descarte',
            ativo = 0,
            veiculo_id = NULL,
            posicao = NULL,
            data_alerta_monitorar = NULL,
            observacoes = COALESCE(observacoes || ' | ', '') || ?
          WHERE id = ?
        `).run(`descarte em ${data}${detalhes ? ` — ${detalhes}` : ''}`, pneu.id);
      });
    }

    const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);

    res.status(201).json({
      mensagem: tipo === 'recap' ? 'Recap registrado — pneu no estoque' : 'Pneu descartado',
      pneu: enriquecerPneu(atualizado, await ultimaMedicaoDoPneu(db, pneu.id)),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
