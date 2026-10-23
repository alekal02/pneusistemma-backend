import { Router } from 'express';
import { getDb } from '../database.js';
import { ehViolacaoUnique } from '../db-utils.js';
import {
  requireAuth,
  requireAdmin,
  requireGerenteOuAdmin,
  hashSenha,
  verificarSenha,
  filiaisEscopoIds,
  isAdmin,
  revogarSessoesDoUsuario,
} from '../auth.js';
import { excluirFilialCompleta, excluirPneuEstoqueOuDescarte, excluirVeiculoCompleto } from '../services/limpar-filial.js';
import { classificarSulco, getLimites, limitesDoVeiculo } from '../limites.js';
import { SQL_LATERAL_ULTIMA_MEDICAO, SQL_LOGS_MEDICAO_FILIAL } from '../sql-ultima-medicao.js';
import { especificacaoMedicao, prepararMedicao } from '../medicao-perfil.js';
import { percentualVida } from '../diagnostico.js';
import {
  avaliarPneuPainel,
  piorStatus,
  statusPainel,
  unidadeUsoVeiculo,
  veiculoCombinaTipo,
} from '../services/indicadores-frota.js';
import {
  labelPosicao,
  papelPosicao,
  sqlOrderPosicao,
  getLayout,
  LAYOUT_PADRAO,
  POSICOES_PNEU,
  layoutNaEdicao,
  labelTipoPneu,
  labelTratamentoDescarte,
} from '../pneus-layouts.js';
import { normalizarDiaMedicao } from '../dia-medicao.js';
import { consultarDiagnosticoExecutivo } from '../services/diagnostico-executivo.js';
import {
  calcularPendenciasFilial,
  calcularResumoFilial,
  carregarPainelFiliais,
} from '../services/filiais-painel.js';
import { camposTipoVeiculo } from '../equipamento-tipos.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import { filialDaGravacao, invalidarExecutivoAoConfirmar } from '../services/invalidacao-executiva.js';

const router = Router();

router.use(requireAuth);
router.use(requireGerenteOuAdmin);
router.use(invalidarExecutivoAoConfirmar({
  filialDe(req) {
    const id = Number(req.params?.id);
    if (Number.isInteger(id) && id > 0) return id;
    return filialDaGravacao(req);
  },
}));

function assertFilialNoEscopo(req, filialId) {
  const escopo = filiaisEscopoIds(req);
  if (escopo === null) return true;
  return escopo.includes(Number(filialId));
}

async function resumoFilial(db, filialId, _limites, tipoFiltro = null) {
  const mapa = await carregarPainelFiliais(db, [filialId]);
  return calcularResumoFilial(mapa.get(Number(filialId)), tipoFiltro);
}

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const escopo = filiaisEscopoIds(req);
    let sql = `
      SELECT f.*,
        (SELECT login FROM usuarios u
         WHERE u.filial_id = f.id AND u.papel IN ('filial', 'gerente') AND u.ativo = 1
         ORDER BY CASE u.papel WHEN 'filial' THEN 0 ELSE 1 END, u.id LIMIT 1) as login
      FROM filiais f
      WHERE f.ativo = 1
    `;
    const params = [];
    if (escopo?.length) {
      sql += ` AND f.id IN (${escopo.map(() => '?').join(',')})`;
      params.push(...escopo);
    }
    sql += ' ORDER BY f.nome';
    const filiais = await db.prepare(sql).all(...params);

    const leve = String(req.query.leve || '') === '1';
    const resultado = [];
    if (leve) {
      for (const f of filiais) {
        resultado.push({
          ...f,
          wuzapi_token: undefined,
          tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
        });
      }
    } else {
      const mapa = await carregarPainelFiliais(db, filiais.map((f) => f.id));
      for (const f of filiais) {
        resultado.push({
          ...f,
          wuzapi_token: undefined,
          tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
          resumo: calcularResumoFilial(mapa.get(Number(f.id))),
        });
      }
    }

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

