import { Router } from 'express';
import { getDb, classificarSulco } from '../database.js';
import { comSavepoint, ehViolacaoUnique } from '../db-utils.js';
import { TIPOS_VEICULO } from '../config.js';
import { camposTipoVeiculo, metaTiposEquipamento } from '../equipamento-tipos.js';
import { especificacaoMedicao, INSPECOES_DANO } from '../medicao-perfil.js';
import { limitesDoVeiculo } from '../limites.js';
import { requireAuth, requireFilial, requireGerenteOuAdmin, filialScopeId, filiaisEscopoIds, assertVeiculoDaFilial, temPrivilegioAdmin } from '../auth.js';
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
  layoutParaNovoVeiculo,
  layoutNaEdicao,
} from '../pneus-layouts.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import { normalizarDiaMedicao } from '../dia-medicao.js';
import { SQL_LATERAL_ULTIMA_MEDICAO } from '../sql-ultima-medicao.js';
import { envelopePagina, lerPaginacao, veiculoCombinaBusca } from '../paginacao.js';
import { veiculoCombinaTipo } from '../services/indicadores-frota.js';
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
import { consultarProximoFogo, comRetryFogoUnico } from '../numero-fogo.js';
import { montarPneu, completarVeiculo } from '../services/whatsapp-ops.js';
import { excluirVeiculoCompleto } from '../services/limpar-filial.js';
import { invalidarExecutivoAoConfirmar } from '../services/invalidacao-executiva.js';

