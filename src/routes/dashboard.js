import { Router } from 'express';
import { getDb } from '../database.js';
import { classificarSulco, getLimites, limitesDoVeiculo, menorSulco } from '../limites.js';
import { requireAuth, requireFilial, filialScopeId } from '../auth.js';
import { normalizarDiaMedicao, labelDiaMedicao, semanaMedicaoBrasil } from '../dia-medicao.js';
import { SQL_LATERAL_ULTIMA_MEDICAO, SQL_LOGS_MEDICAO_FILIAL } from '../sql-ultima-medicao.js';
import { filtroCadastroCompleto } from '../schema-colunas.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import {
  acumularAlerta,
  avaliarPneuPainel,
  filtroTipoAtivo,
  indicadoresUso,
  novoAcumulador,
  piorStatus,
  statusPainel,
  unidadeUsoVeiculo,
  veiculoCombinaTipo,
} from '../services/indicadores-frota.js';

const router = Router();

router.use(requireAuth);
router.use(requireFilial);

router.get('/desenhos', async (req, res, next) => {
  try {
    const db = getDb();
    const filialId = filialScopeId(req);
    const ids = [...new Set(
      String(req.query.ids || '')
        .split(',')
        .map((valor) => Number(valor))
        .filter((n) => Number.isInteger(n) && n > 0),
    )].slice(0, 24);
    if (!ids.length || !filialId) return res.json({ veiculos: [] });
    const marcas = ids.map(() => '?').join(',');
    const cadastro = await filtroCadastroCompleto(db, 'veiculos', 'v.cadastro_completo');
    const pneus = await db.prepare(`
      SELECT
        p.id, p.veiculo_id, p.vida_recap, p.condicao, p.numero_fogo, p.posicao,
        v.placa, v.apelido, v.tipo, v.layout_pneus, v.km_atual, v.hr_atual,
        um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar, um.sulco_mm,
        um.inspecao_danos, um.data_medicao, um.created_at as medicao_created
      FROM pneus p
      JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
        AND ${cadastro}
      ${SQL_LATERAL_ULTIMA_MEDICAO}
      WHERE p.ativo = 1 AND p.status_pneu = 'montado' AND p.veiculo_id IN (${marcas})
    `).all(filialId, ...ids);
    for (const p of pneus) {
      const aval = avaliarPneuPainel(p, { limites: limitesDoVeiculo(p) });
      p._menor_sulco = aval.menor_sulco;
      p._status_sulco = aval.status_sulco;
    }
    const map = compactarPneusPorVeiculo(pneus);
    for (const p of pneus) {
      const item = (map.get(Number(p.veiculo_id)) || []).find((row) => Number(row.id) === Number(p.id));
      if (item) item.numero_fogo = p.numero_fogo;
    }
    const daFilial = await db.prepare(`
      SELECT id FROM veiculos
      WHERE ativo = 1 AND filial_id = ? AND id IN (${marcas})
    `).all(filialId, ...ids);
    const permitidos = new Set(daFilial.map((v) => Number(v.id)));
    res.json({
      veiculos: ids.filter((id) => permitidos.has(id)).map((id) => ({
        id,
        pneus: map.get(id) || [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

function statsPorVeiculo(pneus) {
  const acc = new Map();
  for (const p of pneus) {
    const vid = Number(p.veiculo_id);
    if (!acc.has(vid)) {
      acc.set(vid, {
        total_pneus: 0,
        pneus_medidos: 0,
        menor_sulco: null,
        ultima_medicao: null,
        ultima_atualizacao: null,
      });
    }
    const a = acc.get(vid);
    a.total_pneus += 1;
    const menor = menorSulco(p);
    if (p.data_medicao || menor != null) {
      a.pneus_medidos += 1;
    }
    if (menor != null) {
      a.menor_sulco = a.menor_sulco == null ? menor : Math.min(a.menor_sulco, menor);
    }
    if (p.data_medicao && (!a.ultima_medicao || String(p.data_medicao) > String(a.ultima_medicao))) {
      a.ultima_medicao = p.data_medicao;
    }
    if (p.medicao_created && (!a.ultima_atualizacao || String(p.medicao_created) > String(a.ultima_atualizacao))) {
      a.ultima_atualizacao = p.medicao_created;
    }
  }
  return acc;
}

function compactarPneusPorVeiculo(pneus) {
  const map = new Map();
  for (const p of pneus) {
    const vid = Number(p.veiculo_id);
    if (!map.has(vid)) map.set(vid, []);
    map.get(vid).push({
      id: p.id,
      posicao: p.posicao,
      menor_sulco: p._menor_sulco,
      status_sulco: p._status_sulco,
    });
  }
  return map;
}

async function logsMedicaoFilial(db, filialId, limite = 40) {
  const rows = await db.prepare(SQL_LOGS_MEDICAO_FILIAL).all(filialId, limite);
  return (rows || []).map((r) => {
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
  });
}

router.get('/resumo', async (req, res, next) => {
  try {
    const db = getDb();
    const limites = getLimites();
    const filialId = filialScopeId(req);
    const semPneus = String(req.query.sem_pneus || '') === '1';
    const somenteIndice = String(req.query.somente_indice || '') === '1';

    const [pneus, veiculosRows, filial] = await Promise.all([
      db.prepare(`
        SELECT
          p.id, p.veiculo_id, p.vida_recap, p.condicao, p.numero_fogo, p.posicao,
          v.placa, v.apelido, v.tipo, v.layout_pneus, v.km_atual, v.hr_atual,
          um.sulco_externo, um.sulco_central, um.sulco_interno, um.sulco_auxiliar, um.sulco_mm,
          um.inspecao_danos, um.data_medicao, um.created_at as medicao_created
        FROM pneus p
        JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
          AND ${await filtroCadastroCompleto(db, 'veiculos', 'v.cadastro_completo')}
        ${SQL_LATERAL_ULTIMA_MEDICAO}
        WHERE p.ativo = 1 AND p.status_pneu = 'montado'
      `).all(filialId),
      db.prepare(`
        SELECT * FROM veiculos
        WHERE ativo = 1 AND filial_id = ?
        ORDER BY apelido, placa
      `).all(filialId),
      db.prepare('SELECT dia_medicao FROM filiais WHERE id = ?').get(filialId),
    ]);

    const tipoFiltro = req.query.tipo;
    const pneusFiltrados = pneus.filter((p) => veiculoCombinaTipo(p.tipo, tipoFiltro));
    const acc = novoAcumulador();
    const accKm = novoAcumulador();
    const accHoras = novoAcumulador();
    const statusPorVeiculo = new Map();
    const diagnosticos = {};
    const acoesItens = [];
    const diagnosticosItens = [];

    for (const p of pneusFiltrados) {
      const limV = limitesDoVeiculo(p);
      const aval = avaliarPneuPainel(p, { limites: limV });
      acumularAlerta(acc, aval);
      const unidade = unidadeUsoVeiculo(p.tipo, p.layout_pneus);
      acumularAlerta(unidade === 'horas' ? accHoras : accKm, aval);
      const menor = aval.menor_sulco;
      const status = statusPainel(aval);
      p._menor_sulco = menor;
      p._status_sulco = aval.status_sulco;
      const vid = Number(p.veiculo_id);
      statusPorVeiculo.set(vid, piorStatus(statusPorVeiculo.get(vid), status));

      const acao = aval.acao || {};
      if (acao.codigo && acao.codigo !== 'ok') {
        acoesItens.push({
          pneu_id: p.id,
          veiculo_id: p.veiculo_id,
          placa: p.placa,
          apelido: p.apelido,
          posicao: p.posicao,
          menor_sulco: menor,
          status_sulco: status,
          acao_sugerida: acao.codigo,
          acao_label: acao.label,
          acao_motivo: acao.motivo,
        });
      }

      const diag = aval.diagnostico || {};
      if (diag.codigo && diag.codigo !== 'sem_dado' && diag.codigo !== 'ok') {
        diagnosticos[diag.codigo] = (diagnosticos[diag.codigo] || 0) + 1;
        diagnosticosItens.push({
          pneu_id: p.id,
          veiculo_id: p.veiculo_id,
          placa: p.placa,
          apelido: p.apelido,
          posicao: p.posicao,
          menor_sulco: menor,
          status_sulco: status,
          diagnostico: diag.codigo,
          diagnostico_label: diag.label,
          diagnostico_desc: diag.descricao || '',
        });
      }
    }

    const ordemAcao = { troca: 0, recap: 1, rodizio: 2, monitorar: 3, substituir: 0, corte: 0, dano_lateral: 0 };
    acoesItens.sort((a, b) => (ordemAcao[a.acao_sugerida] ?? 9) - (ordemAcao[b.acao_sugerida] ?? 9)
      || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99));
    const ordemDiag = {
      critico: 0, falta_calib: 1, excesso_calib: 2, irregular: 3, desgaste_progressivo: 4,
    };
    diagnosticosItens.sort((a, b) => (ordemDiag[a.diagnostico] ?? 9) - (ordemDiag[b.diagnostico] ?? 9)
      || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99));

    if (somenteIndice) {
      return res.json({
        indice: pneusFiltrados.map((p) => ({
          id: p.id,
          veiculo_id: Number(p.veiculo_id),
          posicao: p.posicao,
          numero_fogo: p.numero_fogo,
          menor_sulco: p._menor_sulco ?? null,
          status_sulco: p._status_sulco || 'sem_dado',
        })),
      });
    }

    const porVeiculo = statsPorVeiculo(pneusFiltrados);
    const pneusMap = semPneus ? new Map() : compactarPneusPorVeiculo(pneusFiltrados);
    const logsTodos = await logsMedicaoFilial(db, filialId);
    const veiculos = veiculosRows
      .filter((v) => veiculoCombinaTipo(v.tipo, tipoFiltro))
      .map((v) => {
        const tipo = normalizarTipoVeiculo(v.tipo);
        const cadastroPendente = Number(v.cadastro_completo ?? 1) !== 1;
        const vazio = {
          total_pneus: 0,
          pneus_medidos: 0,
          menor_sulco: null,
          ultima_medicao: null,
          ultima_atualizacao: null,
        };
        const a = cadastroPendente ? vazio : (porVeiculo.get(Number(v.id)) || vazio);
        return {
          ...v,
          tipo,
          cadastro_pendente: cadastroPendente,
          total_pneus: a.total_pneus,
          pneus_medidos: a.pneus_medidos,
          menor_sulco: a.menor_sulco,
          status_sulco: cadastroPendente
            ? 'cadastro_pendente'
            : (statusPorVeiculo.get(Number(v.id)) || 'sem_dado'),
          unidade_uso: unidadeUsoVeiculo(tipo, v.layout_pneus),
          ultima_medicao: a.ultima_medicao,
          ultima_atualizacao: a.ultima_atualizacao,
          dia_medicao: normalizarDiaMedicao(v.dia_medicao),
          pneus: cadastroPendente || semPneus ? [] : (pneusMap.get(Number(v.id)) || []),
        };
      });
    const idsFrota = new Set(veiculos.filter((v) => !v.cadastro_pendente).map((v) => Number(v.id)));
    const logsMedicao = tipoFiltro
      ? logsTodos.filter((l) => idsFrota.has(Number(l.veiculo_id)))
      : logsTodos;

    const semana = semanaMedicaoBrasil();

    res.json({
      veiculos_ativos: veiculos.filter((v) => !v.cadastro_pendente).length,
      pneus_total: pneusFiltrados.length,
      pneus_ok: acc.ok,
      pneus_alerta: acc.monitorar,
      pneus_critico: acc.critico,
      pneus_sem_dado: acc.sem_dado,
      acoes: {
        troca: acc.troca,
        recap: acc.recap,
        monitorar: acc.acao_monitorar,
        rodizio: acc.rodizio,
      },
      indicadores_uso: indicadoresUso(veiculos.filter((v) => !v.cadastro_pendente), accKm, accHoras),
      filtro_tipo: filtroTipoAtivo(tipoFiltro),
      acoes_itens: acoesItens,
      diagnosticos,
      diagnosticos_itens: diagnosticosItens,
      limites,
      filial_id: filialId,
      dia_medicao: normalizarDiaMedicao(filial?.dia_medicao),
      dia_medicao_label: labelDiaMedicao(filial?.dia_medicao),
      semana,
      veiculos,
      logs_medicao: logsMedicao,
      pneus_omitidos: semPneus,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/dia-medicao', async (req, res, next) => {
  try {
    const filialId = filialScopeId(req);
    if (!filialId) {
      return res.status(400).json({ erro: 'Usuário sem unidade vinculada' });
    }
    const dia = normalizarDiaMedicao(req.body?.dia_medicao);
    const db = getDb();
    await db.prepare(`
      UPDATE filiais SET dia_medicao = ?, updated_at = NOW() WHERE id = ? AND ativo = 1
    `).run(dia, filialId);
    res.json({
      mensagem: dia
        ? `Dia da medição da frota: ${labelDiaMedicao(dia)}`
        : 'Dia da medição da frota removido',
      dia_medicao: dia,
      dia_medicao_label: labelDiaMedicao(dia),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