/** Consolidado de compras nas filiais do escopo */
router.get('/compras/consolidado', async (req, res, next) => {
  try {
    const db = getDb();
    const limites = getLimites();
    const escopo = filiaisEscopoIds(req);
    let sql = `SELECT id, nome, codigo, contrato FROM filiais WHERE ativo = 1`;
    const params = [];
    if (escopo?.length) {
      sql += ` AND id IN (${escopo.map(() => '?').join(',')})`;
      params.push(...escopo);
    }
    sql += ' ORDER BY nome';
    const filiais = await db.prepare(sql).all(...params);
    const mapa = await carregarPainelFiliais(db, filiais.map((f) => f.id), { comPendencias: true });
    const porFilial = filiais.map((f) => {
      const painel = mapa.get(Number(f.id));
      const resumo = calcularResumoFilial(painel);
      const pendencias = calcularPendenciasFilial(painel);
      return {
        filial_id: f.id,
        nome: f.nome,
        codigo: f.codigo,
        contrato: f.contrato,
        compras: resumo.compras,
        troca: pendencias.troca,
        recap: pendencias.recap,
        monitorar: pendencias.monitorar,
      };
    });

    const totalComprar = porFilial.reduce((s, f) => s + f.compras.pneus_para_comprar, 0);
    const totalRecap = porFilial.reduce((s, f) => s + f.compras.pneus_para_recap, 0);
    const totalMonitorar = porFilial.reduce((s, f) => s + f.compras.pneus_monitorar, 0);

    res.json({
      totais: {
        pneus_para_comprar: totalComprar,
        pneus_para_recap: totalRecap,
        pneus_monitorar: totalMonitorar,
      },
      filiais: porFilial.filter((f) =>
        f.compras.pneus_para_comprar > 0
        || f.compras.pneus_para_recap > 0
        || f.compras.pneus_monitorar > 0
      ),
      limites,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/diagnostico-executivo', async (req, res, next) => {
  try {
    const db = getDb();
    const incluirMatriz = String(req.query.incluir_matriz || '') === '1';
    const filialId = req.query.filial_id || null;
    const escopo = filiaisEscopoIds(req);
    if (filialId && !assertFilialNoEscopo(req, filialId)) {
      return res.status(403).json({ erro: 'Filial fora do seu escopo' });
    }
    const diagnostico = await consultarDiagnosticoExecutivo(db, {
      escopo,
      tipo: req.query.tipo || null,
      incluirMatriz,
      filialId,
    });
    res.json(diagnostico);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const f = await db.prepare(`
      SELECT f.*,
        (SELECT login FROM usuarios u WHERE u.filial_id = f.id AND u.papel IN ('filial','gerente') AND u.ativo = 1
         ORDER BY CASE u.papel WHEN 'gerente' THEN 0 ELSE 1 END, u.id LIMIT 1) as login
      FROM filiais f WHERE f.id = ?
    `).get(req.params.id);
    if (!f) return res.status(404).json({ erro: 'Filial não encontrada' });

    const limites = getLimites();
    const tipoFiltro = req.query.tipo;
    const mapa = await carregarPainelFiliais(db, [f.id], { comPendencias: true });
    const painel = mapa.get(Number(f.id));
    const resumo = calcularResumoFilial(painel, tipoFiltro);
    const pendencias = calcularPendenciasFilial(painel, tipoFiltro);

    const veiculos = await db.prepare(`
    SELECT v.*,
      COALESCE(s.total_pneus, 0) as total_pneus,
      s.menor_sulco,
      s.ultima_medicao
    FROM veiculos v
    LEFT JOIN (
      SELECT
        p.veiculo_id,
        COUNT(*) as total_pneus,
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
        MAX(um.data_medicao) as ultima_medicao
      FROM pneus p
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1 AND p.veiculo_id IS NOT NULL
      GROUP BY p.veiculo_id
    ) s ON s.veiculo_id = v.id
    WHERE v.filial_id = ? AND v.ativo = 1
    ORDER BY v.apelido, v.placa
  `).all(f.id);

    const veiculosComStatus = veiculos
      .filter((v) => veiculoCombinaTipo(v.tipo, tipoFiltro))
      .map((v) => ({
        ...v,
        menor_sulco: v.menor_sulco === 999 ? null : v.menor_sulco,
        status_sulco: 'sem_dado',
        unidade_uso: unidadeUsoVeiculo(v.tipo, v.layout_pneus),
        pendencias_troca: pendencias.troca.filter((p) => p.veiculo_id === v.id).length,
        pendencias_recap: pendencias.recap.filter((p) => p.veiculo_id === v.id).length,
        pendencias_monitorar: pendencias.monitorar.filter((p) => p.veiculo_id === v.id).length,
        pneus: [],
      }));

    const pneusRows = await db.prepare(`
      SELECT p.id, p.veiculo_id, p.posicao, p.vida_recap,
        v.tipo, v.layout_pneus, v.km_atual, v.hr_atual,
        um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar,
        um.sulco_mm, um.inspecao_danos
      FROM pneus p
      JOIN veiculos v ON v.id = p.veiculo_id AND v.filial_id = ? AND v.ativo = 1
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1 AND p.status_pneu = 'montado'
    `).all(f.id);
    const pneusPorV = new Map();
    for (const p of pneusRows || []) {
      if (!veiculoCombinaTipo(p.tipo, tipoFiltro)) continue;
      const vid = Number(p.veiculo_id);
      if (!pneusPorV.has(vid)) pneusPorV.set(vid, []);
      const aval = avaliarPneuPainel(p, { limites: limitesDoVeiculo(p) });
      pneusPorV.get(vid).push({
        id: p.id,
        posicao: p.posicao,
        menor_sulco: aval.menor_sulco,
        status_sulco: aval.status_sulco,
        _painel: statusPainel(aval),
      });
    }
    for (const v of veiculosComStatus) {
      const lista = pneusPorV.get(Number(v.id)) || [];
      let pior = null;
      let menor = null;
      for (const item of lista) {
        pior = piorStatus(pior, item._painel);
        if (item.menor_sulco != null) {
          menor = menor == null ? item.menor_sulco : Math.min(menor, item.menor_sulco);
        }
      }
      v.pneus = lista.map(({ _painel, ...rest }) => rest);
      if (lista.length) {
        v.status_sulco = pior || 'sem_dado';
        v.menor_sulco = menor;
      }
    }

    const logsMedicao = await db.prepare(SQL_LOGS_MEDICAO_FILIAL).all(f.id, 40);

    res.json({
      ...f,
      whatsapp: limparTextoFilial(f.whatsapp),
      whatsapp_grupo: limparTextoFilial(f.whatsapp_grupo),
      whatsapp_alerta: limparTextoFilial(f.whatsapp_alerta),
      wuzapi_token: undefined,
      tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
      resumo,
      pendencias,
      compras: resumo.compras,
      veiculos: veiculosComStatus,
      logs_medicao: (logsMedicao || []).map((r) => {
        const menor = r.menor_raw == null || Number(r.menor_raw) >= 999 ? null : Number(r.menor_raw);
        return {
          id: r.id,
          data_medicao: r.data_medicao,
          created_at: r.created_at,
          menor_sulco: menor,
          status_sulco: classificarSulco(menor, limitesDoVeiculo(r)),
          posicao: r.posicao,
          numero_fogo: r.numero_fogo,
          veiculo_id: r.veiculo_id,
          placa: r.placa,
          apelido: r.apelido,
        };
      }),
      limites,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/resumo', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const f = await db.prepare('SELECT * FROM filiais WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ erro: 'Filial não encontrada' });
    res.json({
      filial: f,
      ...(await resumoFilial(db, f.id, getLimites(), req.query.tipo)),
      limites: getLimites(),
    });
  } catch (err) {
    next(err);
  }
});

/** Detalhe do veículo da filial — diagrama + anomalias (visão gerente/admin) */
router.get('/:id/veiculos/:veiculoId', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const filial = await db.prepare('SELECT id, nome, codigo FROM filiais WHERE id = ? AND ativo = 1').get(req.params.id);
    if (!filial) return res.status(404).json({ erro: 'Filial não encontrada' });

    const veiculo = await db.prepare(`
      SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
    `).get(req.params.veiculoId, filial.id);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado nesta filial' });
    const limites = limitesDoVeiculo(veiculo);

    const orderSql = sqlOrderPosicao('p.posicao');
    const pneus = await db.prepare(`
    SELECT p.*,
      um.sulco_externo as ult_sulco_ext,
      um.sulco_central as ult_sulco_cent,
      um.sulco_interno as ult_sulco_int,
      um.sulco_auxiliar as ult_sulco_aux,
      um.sulco_mm as ult_sulco_mm,
      um.inspecao_danos as ult_inspecao_danos,
      um.pressao_psi as ult_pressao_psi,
      um.diagnostico as ult_diagnostico,
      um.acao_sugerida as ult_acao,
      um.data_medicao as ult_medicao,
      um.id as ult_medicao_id
    FROM pneus p
    ${SQL_LATERAL_ULTIMA_MEDICAO}
    WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
    ORDER BY ${orderSql}
  `).all(veiculo.id);

    const basePneus = pneus.map((p) => ({
      ...p,
      _row: {
        sulco_externo: p.ult_sulco_ext,
        sulco_central: p.ult_sulco_cent,
        sulco_interno: p.ult_sulco_int,
        sulco_auxiliar: p.ult_sulco_aux,
        sulco_mm: p.ult_sulco_mm,
        inspecao_danos: p.ult_inspecao_danos,
      },
    }));

    const pneusComStatus = basePneus.map((p) => {
      const candidatos = basePneus
        .filter((c) => c.id !== p.id)
        .map((c) => ({ id: c.id, posicao: c.posicao, ...c._row }));
      const aval = avaliarPneuPainel({
        ...p._row,
        tipo: veiculo.tipo,
        layout_pneus: veiculo.layout_pneus,
        vida_recap: p.vida_recap,
        posicao: p.posicao,
        km_atual: veiculo.km_atual,
        hr_atual: veiculo.hr_atual,
      }, { limites, candidatos });
      const menor = aval.menor_sulco;
      const diag = aval.diagnostico || {};
      const acao = aval.acao || {};
      const sulcoRef = p.sulco_inicial_mm ?? limites.sulco_novo_mm;
      const temAnomalia = Boolean(acao.codigo && acao.codigo !== 'ok')
        || Boolean(diag.codigo && diag.codigo !== 'ok' && diag.codigo !== 'sem_dado');
      const { _row, ...rest } = p;
      return {
        ...rest,
        posicao_label: labelPosicao(p.posicao),
        papel_posicao: papelPosicao(p.posicao),
        padrao: p.tipo_pneu,
        padrao_label: labelTipoPneu(p.tipo_pneu),
        menor_sulco: menor,
        status_sulco: aval.status_sulco,
        diagnostico: diag.codigo,
        diagnostico_label: diag.label,
        diagnostico_desc: diag.descricao || '',
        vida_util_pct: percentualVida(menor, sulcoRef, limites.sulco_critico_mm),
        vida_label: p.vida_recap > 0
          ? `${p.vida_recap}ª recap`
          : (p.condicao === 'novo' ? 'Novo' : 'Recapado'),
        ultima_medicao: p.ult_medicao_id
          ? {
            id: p.ult_medicao_id,
            data: p.ult_medicao || null,
            sulco_externo: p.ult_sulco_ext,
            sulco_central: p.ult_sulco_cent,
            sulco_interno: p.ult_sulco_int,
            sulco_auxiliar: p.ult_sulco_aux,
            sulco_mm: p.ult_sulco_mm,
            pressao_psi: p.ult_pressao_psi ?? null,
            menor_sulco: menor,
          }
          : null,
        acao_sugerida: acao.codigo,
        acao_label: acao.label,
        acao_motivo: acao.motivo,
        desvio_mm: acao.desvio_mm ?? null,
        rodizio_sugestao: acao.rodizio_sugestao || null,
        anomalia: temAnomalia,
        unidade_uso: unidadeUsoVeiculo(veiculo.tipo, veiculo.layout_pneus),
      };
    });

    const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
    const posicoesLayout = layout.posicoes.map((codigo) => ({
      codigo,
      label: labelPosicao(codigo),
      papel: papelPosicao(codigo),
      montado: pneusComStatus.some((p) => p.posicao === codigo),
    }));

    const anomalias = pneusComStatus
      .filter((p) => p.anomalia)
      .sort((a, b) => {
        const ordem = { troca: 0, recap: 1, monitorar: 2, ok: 9 };
        return (ordem[a.acao_sugerida] ?? 5) - (ordem[b.acao_sugerida] ?? 5)
          || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99);
      });

    res.json({
      filial,
      ...veiculo,
      pneus: pneusComStatus,
      anomalias,
      posicoes_layout: posicoesLayout,
      layout: {
        id: veiculo.layout_pneus || LAYOUT_PADRAO,
        nome: layout.nome,
        posicoes: layout.posicoes,
      },
      medicao_perfil: especificacaoMedicao(veiculo.tipo, veiculo.layout_pneus),
      posicoes_labels: POSICOES_PNEU,
      limites,
    });
  } catch (err) {
    next(err);
  }
});

