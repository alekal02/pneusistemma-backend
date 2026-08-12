import { Router } from 'express';
import { getDb, classificarSulco } from '../database.js';
import { TIPOS_VEICULO } from '../config.js';
import { requireAuth, requireFilial, filialScopeId, assertVeiculoDaFilial } from '../auth.js';
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
router.get('/acesso-rapido', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ erro: 'Token obrigatório' });

  const tokenRow = validarTokenAcessoRapido(String(token));
  if (!tokenRow) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }

  marcarTokenUsado(tokenRow.id);

  const detalhe = montarDetalheVeiculo(tokenRow.veiculo_id, tokenRow.filial_id);
  if (!detalhe) {
    return res.status(404).json({ erro: 'Veículo não encontrado' });
  }

  res.json({
    ...detalhe,
    acesso_rapido: true,
    token_acesso: tokenRow.token,
  });
});

/**
 * Público (token WhatsApp): cria pneu e monta na posição do veículo do link.
 * Permite o borracheiro informar pneu novo sem login.
 */
router.post('/acesso-rapido/montar-novo', (req, res) => {
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

  const tokenRow = validarTokenAcessoRapido(String(token));
  if (!tokenRow) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
  marcarTokenUsado(tokenRow.id);

  const filialId = tokenRow.filial_id;
  const veiculo = assertVeiculoDaFilial(tokenRow.veiculo_id, filialId);
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
  const ocupado = db.prepare(`
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

  try {
    db.exec('BEGIN');
    const created = db.prepare(`
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

    const pneuId = created.lastInsertRowid;
    db.prepare(`
      INSERT INTO movimentacoes (
        pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
        posicao, detalhes, veiculo_placa
      ) VALUES (?, ?, 'montagem', ?, ?, ?, ?, ?, ?)
    `).run(
      pneuId,
      veiculo.id,
      data,
      Number.isFinite(km) ? km : null,
      Number.isFinite(hr) ? hr : null,
      posicao,
      `Acesso rápido WhatsApp · ${veiculo.placa} · ${labelPosicao(posicao)}`,
      veiculo.placa
    );
    db.exec('COMMIT');

    const detalhe = montarDetalheVeiculo(veiculo.id, filialId);
    res.status(201).json({
      mensagem: `Pneu ${fogo} montado em ${labelPosicao(posicao)}`,
      pneu_id: pneuId,
      veiculo: detalhe,
      token_acesso: tokenRow.token,
      acesso_rapido: true,
    });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Nº de fogo já existe nesta filial' });
    }
    throw err;
  }
});

router.use(requireAuth);
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
router.post('/import', (req, res) => {
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

  db.exec('BEGIN');
  try {
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
        const result = insert.run(
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
        const posicoes = aplicarLayoutPneus(db, result.lastInsertRowid, layoutId, null);
        inseridos.push({
          id: result.lastInsertRowid,
          placa,
          layout: layoutId,
          posicoes: posicoes.length,
        });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          erros.push({ linha, placa, erro: 'Placa já cadastrada' });
        } else {
          erros.push({ linha, placa, erro: err.message });
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return res.status(500).json({ erro: err.message });
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

router.get('/', (req, res) => {
  const db = getDb();
  const filialId = filialScopeId(req);
  const veiculos = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM pneus p WHERE p.veiculo_id = v.id AND p.ativo = 1 AND p.status_pneu = 'montado') as total_pneus,
      (SELECT MIN(
        CASE
          WHEN m.sulco_externo IS NULL AND m.sulco_central IS NULL
               AND m.sulco_interno IS NULL AND m.sulco_auxiliar IS NULL THEN NULL
          ELSE MIN(
            COALESCE(m.sulco_externo, 999),
            COALESCE(m.sulco_central, 999),
            COALESCE(m.sulco_interno, 999),
            COALESCE(m.sulco_auxiliar, 999)
          )
        END
      )
      FROM pneus p
      LEFT JOIN medicoes m ON m.pneu_id = p.id
        AND m.id = (SELECT id FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1)
      WHERE p.veiculo_id = v.id AND p.ativo = 1
      ) as menor_sulco
    FROM veiculos v
    WHERE v.ativo = 1 AND v.filial_id = ?
    ORDER BY v.apelido, v.placa
  `).all(filialId);

  const resultado = veiculos.map((v) => ({
    ...v,
    tipo: normalizarTipoVeiculo(v.tipo),
    menor_sulco: v.menor_sulco === 999 ? null : v.menor_sulco,
    status_sulco: classificarSulco(v.menor_sulco === 999 ? null : v.menor_sulco),
  }));

  res.json(resultado);
});

/** Gera link de acesso rápido para compartilhar no WhatsApp */
router.get('/:id/link-whatsapp', (req, res) => {
  const db = getDb();
  const filialId = filialScopeId(req);
  const veiculo = db.prepare(`
    SELECT id, placa, filial_id FROM veiculos
    WHERE id = ? AND ativo = 1 AND filial_id = ?
  `).get(req.params.id, filialId);

  if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

  const { token, link } = gerarTokenAcessoRapido({
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
});

router.get('/:id', (req, res) => {
  const filialId = filialScopeId(req);
  const detalhe = montarDetalheVeiculo(req.params.id, filialId);
  if (!detalhe) return res.status(404).json({ erro: 'Veículo não encontrado' });
  res.json(detalhe);
});

router.post('/', (req, res) => {
  const {
    placa, apelido, tipo, marca, modelo, ano,
    km_atual, hr_atual, observacoes, layout_pneus, posicoes_custom,
  } = req.body;
  if (!placa?.trim()) return res.status(400).json({ erro: 'Placa é obrigatória' });

  const db = getDb();
  const filialId = filialScopeId(req);
  try {
    const layoutId = layout_pneus || LAYOUT_PADRAO;
    const result = db.prepare(`
      INSERT INTO veiculos (placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus, filial_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      filialId
    );

    const posicoes = aplicarLayoutPneus(
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
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Placa já cadastrada' });
    }
    throw err;
  }
});

router.put('/:id/layout', (req, res) => {
  const { layout_pneus, posicoes_custom } = req.body;
  const db = getDb();
  const filialId = filialScopeId(req);

  const veiculo = db.prepare(`
    SELECT id FROM veiculos WHERE id = ? AND ativo = 1 AND filial_id = ?
  `).get(req.params.id, filialId);
  if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

  if (!layout_pneus && (!posicoes_custom || !posicoes_custom.length)) {
    return res.status(400).json({ erro: 'Informe um layout ou lista de posições' });
  }

  try {
    const posicoes = aplicarLayoutPneus(
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
    res.status(400).json({ erro: err.message });
  }
});

router.put('/:id', (req, res) => {
  const { placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes } = req.body;
  const db = getDb();
  const filialId = filialScopeId(req);

  const result = db.prepare(`
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
      updated_at = datetime('now', 'localtime')
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
    req.params.id,
    filialId
  );

  if (result.changes === 0) return res.status(404).json({ erro: 'Veículo não encontrado' });
  res.json({ mensagem: 'Veículo atualizado' });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const filialId = filialScopeId(req);
  const result = db.prepare(`
    UPDATE veiculos SET ativo = 0, updated_at = datetime('now', 'localtime')
    WHERE id = ? AND filial_id = ?
  `).run(req.params.id, filialId);

  if (result.changes === 0) return res.status(404).json({ erro: 'Veículo não encontrado' });
  res.json({ mensagem: 'Veículo desativado' });
});

export default router;
