import { Router } from 'express';
import { getDb, classificarSulco } from '../database.js';
import { comSavepoint, ehViolacaoUnique } from '../db-utils.js';
import { TIPOS_VEICULO } from '../config.js';
import { limitesDoVeiculo } from '../limites.js';
import { requireAuth, requireFilial, requireGerenteOuAdmin, filialScopeId, filiaisEscopoIds, assertVeiculoDaFilial } from '../auth.js';
import {
  POSICOES_PNEU,
  LAYOUTS_PNEU,
  LAYOUT_PADRAO,
  PAPEL_POSICAO,
  TIPOS_PNEU,
  CONDICOES_PNEU,
  labelPosicao,
  papelPosicao,
  aplicarLayoutPneus,
  validarMontagem,
  getLayout,
} from '../pneus-layouts.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import { normalizarDiaMedicao } from '../dia-medicao.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import {
  parseCsv,
  toCsv,
  VEICULO_TEMPLATE_HEADERS,
  VEICULO_TEMPLATE_ROWS,
  mapLayoutId,
} from '../csv-utils.js';
import {
  gerarTokenAcessoRapido,
  validarTokenAcessoRapido,
  marcarTokenUsado,
  montarDetalheVeiculo,
} from '../services/acesso-rapido.js';

const router = Router();