/** Admin/gerente: corrige dados do veículo da filial */
router.put('/:id/veiculos/:veiculoId', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  const { placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus } = req.body || {};
  try {
    const db = getDb();
    const veiculo = await db.prepare(`
      SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
    `).get(req.params.veiculoId, req.params.id);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado nesta filial' });

    if (placa != null && !String(placa).trim()) {
      return res.status(400).json({ erro: 'Placa não pode ficar vazia' });
    }

    const tipoCampos = tipo != null
      ? camposTipoVeiculo(normalizarTipoVeiculo(String(tipo).trim()) || String(tipo).trim())
      : null;

    await db.prepare(`
      UPDATE veiculos SET
        placa = ?,
        apelido = ?,
        tipo = ?,
        tipo_codigo = COALESCE(?, tipo_codigo),
        marca = ?,
        modelo = ?,
        ano = ?,
        km_atual = ?,
        hr_atual = ?,
        observacoes = ?,
        dia_medicao = ?,
        layout_pneus = ?,
        updated_at = NOW()
      WHERE id = ? AND filial_id = ? AND ativo = 1
    `).run(
      placa != null ? String(placa).trim().toUpperCase() : veiculo.placa,
      apelido !== undefined ? (String(apelido).trim() || null) : veiculo.apelido,
      tipoCampos ? tipoCampos.tipo : veiculo.tipo,
      tipoCampos ? tipoCampos.tipo_codigo : null,
      marca !== undefined ? (String(marca).trim() || null) : veiculo.marca,
      modelo !== undefined ? (String(modelo).trim() || null) : veiculo.modelo,
      ano !== undefined && ano !== '' ? parseInt(ano, 10) : veiculo.ano,
      km_atual != null && km_atual !== '' ? parseInt(km_atual, 10) : (veiculo.km_atual || 0),
      hr_atual != null && hr_atual !== '' ? parseFloat(hr_atual) : (veiculo.hr_atual || 0),
      observacoes !== undefined ? (String(observacoes).trim() || null) : veiculo.observacoes,
      Object.prototype.hasOwnProperty.call(req.body || {}, 'dia_medicao')
        ? normalizarDiaMedicao(req.body.dia_medicao)
        : veiculo.dia_medicao,
      layoutNaEdicao(veiculo.layout_pneus, layout_pneus),
      veiculo.id,
      req.params.id
    );

    const atualizado = await db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculo.id);
    res.json({ mensagem: 'Veículo atualizado', veiculo: atualizado });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Já existe um veículo com esta placa' });
    }
    next(err);
  }
});

