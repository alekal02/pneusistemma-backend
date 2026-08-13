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
    const diag = diagnosticarPerfil(p, limites.diagnostico_tolerancia_mm);
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
      ) as menor_sulco
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
      (SELECT data_medicao FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as ult_medicao
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
      const diag = diagnosticarPerfil(row, limites.diagnostico_tolerancia_mm);
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
        diagnostico: p.ult_diagnostico || diag.codigo,
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