/** Público: acesso via token WhatsApp (sem JWT) */
router.get('/acesso-rapido', async (req, res, next) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ erro: 'Token obrigatório' });

  try {
    const tokenRow = await validarTokenAcessoRapido(String(token), ['medir']);
    if (!tokenRow) {
      return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
    if (!tokenRow.veiculo_id) {
      return res.status(400).json({ erro: 'Token sem veículo — use o link correto do menu' });
    }

    await marcarTokenUsado(tokenRow.id);

    const detalhe = await montarDetalheVeiculo(tokenRow.veiculo_id, tokenRow.filial_id);
    if (!detalhe) {
      return res.status(404).json({ erro: 'Veículo não encontrado' });
    }

    res.json({
      ...detalhe,
      acesso_rapido: true,
      token_acesso: tokenRow.token,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Público (token WhatsApp): cria pneu e monta na posição do veículo do link.
 * Permite o borracheiro informar pneu novo sem login.
 */
router.post('/acesso-rapido/montar-novo', async (req, res, next) => {
  const {
    token,
    posicao,
    numero_fogo,
    tipo_pneu = 'misto',
    condicao = 'novo',
    marca = null,
    modelo = null,
    sulco_inicial_mm = null,
    km_veiculo = null,
    hr_veiculo = null,
  } = req.body || {};

  if (!token) return res.status(400).json({ erro: 'Token obrigatório' });
  if (!posicao) return res.status(400).json({ erro: 'Informe a posição' });
  if (!String(numero_fogo || '').trim()) {
    return res.status(400).json({ erro: 'Informe o nº de fogo' });
  }
  if (!String(modelo || '').trim()) {
    return res.status(400).json({ erro: 'Informe o modelo do pneu' });
  }

  try {
    const tokenRow = await validarTokenAcessoRapido(String(token));
    if (!tokenRow) {
      return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
    await marcarTokenUsado(tokenRow.id);

    const filialId = tokenRow.filial_id;
    const veiculo = await assertVeiculoDaFilial(tokenRow.veiculo_id, filialId);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
    if (!layout.posicoes.includes(posicao)) {
      return res.status(400).json({ erro: `Posição ${posicao} não faz parte do layout do veículo` });
    }

    const tipo = String(tipo_pneu || 'misto');
    const cond = String(condicao || 'novo');
    if (!TIPOS_PNEU.includes(tipo)) {
      return res.status(400).json({ erro: `tipo_pneu inválido` });
    }
    if (!CONDICOES_PNEU.includes(cond)) {
      return res.status(400).json({ erro: `condicao inválida` });
    }

    const validacao = validarMontagem({ condicao: cond, tipo_pneu: tipo, posicao });
    if (!validacao.ok) {
      return res.status(400).json({ erro: validacao.erros.join(' ') });
    }

    const db = getDb();
    const ocupado = await db.prepare(`
      SELECT id, numero_fogo FROM pneus
      WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
    `).get(veiculo.id, posicao);
    if (ocupado) {
      return res.status(409).json({
        erro: `Posição já tem pneu${ocupado.numero_fogo ? ` (fogo ${ocupado.numero_fogo})` : ''}`,
      });
    }

    const fogo = String(numero_fogo).trim();
    const data = new Date().toISOString().split('T')[0];
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : veiculo.km_atual;
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : veiculo.hr_atual;
    const sulco = sulco_inicial_mm != null && sulco_inicial_mm !== ''
      ? parseFloat(String(sulco_inicial_mm).replace(',', '.'))
      : null;
    const vida = cond === 'recapado' ? 1 : 0;

    const pneuId = await db.transaction(async () => {
      const created = await db.prepare(`
        INSERT INTO pneus (
          veiculo_id, posicao, filial_id, marca, modelo, numero_fogo,
          tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu,
          data_instalacao, km_instalacao, ativo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'montado', ?, ?, 1)
      `).run(
        veiculo.id,
        posicao,
        filialId,
        marca ? String(marca).trim() : null,
        String(modelo).trim(),
        fogo,
        tipo,
        cond,
        vida,
        Number.isFinite(sulco) ? sulco : null,
        data,
        Number.isFinite(km) ? km : null
      );

      await db.prepare(`
        INSERT INTO movimentacoes (
          pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
          posicao, detalhes, veiculo_placa
        ) VALUES (?, ?, 'montagem', ?, ?, ?, ?, ?, ?)
      `).run(
        created.lastInsertRowid,
        veiculo.id,
        data,
        Number.isFinite(km) ? km : null,
        Number.isFinite(hr) ? hr : null,
        posicao,
        `Acesso rápido WhatsApp · ${veiculo.placa} · ${labelPosicao(posicao)}`,
        veiculo.placa
      );

      return created.lastInsertRowid;
    });

    const detalhe = await montarDetalheVeiculo(veiculo.id, filialId);
    res.status(201).json({
      mensagem: `Pneu ${fogo} montado em ${labelPosicao(posicao)}`,
      pneu_id: pneuId,
      veiculo: detalhe,
      token_acesso: tokenRow.token,
      acesso_rapido: true,
    });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Nº de fogo já existe nesta filial' });
    }
    next(err);
  }
});

router.use(requireAuth);

/** Layout do veículo — só gerente/admin (operador não altera estrutura) */
router.put('/:id/layout', requireGerenteOuAdmin, async (req, res, next) => {
  const { layout_pneus, posicoes_custom } = req.body;
  const db = getDb();

  let veiculo;
  try {
    veiculo = await db.prepare(`
      SELECT id, filial_id FROM veiculos WHERE id = ? AND ativo = 1
    `).get(req.params.id);
  } catch (err) {
    return next(err);
  }
  if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

  const escopo = filiaisEscopoIds(req);
  if (escopo !== null && !escopo.includes(Number(veiculo.filial_id))) {
    return res.status(403).json({ erro: 'Veículo fora do seu escopo' });
  }

  if (!layout_pneus && (!posicoes_custom || !posicoes_custom.length)) {
    return res.status(400).json({ erro: 'Informe um layout ou lista de posições' });
  }

  try {
    const posicoes = await aplicarLayoutPneus(
      db,
      req.params.id,
      layout_pneus || 'personalizado',
      posicoes_custom
    );

    res.json({
      layout_pneus: layout_pneus || 'personalizado',
      total_posicoes: posicoes.length,
      posicoes: posicoes.map((p) => ({
        codigo: p,
        label: labelPosicao(p),
        papel: papelPosicao(p),
      })),
      mensagem: `Configuração atualizada — ${posicoes.length} posições (monte pneus do estoque)`,
    });
  } catch (err) {
    next(err);
  }
});

router.use(requireFilial);

router.get('/meta', (_req, res) => {
  res.json({
    posicoes: POSICOES_PNEU,
    papeis: PAPEL_POSICAO,
    tipos: TIPOS_VEICULO,
    layouts: Object.values(LAYOUTS_PNEU),
    layout_padrao: LAYOUT_PADRAO,
    tipos_pneu: TIPOS_PNEU,
    condicoes_pneu: CONDICOES_PNEU,
  });
});

/** Planilha-modelo de veículos (CSV Excel BR) */
router.get('/import/modelo', (_req, res) => {
  const csv = toCsv(VEICULO_TEMPLATE_HEADERS, VEICULO_TEMPLATE_ROWS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-veiculos.csv"');
  res.send(csv);
});

/** Importação em massa de veículos */
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

  const insert = db.prepare(`
    INSERT INTO veiculos (placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus, filial_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    await db.transaction(async () => {
      for (const raw of rows) {
        const linha = raw.__linha || '?';
        const placa = String(raw.placa || '').trim().toUpperCase();
        if (!placa) {
          erros.push({ linha, erro: 'Placa obrigatória' });
          continue;
        }

        const tipo = normalizarTipoVeiculo(raw.tipo) || 'Truck / Tração';
        const layoutId = mapLayoutId(raw.layout_pneus || raw.layout, tipo);
        if (!LAYOUTS_PNEU[layoutId]) {
          erros.push({ linha, placa, erro: `Layout inválido: ${raw.layout_pneus || raw.layout}` });
          continue;
        }

        const ano = raw.ano ? parseInt(raw.ano, 10) : null;
        const km = raw.km_atual != null && raw.km_atual !== '' ? parseInt(raw.km_atual, 10) : 0;
        const hr = raw.hr_atual != null && raw.hr_atual !== '' ? parseFloat(raw.hr_atual) : 0;

        try {
          const { result, posicoes } = await comSavepoint(db, async () => {
            const inserido = await insert.run(
              placa,
              String(raw.apelido || '').trim() || null,
              tipo,
              String(raw.marca || '').trim() || null,
              String(raw.modelo || '').trim() || null,
              Number.isFinite(ano) ? ano : null,
              Number.isFinite(km) ? km : 0,
              Number.isFinite(hr) ? hr : 0,
              String(raw.observacoes || '').trim() || null,
              layoutId,
              filialId
            );
            return {
              result: inserido,
              posicoes: await aplicarLayoutPneus(db, inserido.lastInsertRowid, layoutId, null),
            };
          });
          inseridos.push({
            id: result.lastInsertRowid,
            placa,
            layout: layoutId,
            posicoes: posicoes.length,
          });
        } catch (err) {
          if (ehViolacaoUnique(err)) {
            erros.push({ linha, placa, erro: 'Placa já cadastrada' });
          } else {
            erros.push({ linha, placa, erro: err.message });
          }
        }
      }
    });
  } catch (err) {
    return next(err);
  }

  if (!inseridos.length && erros.length) {
    return res.status(400).json({
      erro: 'Nenhum veículo importado',
      inseridos: 0,
      erros,
      avisos,
    });
  }

  res.status(201).json({
    mensagem: `${inseridos.length} veículo(s) importado(s)`,
    inseridos: inseridos.length,
    detalhes: inseridos,
    erros,
    avisos,
  });
});

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const veiculos = await db.prepare(`
    SELECT v.*,
      COALESCE(s.total_pneus, 0) as total_pneus,
      s.menor_sulco,
      s.ultima_medicao,
      s.ultima_atualizacao,
      COALESCE(s.pneus_medidos, 0) as pneus_medidos
    FROM veiculos v
    LEFT JOIN (
      SELECT
        p.veiculo_id,
        COUNT(*) FILTER (WHERE p.status_pneu = 'montado') as total_pneus,
        MIN(LEAST(
          COALESCE(um.sulco_externo, 999),
          COALESCE(um.sulco_central, 999),
          COALESCE(um.sulco_interno, 999),
          COALESCE(um.sulco_auxiliar, 999)
        )) FILTER (WHERE um.id IS NOT NULL AND (
          um.sulco_externo IS NOT NULL OR um.sulco_central IS NOT NULL
          OR um.sulco_interno IS NOT NULL OR um.sulco_auxiliar IS NOT NULL
        )) as menor_sulco,
        MAX(um.data_medicao) as ultima_medicao,
        MAX(um.created_at) as ultima_atualizacao,
        COUNT(*) FILTER (WHERE p.status_pneu = 'montado' AND um.id IS NOT NULL) as pneus_medidos
      FROM pneus p
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1 AND p.veiculo_id IS NOT NULL
      GROUP BY p.veiculo_id
    ) s ON s.veiculo_id = v.id
    WHERE v.ativo = 1 AND v.filial_id = ?
    ORDER BY v.apelido, v.placa
  `).all(filialId);

    const resultado = veiculos.map((v) => ({
      ...v,
      tipo: normalizarTipoVeiculo(v.tipo),
      menor_sulco: v.menor_sulco === 999 ? null : v.menor_sulco,
      status_sulco: classificarSulco(v.menor_sulco === 999 ? null : v.menor_sulco, limitesDoVeiculo(v)),
      pneus_medidos: Number(v.pneus_medidos) || 0,
      ultima_medicao: v.ultima_medicao || null,
      dia_medicao: normalizarDiaMedicao(v.dia_medicao),
    }));

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

/** Gera link de acesso rápido para compartilhar no WhatsApp */
router.get('/:id/link-whatsapp', async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const veiculo = await db.prepare(`
      SELECT id, placa, filial_id FROM veiculos
      WHERE id = ? AND ativo = 1 AND filial_id = ?
    `).get(req.params.id, filialId);

    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const { token, link } = await gerarTokenAcessoRapido({
      veiculoId: veiculo.id,
      filialId: veiculo.filial_id,
      whatsappOrigem: null,
    });

    res.json({
      link,
      token,
      placa: veiculo.placa,
      expira_em_horas: 24,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const filialId = filialScopeId(req);
    const detalhe = await montarDetalheVeiculo(req.params.id, filialId);
    if (!detalhe) return res.status(404).json({ erro: 'Veículo não encontrado' });
    res.json(detalhe);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const {
    placa, apelido, tipo, marca, modelo, ano,
    km_atual, hr_atual, observacoes, layout_pneus, posicoes_custom,
    dia_medicao,
  } = req.body;
  if (!placa?.trim()) return res.status(400).json({ erro: 'Placa é obrigatória' });

  const db = getDb();
  const filialId = filialScopeId(req);
  try {
    const layoutId = layout_pneus || LAYOUT_PADRAO;
    const result = await db.prepare(`
      INSERT INTO veiculos (placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus, filial_id, dia_medicao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      placa.trim().toUpperCase(),
      apelido?.trim() || null,
      normalizarTipoVeiculo(tipo) || 'Truck / Tração',
      marca?.trim() || null,
      modelo?.trim() || null,
      ano || null,
      km_atual || 0,
      hr_atual || 0,
      observacoes?.trim() || null,
      layoutId,
      filialId,
      normalizarDiaMedicao(dia_medicao)
    );

    const posicoes = await aplicarLayoutPneus(
      db,
      result.lastInsertRowid,
      layoutId,
      posicoes_custom?.length ? posicoes_custom : null
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      total_posicoes: posicoes.length,
      mensagem: `Veículo cadastrado com ${posicoes.length} posições — monte pneus do estoque`,
    });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Placa já cadastrada' });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const { placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, dia_medicao } = req.body;
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const atual = await db.prepare(`
      SELECT id, dia_medicao FROM veiculos WHERE id = ? AND ativo = 1 AND filial_id = ?
    `).get(req.params.id, filialId);
    if (!atual) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const diaSalvo = Object.prototype.hasOwnProperty.call(req.body || {}, 'dia_medicao')
      ? normalizarDiaMedicao(dia_medicao)
      : atual.dia_medicao;

    const result = await db.prepare(`
      UPDATE veiculos SET
        placa = COALESCE(?, placa),
        apelido = ?,
        tipo = COALESCE(?, tipo),
        marca = ?,
        modelo = ?,
        ano = ?,
        km_atual = COALESCE(?, km_atual),
        hr_atual = COALESCE(?, hr_atual),
        observacoes = ?,
        dia_medicao = ?,
        updated_at = NOW()
      WHERE id = ? AND ativo = 1 AND filial_id = ?
    `).run(
      placa?.trim().toUpperCase() || null,
      apelido?.trim() || null,
      tipo != null ? normalizarTipoVeiculo(tipo) : null,
      marca?.trim() || null,
      modelo?.trim() || null,
      ano || null,
      km_atual != null ? km_atual : null,
      hr_atual != null ? hr_atual : null,
      observacoes?.trim() || null,
      diaSalvo,
      req.params.id,
      filialId
    );

    if (result.changes === 0) return res.status(404).json({ erro: 'Veículo não encontrado' });
    res.json({ mensagem: 'Veículo atualizado' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const result = await db.prepare(`
      UPDATE veiculos SET ativo = 0, updated_at = NOW()
      WHERE id = ? AND filial_id = ?
    `).run(req.params.id, filialId);

    if (result.changes === 0) return res.status(404).json({ erro: 'Veículo não encontrado' });
    res.json({ mensagem: 'Veículo desativado' });
  } catch (err) {
    next(err);
  }
});

export default router;