/** Admin: exclui o caminhão. Pneus montados voltam ao estoque. */
router.delete('/:id/veiculos/:veiculoId', async (req, res, next) => {
  if (req.user?.papel !== 'admin') {
    return res.status(403).json({ erro: 'Só o administrador pode excluir veículo' });
  }
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const result = await excluirVeiculoCompleto(db, req.params.id, req.params.veiculoId);
    const n = result.pneus_desvinculados || 0;
    res.json({
      mensagem: n
        ? `Caminhão ${result.placa} excluído. ${n} pneu(s) foram desvinculados (os que estavam montados voltaram ao estoque).`
        : `Caminhão ${result.placa} excluído`,
      ...result,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Admin: pneus em estoque ou descarte desta unidade, para exclusão. */
router.get('/:id/pneus-livres', async (req, res, next) => {
  if (req.user?.papel !== 'admin') {
    return res.status(403).json({ erro: 'Só o administrador pode excluir pneu' });
  }
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  const status = String(req.query.status || 'todos').toLowerCase();
  if (!['todos', 'estoque', 'descarte'].includes(status)) {
    return res.status(400).json({ erro: 'Status inválido' });
  }
  try {
    const db = getDb();
    const filtroStatus = status === 'todos'
      ? `AND p.status_pneu IN ('estoque', 'descarte')`
      : 'AND p.status_pneu = ?';
    const params = status === 'todos' ? [req.params.id] : [req.params.id, status];
    const rows = await db.prepare(`
      SELECT
        p.id, p.numero_fogo, p.marca, p.modelo, p.medida, p.dot,
        p.tipo_pneu, p.condicao, p.vida_recap, p.status_pneu,
        p.sulco_inicial_mm, p.tratamento_descarte
      FROM pneus p
      WHERE p.filial_id = ?
        AND p.veiculo_id IS NULL
        ${filtroStatus}
      ORDER BY p.status_pneu, p.numero_fogo, p.id
    `).all(...params);
    res.json(rows.map((p) => ({
      ...p,
      padrao_label: labelTipoPneu(p.tipo_pneu),
      tratamento_descarte_label: p.status_pneu === 'descarte'
        ? labelTratamentoDescarte(p.tratamento_descarte)
        : null,
    })));
  } catch (err) {
    next(err);
  }
});

/** Admin: exclui pneu somente em estoque ou descarte. */
router.delete('/:id/pneus/:pneuId', async (req, res, next) => {
  if (req.user?.papel !== 'admin') {
    return res.status(403).json({ erro: 'Só o administrador pode excluir pneu' });
  }
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const result = await excluirPneuEstoqueOuDescarte(db, req.params.id, req.params.pneuId);
    const fogo = result.numero_fogo ? ` fogo ${result.numero_fogo}` : '';
    res.json({
      mensagem: `Pneu${fogo} excluído do ${result.status_pneu}`,
      ...result,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/** Admin/gerente: corrige uma medição de sulco da filial */
router.put('/:id/medicoes/:medicaoId', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const med = await db.prepare(`
      SELECT m.*, p.id as pneu_id, p.vida_recap, p.veiculo_id, p.posicao, v.filial_id,
        v.tipo as veiculo_tipo, v.layout_pneus
      FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      JOIN veiculos v ON v.id = p.veiculo_id AND v.filial_id = ?
      WHERE m.id = ?
    `).get(req.params.id, req.params.medicaoId);
    if (!med) return res.status(404).json({ erro: 'Medição não encontrada nesta filial' });

    const body = req.body || {};
    const entrada = {
      ...med,
      ...body,
      sulco_mm: Object.prototype.hasOwnProperty.call(body, 'sulco_mm') ? body.sulco_mm : med.sulco_mm,
      inspecao_danos: Object.prototype.hasOwnProperty.call(body, 'inspecao_danos') ? body.inspecao_danos : med.inspecao_danos,
    };

    let candidatos = [];
    if (med.veiculo_id) {
      const rows = await db.prepare(`
        SELECT p.*,
          (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
          (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
          (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
          (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux
        FROM pneus p
        WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado' AND p.id != ?
      `).all(med.veiculo_id, med.pneu_id);
      candidatos = rows.map((c) => ({
        ...c,
        sulco_externo: c.ult_sulco_ext,
        sulco_central: c.ult_sulco_cent,
        sulco_interno: c.ult_sulco_int,
        sulco_auxiliar: c.ult_sulco_aux,
      }));
    }

    const anterior = await db.prepare(`
      SELECT * FROM medicoes WHERE pneu_id = ? AND id != ?
      ORDER BY data_medicao DESC, id DESC LIMIT 1
    `).get(med.pneu_id, med.id);

    const prep = prepararMedicao(entrada, {
      tipo: med.veiculo_tipo,
      layout: med.layout_pneus,
      anterior,
      vidaRecap: med.vida_recap || 0,
      candidatos,
      posicao: med.posicao || null,
      papel: med.posicao ? papelPosicao(med.posicao) : null,
    });
    if (prep.erro) return res.status(400).json({ erro: prep.erro });

    const dataMed = Object.prototype.hasOwnProperty.call(body, 'data_medicao')
      ? (body.data_medicao || null)
      : med.data_medicao;
    const obs = Object.prototype.hasOwnProperty.call(body, 'observacoes')
      ? (String(body.observacoes || '').trim() || null)
      : med.observacoes;

    await db.prepare(`
      UPDATE medicoes SET
        data_medicao = COALESCE(?, data_medicao),
        km_veiculo = ?,
        hr_veiculo = ?,
        sulco_externo = ?,
        sulco_central = ?,
        sulco_interno = ?,
        sulco_auxiliar = ?,
        sulco_mm = ?,
        inspecao_danos = ?,
        pressao_psi = ?,
        observacoes = ?,
        diagnostico = ?,
        acao_sugerida = ?,
        desgaste_mm_km = ?,
        desgaste_mm_hora = ?
      WHERE id = ?
    `).run(
      dataMed,
      prep.km_veiculo,
      prep.hr_veiculo,
      prep.sulco_externo,
      prep.sulco_central,
      prep.sulco_interno,
      prep.sulco_auxiliar,
      prep.sulco_mm,
      prep.inspecao_danos ? JSON.stringify(prep.inspecao_danos) : null,
      prep.pressao_psi,
      obs,
      prep.diagnostico.codigo,
      prep.acao.codigo,
      prep.desgaste_mm_km,
      prep.desgaste_mm_hora,
      med.id
    );

    const atualizada = await db.prepare('SELECT * FROM medicoes WHERE id = ?').get(med.id);
    res.json({
      mensagem: 'Medição corrigida',
      medicao: {
        ...atualizada,
        perfil_medicao: prep.spec.codigo,
        unidade: prep.spec.unidade,
        menor_sulco: prep.menor_sulco,
        status_sulco: prep.status_sulco,
        diagnostico_label: prep.diagnostico.label,
        acao_label: prep.acao.label,
        acao_motivo: prep.acao.motivo,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Admin/gerente: remove medição incorreta */
router.delete('/:id/medicoes/:medicaoId', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const med = await db.prepare(`
      SELECT m.id FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      JOIN veiculos v ON v.id = p.veiculo_id AND v.filial_id = ?
      WHERE m.id = ?
    `).get(req.params.id, req.params.medicaoId);
    if (!med) return res.status(404).json({ erro: 'Medição não encontrada nesta filial' });

    await db.prepare('DELETE FROM medicoes WHERE id = ?').run(med.id);
    res.json({ mensagem: 'Medição removida' });
  } catch (err) {
    next(err);
  }
});

function limparTextoFilial(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
}

function gruposFilialIguais(a, b) {
  const da = limparTextoFilial(a);
  const db = limparTextoFilial(b);
  if (!da && !db) return true;
  if (!da || !db) return false;
  if (da === db) return true;
  return da.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '')
    === db.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
}

async function grupoWhatsappUsadoPorOutra(db, filialId, grupo) {
  const g = limparTextoFilial(grupo);
  if (!g) return null;
  const rows = await db.prepare(`
    SELECT id, nome, whatsapp_grupo FROM filiais
    WHERE ativo = 1
      AND whatsapp_grupo IS NOT NULL AND TRIM(whatsapp_grupo) != ''
      AND (? IS NULL OR id != ?)
  `).all(filialId || null, filialId || 0);
  return (rows || []).find((r) => gruposFilialIguais(r.whatsapp_grupo, g)) || null;
}

router.post('/', requireAdmin, async (req, res, next) => {
  const { nome, codigo, contrato, login, senha, whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token } = req.body || {};
  if (!nome?.trim() || !codigo?.trim()) {
    return res.status(400).json({ erro: 'Nome e código da filial são obrigatórios' });
  }
  if (!login?.trim() || !senha || senha.length < 4) {
    return res.status(400).json({ erro: 'Login e senha da filial são obrigatórios (mín. 4 caracteres)' });
  }

  const db = getDb();
  const loginNorm = login.trim().toLowerCase();
  const senhaHash = hashSenha(senha);

  try {
    const grupoNovo = limparTextoFilial(whatsapp_grupo);
    if (grupoNovo) {
      const ocupado = await grupoWhatsappUsadoPorOutra(db, null, grupoNovo);
      if (ocupado) {
        return res.status(409).json({
          erro: `Esse grupo já está na unidade ${ocupado.nome}. Cada filial precisa do próprio grupo.`,
        });
      }
    }
    const criado = await db.transaction(async () => {
      const filialIns = await db.prepare(`
        INSERT INTO filiais (nome, codigo, contrato, whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        RETURNING id
      `).run(
        nome.trim(),
        codigo.trim().toUpperCase(),
        contrato?.trim() || null,
        limparTextoFilial(whatsapp)?.replace(/\D/g, '') || null,
        limparTextoFilial(whatsapp_grupo),
        limparTextoFilial(whatsapp_alerta)?.replace(/\D/g, '') || null
      );

      const filialId = Number(filialIns.lastInsertRowid || filialIns.rows?.[0]?.id);
      if (!filialId) {
        throw new Error('Falha ao obter id da filial criada');
      }

      const userIns = await db.prepare(`
        INSERT INTO usuarios (login, senha_hash, papel, cargo, filial_id, ativo)
        VALUES (?, ?, 'filial', 'funcionario', ?, 1)
        RETURNING id, login, filial_id
      `).run(loginNorm, senhaHash, filialId);

      const usuarioId = Number(userIns.lastInsertRowid || userIns.rows?.[0]?.id);
      if (!usuarioId) {
        throw new Error('Falha ao criar usuário da filial');
      }

      // Confirma persistência dentro da mesma transação
      const confere = await db.prepare(`
        SELECT id, login, senha_hash, filial_id, ativo
        FROM usuarios
        WHERE id = ? AND lower(login) = lower(?) AND filial_id = ? AND ativo = 1
      `).get(usuarioId, loginNorm, filialId);

      if (!confere?.senha_hash) {
        throw new Error('Usuário da filial não persistiu (senha/login)');
      }

      return { filialId, usuarioId, login: confere.login };
    });

    // Lê de fora da tx (após COMMIT) — garante que Neon/PG gravou de verdade
    const salvo = await db.prepare(`
      SELECT u.id, u.login, u.filial_id, u.ativo, f.nome as filial_nome, f.codigo as filial_codigo
      FROM usuarios u
      JOIN filiais f ON f.id = u.filial_id
      WHERE u.id = ?
    `).get(criado.usuarioId);

    if (!salvo) {
      return res.status(500).json({
        erro: 'Filial criada mas usuário não encontrado após commit — verifique DATABASE_URL (Neon)',
      });
    }

    res.status(201).json({
      id: criado.filialId,
      login: salvo.login,
      usuario_id: salvo.id,
      tem_wuzapi_token: false,
      mensagem: `Filial "${nome.trim()}" criada com login ${salvo.login}. No WhatsApp, escolha o grupo desta unidade (o chip é único para todas).`,
    });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Código de filial ou login já existe' });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }

  const { nome, codigo, contrato, ativo, whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token } = req.body || {};
  const db = getDb();

  try {
    const atual = await db.prepare('SELECT * FROM filiais WHERE id = ?').get(req.params.id);
    if (!atual) return res.status(404).json({ erro: 'Filial não encontrada' });

    if (whatsapp_grupo !== undefined) {
      const atualG = limparTextoFilial(atual.whatsapp_grupo);
      const novoG = limparTextoFilial(whatsapp_grupo);
      if (atualG && !gruposFilialIguais(atualG, novoG) && req.body?.trocar_grupo !== true) {
        return res.status(409).json({
          erro: 'Grupo da medição está travado. Clique em “Escolher outro grupo” no painel do chatbot.',
        });
      }
    }

    const admin = isAdmin(req.user);

    const waNum = whatsapp !== undefined
      ? (limparTextoFilial(whatsapp)?.replace(/\D/g, '') || null)
      : atual.whatsapp;
    const waGrupo = whatsapp_grupo !== undefined
      ? limparTextoFilial(whatsapp_grupo)
      : atual.whatsapp_grupo;
    if (whatsapp_grupo !== undefined && waGrupo) {
      const ocupado = await grupoWhatsappUsadoPorOutra(db, Number(req.params.id), waGrupo);
      if (ocupado) {
        return res.status(409).json({
          erro: `Esse grupo já está na unidade ${ocupado.nome}. Cada filial precisa do próprio grupo.`,
        });
      }
    }
    const waAlerta = whatsapp_alerta !== undefined
      ? (limparTextoFilial(whatsapp_alerta)?.replace(/\D/g, '') || null)
      : atual.whatsapp_alerta;

    if (admin) {
      await db.prepare(`
        UPDATE filiais SET
          nome = COALESCE(?, nome),
          codigo = COALESCE(?, codigo),
          contrato = ?,
          ativo = COALESCE(?, ativo),
          whatsapp = ?,
          whatsapp_grupo = ?,
          whatsapp_alerta = ?,
          wuzapi_token = NULL,
          updated_at = NOW()
        WHERE id = ?
      `).run(
        nome?.trim() || null,
        codigo?.trim()?.toUpperCase() || null,
        contrato !== undefined ? (contrato?.trim() || null) : atual.contrato,
        ativo != null ? (ativo ? 1 : 0) : null,
        waNum,
        waGrupo,
        waAlerta,
        req.params.id
      );
    } else {
      await db.prepare(`
        UPDATE filiais SET
          contrato = ?,
          whatsapp_alerta = ?,
          updated_at = NOW()
        WHERE id = ?
      `).run(
        contrato !== undefined ? (contrato?.trim() || null) : atual.contrato,
        waAlerta,
        req.params.id
      );
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dia_medicao')) {
      await db.prepare(`
        UPDATE filiais SET dia_medicao = ?, updated_at = NOW() WHERE id = ?
      `).run(normalizarDiaMedicao(req.body.dia_medicao), req.params.id);
    }
    res.json({ mensagem: 'Filial atualizada' });
  } catch (err) {
    if (ehViolacaoUnique(err)) {
      return res.status(409).json({ erro: 'Código de filial já existe' });
    }
    next(err);
  }
});

router.post('/:id/reset-senha', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  const { senha, login } = req.body || {};
  if (!senha || senha.length < 4) {
    return res.status(400).json({ erro: 'Informe a nova senha (mín. 4 caracteres)' });
  }

  try {
    const db = getDb();
    const filial = await db.prepare('SELECT * FROM filiais WHERE id = ?').get(req.params.id);
    if (!filial) return res.status(404).json({ erro: 'Filial não encontrada' });

    const user = await db.prepare(`
      SELECT * FROM usuarios WHERE filial_id = ? AND papel = 'filial' ORDER BY id LIMIT 1
    `).get(req.params.id);

    if (!user) {
      if (!login?.trim()) {
        return res.status(400).json({ erro: 'Filial sem usuário — informe um login para criar' });
      }
      await db.prepare(`
        INSERT INTO usuarios (login, senha_hash, papel, filial_id, ativo)
        VALUES (?, ?, 'filial', ?, 1)
      `).run(login.trim().toLowerCase(), hashSenha(senha), req.params.id);
      return res.json({ mensagem: `Usuário ${login.trim().toLowerCase()} criado com a nova senha` });
    }

    await db.transaction(async () => {
      await db.prepare(`
        UPDATE usuarios SET
          senha_hash = ?,
          login = COALESCE(?, login),
          updated_at = NOW()
        WHERE id = ?
      `).run(
        hashSenha(senha),
        login?.trim()?.toLowerCase() || null,
        user.id
      );
      await revogarSessoesDoUsuario(user.id);
    });

    res.json({ mensagem: 'Senha da filial atualizada' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  const senhaAdmin = String(req.body?.senha_admin || '');
  if (!senhaAdmin) {
    return res.status(400).json({
      erro: 'Informe a senha de administrador para confirmar a exclusão',
    });
  }

  try {
    const db = getDb();
    const admin = await db.prepare(`
      SELECT id, senha_hash FROM usuarios
      WHERE id = ? AND papel IN ('admin', 'presidente') AND ativo = 1
    `).get(req.user.id);
    if (!admin || !verificarSenha(senhaAdmin, admin.senha_hash)) {
      return res.status(403).json({ erro: 'Senha de administrador incorreta' });
    }

    const resultado = await excluirFilialCompleta(db, req.params.id);
    res.json({
      mensagem: `Unidade ${resultado.filial.nome} excluída. Veículos, pneus, medições e logins dessa unidade foram apagados.`,
      removidos: resultado.removidos,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

export default router;