const router = Router();
router.use(invalidarExecutivoAoConfirmar());

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
      proximo_fogo: await consultarProximoFogo(getDb(), tokenRow.filial_id).catch(() => null),
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
  if (!String(modelo || '').trim()) {
    return res.status(400).json({ erro: 'Informe o modelo do pneu' });
  }

  try {
    const tokenRow = await validarTokenAcessoRapido(String(token));
    if (!tokenRow) {
      return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
    req.acessoRapido = tokenRow;
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

    const data = new Date().toISOString().split('T')[0];
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : veiculo.km_atual;
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : veiculo.hr_atual;
    const sulco = sulco_inicial_mm != null && sulco_inicial_mm !== ''
      ? parseFloat(String(sulco_inicial_mm).replace(',', '.'))
      : null;
    const vida = cond === 'recapado' ? 1 : 0;

    let fogoUsado = null;
    const pneuId = await db.transaction(async () => {
      const { result, numero_fogo: fogoOk } = await comRetryFogoUnico(
        db,
        filialId,
        numero_fogo,
        (fogo) => comSavepoint(db, () => db.prepare(`
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
        ))
      );
      fogoUsado = fogoOk;

      await db.prepare(`
        INSERT INTO movimentacoes (
          pneu_id, veiculo_id, tipo, data_evento, km_veiculo, hr_veiculo,
          posicao, detalhes, veiculo_placa
        ) VALUES (?, ?, 'montagem', ?, ?, ?, ?, ?, ?)
      `).run(
        result.lastInsertRowid,
        veiculo.id,
        data,
        Number.isFinite(km) ? km : null,
        Number.isFinite(hr) ? hr : null,
        posicao,
        `Acesso rápido WhatsApp · ${veiculo.placa} · ${labelPosicao(posicao)}`,
        veiculo.placa
      );

      return result.lastInsertRowid;
    });

    const detalhe = await montarDetalheVeiculo(veiculo.id, filialId);
    res.status(201).json({
      mensagem: `Pneu ${fogoUsado} montado em ${labelPosicao(posicao)}`,
      pneu_id: pneuId,
      veiculo: detalhe,
      token_acesso: tokenRow.token,
      acesso_rapido: true,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Nº de fogo já existe nesta filial' });
    }
    next(err);
  }
});

router.use(requireAuth);

/** Catálogo de layouts — admin/gerente também editam caminhão da unidade */
router.get('/meta', (_req, res) => {
  const cat = metaTiposEquipamento();
  res.json({
    posicoes: POSICOES_PNEU,
    papeis: PAPEL_POSICAO,
    tipos: cat.tipos,
    tipos_equipamento: cat.tipos_equipamento.map((t) => ({
      ...t,
      medicao: especificacaoMedicao(t.codigo),
    })),
    inspecoes_dano: INSPECOES_DANO,
    layout_padrao_por_tipo: cat.layout_padrao_por_tipo,
    layouts: Object.values(LAYOUTS_PNEU),
    layout_padrao: LAYOUT_PADRAO,
    tipos_pneu: TIPOS_PNEU,
    condicoes_pneu: CONDICOES_PNEU,
  });
});

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

/** Admin: exclui caminhão (pneus montados voltam ao estoque). Filial: só desativa. */
router.delete('/:id', async (req, res, next) => {
  try {
    const db = getDb();
    const papel = req.user?.papel;
    if (temPrivilegioAdmin(req.user)) {
      const veiculo = await db.prepare('SELECT id, filial_id FROM veiculos WHERE id = ?').get(req.params.id);
      if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });
      const escopo = filiaisEscopoIds(req);
      if (escopo !== null && !escopo.includes(Number(veiculo.filial_id))) {
        return res.status(403).json({ erro: 'Veículo fora do seu escopo' });
      }
      const result = await excluirVeiculoCompleto(db, veiculo.filial_id, veiculo.id);
      const n = result.pneus_desvinculados || 0;
      return res.json({
        mensagem: n
          ? `Caminhão ${result.placa} excluído. ${n} pneu(s) foram desvinculados (os que estavam montados voltaram ao estoque).`
          : `Caminhão ${result.placa} excluído`,
        ...result,
      });
    }
    if (papel === 'gerente') {
      return res.status(403).json({ erro: 'Só o administrador pode excluir veículo' });
    }
    if (papel === 'filial') {
      const filialId = filialScopeId(req);
      const result = await db.prepare(`
        UPDATE veiculos SET ativo = 0, updated_at = NOW()
        WHERE id = ? AND filial_id = ?
      `).run(req.params.id, filialId);
      if (result.changes === 0) return res.status(404).json({ erro: 'Veículo não encontrado' });
      return res.json({ mensagem: 'Veículo desativado' });
    }
    return res.status(403).json({ erro: 'Sem permissão para excluir veículo' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.use(requireFilial);

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
    INSERT INTO veiculos (placa, apelido, tipo, tipo_codigo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus, filial_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        const tipoCampos = camposTipoVeiculo(normalizarTipoVeiculo(raw.tipo) || 'Truck / Tração');
        const tipo = tipoCampos.tipo;
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
              tipoCampos.tipo_codigo,
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
    const paginacao = lerPaginacao(req.query, { padrao: 24, maximo: 50 });
    let metaPagina = null;
    if (paginacao) {
      const leves = await db.prepare(`
        SELECT id, placa, apelido, tipo, marca, modelo
        FROM veiculos
        WHERE ativo = 1 AND filial_id = ?
        ORDER BY apelido, placa
      `).all(filialId);
      const tipos = [...new Set(leves.map((v) => v.tipo).filter(Boolean))];
      const filtrados = leves.filter((v) => (
        veiculoCombinaBusca(v, req.query.q)
        && veiculoCombinaTipo(v.tipo, req.query.tipo)
      ));
      const fatia = filtrados.slice(paginacao.offset, paginacao.offset + paginacao.limite);
      metaPagina = {
        total: filtrados.length,
        tipos,
        ids: fatia.map((v) => Number(v.id)),
      };
      if (!metaPagina.ids.length) {
        return res.json({ ...envelopePagina([], metaPagina.total, paginacao), tipos });
      }
    }
    const filtroIdsPneu = metaPagina
      ? ` AND p.veiculo_id IN (${metaPagina.ids.map(() => '?').join(',')})`
      : '';
    const filtroIdsVeiculo = metaPagina
      ? ` AND v.id IN (${metaPagina.ids.map(() => '?').join(',')})`
      : '';
    const paramsLista = metaPagina
      ? [...metaPagina.ids, filialId, ...metaPagina.ids]
      : [filialId];
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
          COALESCE(um.sulco_auxiliar, 999),
          COALESCE(um.sulco_mm, 999)
        )) FILTER (WHERE um.id IS NOT NULL AND (
          um.sulco_externo IS NOT NULL OR um.sulco_central IS NOT NULL
          OR um.sulco_interno IS NOT NULL OR um.sulco_auxiliar IS NOT NULL
          OR um.sulco_mm IS NOT NULL
        )) as menor_sulco,
        MAX(um.data_medicao) as ultima_medicao,
        MAX(um.created_at) as ultima_atualizacao,
        COUNT(*) FILTER (WHERE p.status_pneu = 'montado' AND um.id IS NOT NULL) as pneus_medidos
      FROM pneus p
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1 AND p.veiculo_id IS NOT NULL${filtroIdsPneu}
      GROUP BY p.veiculo_id
    ) s ON s.veiculo_id = v.id
    WHERE v.ativo = 1 AND v.filial_id = ?${filtroIdsVeiculo}
    ORDER BY v.apelido, v.placa
  `).all(...paramsLista);

    let resultado = veiculos.map((v) => {
      const cadastroPendente = Number(v.cadastro_completo ?? 1) !== 1;
      return {
        ...v,
        tipo: normalizarTipoVeiculo(v.tipo),
        cadastro_pendente: cadastroPendente,
        menor_sulco: cadastroPendente ? null : (v.menor_sulco === 999 ? null : v.menor_sulco),
        status_sulco: cadastroPendente
          ? 'cadastro_pendente'
          : classificarSulco(v.menor_sulco === 999 ? null : v.menor_sulco, limitesDoVeiculo(v)),
        pneus_medidos: cadastroPendente ? 0 : (Number(v.pneus_medidos) || 0),
        ultima_medicao: cadastroPendente ? null : (v.ultima_medicao || null),
        dia_medicao: normalizarDiaMedicao(v.dia_medicao),
      };
    });

    if (metaPagina) {
      const ordem = new Map(metaPagina.ids.map((id, i) => [id, i]));
      resultado = resultado.sort((a, b) => (ordem.get(Number(a.id)) ?? 0) - (ordem.get(Number(b.id)) ?? 0));
      return res.json({
        ...envelopePagina(resultado, metaPagina.total, paginacao),
        tipos: metaPagina.tipos,
      });
    }
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

/** Operador da unidade conclui o pré-cadastro (marca, modelo e eixos). */
router.post('/:id/concluir', async (req, res, next) => {
  try {
    const filialId = filialScopeId(req);
    const { marca, modelo, tipo, km_atual, layout_pneus, apelido, ano } = req.body || {};
    const created = await completarVeiculo(filialId, req.params.id, {
      marca, modelo, tipo, km_atual, layout_pneus, apelido, ano,
    });
    res.json({
      mensagem: `Cadastro de ${created.placa} concluído`,
      veiculo_id: created.id,
      total_posicoes: created.total_posicoes,
      layout_pneus: created.layoutId,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
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
  const placaOk = placa.trim().toUpperCase();
  try {
    const tipoCampos = camposTipoVeiculo(normalizarTipoVeiculo(tipo) || 'Truck / Tração');
    const layoutId = layoutParaNovoVeiculo(tipoCampos.tipo, layout_pneus, {
      posicoesCustom: posicoes_custom,
    });
    const existente = await db.prepare(`
      SELECT id, filial_id, ativo FROM veiculos
      WHERE UPPER(TRIM(placa)) = ?
      LIMIT 1
    `).get(placaOk);
    if (existente) {
      return res.status(409).json({
        erro: 'Placa já cadastrada',
        codigo: 'duplicado',
        ...(Number(existente.filial_id) === Number(filialId) && existente.ativo ? { id: existente.id } : {}),
      });
    }

    const salvo = await db.transaction(async () => {
      const result = await db.prepare(`
      INSERT INTO veiculos (placa, apelido, tipo, tipo_codigo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus, filial_id, dia_medicao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        placaOk,
        apelido?.trim() || null,
        tipoCampos.tipo,
        tipoCampos.tipo_codigo,
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
      const id = result.lastInsertRowid;
      if (!id) {
        const err = new Error('O banco não confirmou o veículo');
        err.status = 500;
        throw err;
      }
      const posicoes = await aplicarLayoutPneus(
        db,
        id,
        layoutId,
        posicoes_custom?.length ? posicoes_custom : null
      );
      const gravado = await db.prepare(`
        SELECT id, placa FROM veiculos WHERE id = ? AND filial_id = ?
      `).get(id, filialId);
      if (!gravado) {
        const err = new Error('O banco não confirmou o veículo');
        err.status = 500;
        throw err;
      }
      return { id: gravado.id, total_posicoes: posicoes.length };
    });

    res.status(201).json({
      id: salvo.id,
      total_posicoes: salvo.total_posicoes,
      mensagem: `Veículo ${placaOk} cadastrado com ${salvo.total_posicoes} posições`,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    if (ehViolacaoUnique(err)) {
      const existente = await db.prepare(`
        SELECT id, filial_id, ativo FROM veiculos WHERE UPPER(TRIM(placa)) = ? LIMIT 1
      `).get(placaOk);
      return res.status(409).json({
        erro: 'Placa já cadastrada',
        codigo: 'duplicado',
        ...(existente && Number(existente.filial_id) === Number(filialId) && existente.ativo
          ? { id: existente.id }
          : {}),
      });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const { placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, dia_medicao, layout_pneus } = req.body;
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const atual = await db.prepare(`
      SELECT id, dia_medicao, layout_pneus FROM veiculos WHERE id = ? AND ativo = 1 AND filial_id = ?
    `).get(req.params.id, filialId);
    if (!atual) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const diaSalvo = Object.prototype.hasOwnProperty.call(req.body || {}, 'dia_medicao')
      ? normalizarDiaMedicao(dia_medicao)
      : atual.dia_medicao;
    const layoutSalvo = layoutNaEdicao(atual.layout_pneus, layout_pneus);

    const tipoCampos = tipo != null ? camposTipoVeiculo(normalizarTipoVeiculo(tipo)) : null;
    const result = await db.prepare(`
      UPDATE veiculos SET
        placa = COALESCE(?, placa),
        apelido = ?,
        tipo = COALESCE(?, tipo),
        tipo_codigo = COALESCE(?, tipo_codigo),
        marca = ?,
        modelo = ?,
        ano = ?,
        km_atual = COALESCE(?, km_atual),
        hr_atual = COALESCE(?, hr_atual),
        observacoes = ?,
        dia_medicao = ?,
        layout_pneus = ?,
        updated_at = NOW()
      WHERE id = ? AND ativo = 1 AND filial_id = ?
    `).run(
      placa?.trim().toUpperCase() || null,
      apelido?.trim() || null,
      tipoCampos ? tipoCampos.tipo : null,
      tipoCampos ? tipoCampos.tipo_codigo : null,
      marca?.trim() || null,
      modelo?.trim() || null,
      ano || null,
      km_atual != null ? km_atual : null,
      hr_atual != null ? hr_atual : null,
      observacoes?.trim() || null,
      diaSalvo,
      layoutSalvo,
      req.params.id,
      filialId
    );

    if (result.changes === 0) return res.status(404).json({ erro: 'Veículo não encontrado' });
    res.json({ mensagem: 'Veículo atualizado' });
  } catch (err) {
    next(err);
  }
});

export default router;
