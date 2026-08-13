import { Router } from 'express';
import { getDb } from '../database.js';
import { classificarSulco, getLimites, menorSulco } from '../limites.js';
import { diagnosticarPerfil, sugerirAcao } from '../diagnostico.js';
import { papelPosicao } from '../pneus-layouts.js';
import { requireAuth, requireFilial, filialScopeId } from '../auth.js';

const router = Router();

router.use(requireAuth);
router.use(requireFilial);

router.get('/resumo', async (req, res, next) => {
  try {
    const db = getDb();
    const limites = getLimites();
    const filialId = filialScopeId(req);

    const pneus = await db.prepare(`
    SELECT
      p.id, p.vida_recap, p.condicao, p.numero_fogo, p.posicao,
      v.placa, v.apelido,
      (SELECT sulco_externo FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_externo,
      (SELECT sulco_central FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_central,
      (SELECT sulco_interno FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_interno,
      (SELECT sulco_auxiliar FROM medicoes WHERE pneu_id = p.id ORDER BY data_medicao DESC, id DESC LIMIT 1) as sulco_auxiliar
    FROM pneus p
    JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
    WHERE p.ativo = 1 AND p.status_pneu = 'montado'
  `).all(filialId);

    let ok = 0;
    let alerta = 0;
    let critico = 0;
    let semDado = 0;
    let troca = 0;
    let recap = 0;
    let monitorar = 0;
    let rodizio = 0;
    const diagnosticos = {};

    for (const p of pneus) {
      const menor = menorSulco(p);
      const status = classificarSulco(menor);
      if (status === 'ok') ok += 1;
      else if (status === 'alerta') alerta += 1;
      else if (status === 'critico') critico += 1;
      else semDado += 1;

      const acao = sugerirAcao(menor, limites, p.vida_recap || 0, { pontos: p });
      if (acao.codigo === 'troca') troca += 1;
      else if (acao.codigo === 'recap') recap += 1;
      else if (acao.codigo === 'monitorar') monitorar += 1;
      else if (acao.codigo === 'rodizio') rodizio += 1;

      const diag = diagnosticarPerfil(p, limites.diagnostico_tolerancia_mm, {
        papel: p.posicao ? papelPosicao(p.posicao) : null,
      });
      if (diag.codigo !== 'sem_dado' && diag.codigo !== 'ok') {
        diagnosticos[diag.codigo] = (diagnosticos[diag.codigo] || 0) + 1;
      }
    }

    const veiculos = await db.prepare(`
      SELECT COUNT(*) as total FROM veiculos WHERE ativo = 1 AND filial_id = ?
    `).get(filialId);

    res.json({
      veiculos_ativos: veiculos.total,
      pneus_total: pneus.length,
      pneus_ok: ok,
      pneus_alerta: alerta,
      pneus_critico: critico,
      pneus_sem_dado: semDado,
      acoes: { troca, recap, monitorar, rodizio },
      diagnosticos,
      limites,
      filial_id: filialId,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
