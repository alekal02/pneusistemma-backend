import { Router } from 'express';
import { getDb } from '../database.js';
import { ehViolacaoUnique } from '../db-utils.js';
import {
  requireAuth,
  requireAdmin,
  requireGerenteOuAdmin,
  hashSenha,
  filiaisEscopoIds,
  isAdmin,
} from '../auth.js';
import { classificarSulco, getLimites, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao, percentualVida } from '../diagnostico.js';
import {
  labelPosicao,
  papelPosicao,
  sqlOrderPosicao,
  getLayout,
  LAYOUT_PADRAO,
  POSICOES_PNEU,
  labelTipoPneu,
} from '../pneus-layouts.js';
import { normalizarDiaMedicao } from '../dia-medicao.js';

const router = Router();

router.use(requireAuth);
router.use(requireGerenteOuAdmin);

function assertFilialNoEscopo(req, filialId) {
  const escopo = filiaisEscopoIds(req);
  if (escopo === null) return true;
  return escopo.includes(Number(filialId));
}

async function resumoFilial(db, filialId, limites) {
  const veiculos = Number((await db.prepare(`
    SELECT COUNT(*) as total FROM veiculos WHERE filial_id = ? AND ativo = 1
  `).get(filialId)).total);

  const pneus = await db.prepare(`
    SELECT
      p.id, p.vida_recap,
      (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_externo,
      (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_central,
      (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_interno,
      (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_auxiliar,
      (SELECT data_medicao FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as data_medicao
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
    WHERE p.ativo = 1 AND p.status_pneu = 'montado'
  `).all(filialId);

  let ok = 0, alerta = 0, critico = 0, semDado = 0;
  let troca = 0, recap = 0, monitorar = 0;
  let ultimaMedicao = null;

  for (const p of pneus) {
    const menor = menorSulco(p);
    const status = classificarSulco(menor);
    if (status === 'ok') ok++;
    else if (status === 'alerta') alerta++;
    else if (status === 'critico') critico++;
    else semDado++;

    const acao = sugerirAcao(menor, limites, p.vida_recap || 0);
    if (acao.codigo === 'troca') troca++;
    else if (acao.codigo === 'recap') recap++;
    else if (acao.codigo === 'monitorar') monitorar++;

    if (p.data_medicao && (!ultimaMedicao || p.data_medicao > ultimaMedicao)) {
      ultimaMedicao = p.data_medicao;
    }
  }

  let diasSemMedicao = null;
  if (ultimaMedicao) {
    const diff = Date.now() - new Date(`${ultimaMedicao}T12:00:00`).getTime();
    diasSemMedicao = Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  return {
    veiculos_ativos: veiculos,
    pneus_total: pneus.length,
    pneus_ok: ok,
    pneus_alerta: alerta,
    pneus_critico: critico,
    pneus_sem_dado: semDado,
    acoes: { troca, recap, monitorar },
    compras: {
      pneus_para_comprar: troca,
      pneus_para_recap: recap,
      pneus_monitorar: monitorar,
    },
    ultima_medicao: ultimaMedicao,
    dias_sem_medicao: diasSemMedicao,
    precisa_medir_semana: diasSemMedicao == null ? veiculos > 0 : diasSemMedicao >= 7,
  };
}

/** Lista pneus com ação pendente (troca/recap/monitorar) — base para compras */
async function pendenciasFilial(db, filialId, limites) {
  const rows = await db.prepare(`
    SELECT
      p.id as pneu_id, p.posicao, p.numero_fogo, p.marca as pneu_marca,
      p.tipo_pneu, p.condicao, p.vida_recap, p.sulco_inicial_mm,
      v.id as veiculo_id, v.placa, v.apelido, v.tipo as veiculo_tipo, v.km_atual,
      m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar,
      m.data_medicao, m.diagnostico, m.km_veiculo
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
    LEFT JOIN medicoes m ON m.pneu_id = p.id
      AND m.id = (SELECT id FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1)
    WHERE p.ativo = 1 AND p.status_pneu = 'montado'
  `).all(filialId);

  const itens = rows.map((p) => {
    const menor = menorSulco(p);
    const status = classificarSulco(menor);
    const diag = diagnosticarPerfil(p, limites.diagnostico_tolerancia_mm, {
      limites,
    });
    const acao = sugerirAcao(menor, limites, p.vida_recap || 0);
    return {
      pneu_id: p.pneu_id,
      veiculo_id: p.veiculo_id,
      placa: p.placa,
      apelido: p.apelido,
      veiculo_tipo: p.veiculo_tipo,
      km_atual: p.km_atual,
      posicao: p.posicao,
      posicao_label: labelPosicao(p.posicao),
      numero_fogo: p.numero_fogo,
      pneu_marca: p.pneu_marca,
      tipo_pneu: p.tipo_pneu,
      condicao: p.condicao,
      vida_recap: p.vida_recap,
      menor_sulco: menor,
      status_sulco: status,
      sulcos: {
        m1: p.sulco_externo,
        m2: p.sulco_central,
        m3: p.sulco_interno,
        m4: p.sulco_auxiliar,
      },
      data_medicao: p.data_medicao,
      diagnostico: diag.codigo,
      diagnostico_label: diag.label,
      acao_sugerida: acao.codigo,
      acao_label: acao.label,
      acao_motivo: acao.motivo,
    };
  });

  const pendentes = itens
    .filter((i) => i.acao_sugerida !== 'ok')
    .sort((a, b) => {
      const ordem = { troca: 0, recap: 1, monitorar: 2 };
      return (ordem[a.acao_sugerida] ?? 9) - (ordem[b.acao_sugerida] ?? 9)
        || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99);
    });

  return {
    troca: pendentes.filter((i) => i.acao_sugerida === 'troca'),
    recap: pendentes.filter((i) => i.acao_sugerida === 'recap'),
    monitorar: pendentes.filter((i) => i.acao_sugerida === 'monitorar'),
    todos: pendentes,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const limites = getLimites();
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

    const resultado = [];
    for (const f of filiais) {
      resultado.push({
        ...f,
        wuzapi_token: undefined,
        tem_wuzapi_token: Boolean(f.wuzapi_token?.trim()),
        resumo: await resumoFilial(db, f.id, limites),
      });
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

    const porFilial = [];
    for (const f of filiais) {
      const resumo = await resumoFilial(db, f.id, limites);
      const pendencias = await pendenciasFilial(db, f.id, limites);
      porFilial.push({
        filial_id: f.id,
        nome: f.nome,
        codigo: f.codigo,
        contrato: f.contrato,
        compras: resumo.compras,
        troca: pendencias.troca,
        recap: pendencias.recap,
        monitorar: pendencias.monitorar,
      });
    }

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
    const resumo = await resumoFilial(db, f.id, limites);
    const pendencias = await pendenciasFilial(db, f.id, limites);

    const veiculos = await db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM pneus p WHERE p.veiculo_id = v.id AND p.ativo = 1) as total_pneus,
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
      ) as menor_sulco,
      (SELECT MAX(m.data_medicao)
       FROM pneus p
       JOIN medicoes m ON m.pneu_id = p.id
       WHERE p.veiculo_id = v.id AND p.ativo = 1) as ultima_medicao
    FROM veiculos v
    WHERE v.filial_id = ? AND v.ativo = 1
    ORDER BY v.apelido, v.placa
  `).all(f.id);

    const veiculosComStatus = veiculos.map((v) => ({
      ...v,
      menor_sulco: v.menor_sulco === 999 ? null : v.menor_sulco,
      status_sulco: classificarSulco(v.menor_sulco === 999 ? null : v.menor_sulco),
      pendencias_troca: pendencias.troca.filter((p) => p.veiculo_id === v.id).length,
      pendencias_recap: pendencias.recap.filter((p) => p.veiculo_id === v.id).length,
      pendencias_monitorar: pendencias.monitorar.filter((p) => p.veiculo_id === v.id).length,
    }));

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
      ...(await resumoFilial(db, f.id, getLimites())),
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
    const limites = getLimites();
    const filial = await db.prepare('SELECT id, nome, codigo FROM filiais WHERE id = ? AND ativo = 1').get(req.params.id);
    if (!filial) return res.status(404).json({ erro: 'Filial não encontrada' });

    const veiculo = await db.prepare(`
      SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
    `).get(req.params.veiculoId, filial.id);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado nesta filial' });

    const orderSql = sqlOrderPosicao('p.posicao');
    const pneus = await db.prepare(`
    SELECT p.*,
      (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_ext,
      (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_cent,
      (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_int,
      (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_sulco_aux,
      (SELECT diagnostico FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_diagnostico,
      (SELECT acao_sugerida FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_acao,
      (SELECT data_medicao FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_medicao,
      (SELECT id FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_medicao_id
    FROM pneus p
    WHERE p.veiculo_id = ? AND p.ativo = 1 AND p.status_pneu = 'montado'
    ORDER BY ${orderSql}
  `).all(veiculo.id);

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
        limites,
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
        status_sulco: classificarSulco(menor),
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
      const temAnomalia = acao.codigo !== 'ok' || (p.diagnostico !== 'ok' && p.diagnostico !== 'sem_dado');
      const { _row, ...rest } = p;
      return {
        ...rest,
        acao_sugerida: acao.codigo,
        acao_label: acao.label,
        acao_motivo: acao.motivo,
        desvio_mm: acao.desvio_mm ?? null,
        rodizio_sugestao: acao.rodizio_sugestao || null,
        anomalia: temAnomalia,
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
  const { placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes } = req.body || {};
  try {
    const db = getDb();
    const veiculo = await db.prepare(`
      SELECT * FROM veiculos WHERE id = ? AND filial_id = ? AND ativo = 1
    `).get(req.params.veiculoId, req.params.id);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado nesta filial' });

    if (placa != null && !String(placa).trim()) {
      return res.status(400).json({ erro: 'Placa não pode ficar vazia' });
    }

    await db.prepare(`
      UPDATE veiculos SET
        placa = ?,
        apelido = ?,
        tipo = ?,
        marca = ?,
        modelo = ?,
        ano = ?,
        km_atual = ?,
        hr_atual = ?,
        observacoes = ?,
        dia_medicao = ?,
        updated_at = NOW()
      WHERE id = ? AND filial_id = ? AND ativo = 1
    `).run(
      placa != null ? String(placa).trim().toUpperCase() : veiculo.placa,
      apelido !== undefined ? (String(apelido).trim() || null) : veiculo.apelido,
      tipo != null ? String(tipo).trim() : veiculo.tipo,
      marca !== undefined ? (String(marca).trim() || null) : veiculo.marca,
      modelo !== undefined ? (String(modelo).trim() || null) : veiculo.modelo,
      ano !== undefined && ano !== '' ? parseInt(ano, 10) : veiculo.ano,
      km_atual != null && km_atual !== '' ? parseInt(km_atual, 10) : (veiculo.km_atual || 0),
      hr_atual != null && hr_atual !== '' ? parseFloat(hr_atual) : (veiculo.hr_atual || 0),
      observacoes !== undefined ? (String(observacoes).trim() || null) : veiculo.observacoes,
      Object.prototype.hasOwnProperty.call(req.body || {}, 'dia_medicao')
        ? normalizarDiaMedicao(req.body.dia_medicao)
        : veiculo.dia_medicao,
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

/** Admin/gerente: corrige uma medição de sulco da filial */
router.put('/:id/medicoes/:medicaoId', async (req, res, next) => {
  if (!assertFilialNoEscopo(req, req.params.id)) {
    return res.status(403).json({ erro: 'Filial fora do seu escopo' });
  }
  try {
    const db = getDb();
    const limites = getLimites();
    const med = await db.prepare(`
      SELECT m.*, p.id as pneu_id, p.vida_recap, p.veiculo_id, p.posicao, v.filial_id
      FROM medicoes m
      JOIN pneus p ON p.id = m.pneu_id
      JOIN veiculos v ON v.id = p.veiculo_id AND v.filial_id = ?
      WHERE m.id = ?
    `).get(req.params.id, req.params.medicaoId);
    if (!med) return res.status(404).json({ erro: 'Medição não encontrada nesta filial' });

    const {
      data_medicao,
      km_veiculo,
      hr_veiculo,
      sulco_externo,
      sulco_central,
      sulco_interno,
      sulco_auxiliar,
      pressao_psi,
      observacoes,
    } = req.body || {};

    const row = {
      sulco_externo: sulco_externo !== undefined ? (sulco_externo === '' || sulco_externo == null ? null : parseFloat(sulco_externo)) : med.sulco_externo,
      sulco_central: sulco_central !== undefined ? (sulco_central === '' || sulco_central == null ? null : parseFloat(sulco_central)) : med.sulco_central,
      sulco_interno: sulco_interno !== undefined ? (sulco_interno === '' || sulco_interno == null ? null : parseFloat(sulco_interno)) : med.sulco_interno,
      sulco_auxiliar: sulco_auxiliar !== undefined ? (sulco_auxiliar === '' || sulco_auxiliar == null ? null : parseFloat(sulco_auxiliar)) : med.sulco_auxiliar,
    };
    const menor = menorSulco(row);
    if (menor == null) {
      return res.status(400).json({ erro: 'Informe ao menos um valor de sulco' });
    }

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

    const diag = diagnosticarPerfil(row, limites.diagnostico_tolerancia_mm, {
      papel: med.posicao ? papelPosicao(med.posicao) : null,
      posicao: med.posicao || null,
      limites,
    });
    const acao = sugerirAcao(menor, limites, med.vida_recap || 0, {
      pontos: row,
      candidatos,
      posicaoAtual: med.posicao || null,
    });

    await db.prepare(`
      UPDATE medicoes SET
        data_medicao = COALESCE(?, data_medicao),
        km_veiculo = COALESCE(?, km_veiculo),
        hr_veiculo = COALESCE(?, hr_veiculo),
        sulco_externo = ?,
        sulco_central = ?,
        sulco_interno = ?,
        sulco_auxiliar = ?,
        pressao_psi = COALESCE(?, pressao_psi),
        observacoes = COALESCE(?, observacoes),
        diagnostico = ?,
        acao_sugerida = ?
      WHERE id = ?
    `).run(
      data_medicao || null,
      km_veiculo != null && km_veiculo !== '' ? parseInt(km_veiculo, 10) : null,
      hr_veiculo != null && hr_veiculo !== '' ? parseFloat(hr_veiculo) : null,
      row.sulco_externo,
      row.sulco_central,
      row.sulco_interno,
      row.sulco_auxiliar,
      pressao_psi != null && pressao_psi !== '' ? parseFloat(pressao_psi) : null,
      observacoes !== undefined ? (String(observacoes).trim() || null) : med.observacoes,
      diag.codigo,
      acao.codigo,
      med.id
    );

    const atualizada = await db.prepare('SELECT * FROM medicoes WHERE id = ?').get(med.id);
    res.json({
      mensagem: 'Medição corrigida',
      medicao: {
        ...atualizada,
        menor_sulco: menor,
        status_sulco: classificarSulco(menor),
        diagnostico_label: diag.label,
        acao_label: acao.label,
        acao_motivo: acao.motivo,
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
    const criado = await db.transaction(async () => {
      const filialIns = await db.prepare(`
        INSERT INTO filiais (nome, codigo, contrato, whatsapp, whatsapp_grupo, whatsapp_alerta, wuzapi_token)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).run(
        nome.trim(),
        codigo.trim().toUpperCase(),
        contrato?.trim() || null,
        limparTextoFilial(whatsapp)?.replace(/\D/g, '') || null,
        limparTextoFilial(whatsapp_grupo),
        limparTextoFilial(whatsapp_alerta)?.replace(/\D/g, '') || null,
        limparTextoFilial(wuzapi_token)
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
      mensagem: `Filial "${nome.trim()}" criada com login ${salvo.login}`,
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

    const admin = isAdmin(req.user);

    const waNum = whatsapp !== undefined
      ? (limparTextoFilial(whatsapp)?.replace(/\D/g, '') || null)
      : atual.whatsapp;
    const waGrupo = whatsapp_grupo !== undefined
      ? limparTextoFilial(whatsapp_grupo)
      : atual.whatsapp_grupo;
    const waAlerta = whatsapp_alerta !== undefined
      ? (limparTextoFilial(whatsapp_alerta)?.replace(/\D/g, '') || null)
      : atual.whatsapp_alerta;
    // Token: string vazia limpa; undefined mantém; só admin altera
    let waToken = atual.wuzapi_token;
    if (admin && wuzapi_token !== undefined) {
      waToken = limparTextoFilial(wuzapi_token);
    }

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
          wuzapi_token = ?,
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
        waToken,
        req.params.id
      );
    } else {
      const tokenNaoAdmin = wuzapi_token !== undefined
        ? limparTextoFilial(wuzapi_token)
        : atual.wuzapi_token;
      await db.prepare(`
        UPDATE filiais SET
          contrato = ?,
          whatsapp = ?,
          whatsapp_grupo = ?,
          whatsapp_alerta = ?,
          wuzapi_token = ?,
          updated_at = NOW()
        WHERE id = ?
      `).run(
        contrato !== undefined ? (contrato?.trim() || null) : atual.contrato,
        waNum,
        waGrupo,
        waAlerta,
        tokenNaoAdmin,
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

    res.json({ mensagem: 'Senha da filial atualizada' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const result = await db.prepare(`
      UPDATE filiais SET ativo = 0, updated_at = NOW() WHERE id = ?
    `).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ erro: 'Filial não encontrada' });

    await db.prepare(`
      UPDATE usuarios SET ativo = 0, updated_at = NOW()
      WHERE filial_id = ? AND papel IN ('filial', 'gerente')
    `).run(req.params.id);

    res.json({ mensagem: 'Filial desativada' });
  } catch (err) {
    next(err);
  }
});

export default router;
