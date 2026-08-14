import { Router } from 'express';
import { getLimites, setLimites } from '../limites.js';
import { DIAGNOSTICOS, ACOES } from '../diagnostico.js';
import { requireAuth, requireAdmin } from '../auth.js';

const router = Router();

router.use(requireAuth);

router.get('/', (_req, res) => {
  const limites = getLimites();
  const a = limites.acoes;
  res.json({
    ...limites,
    descricao: {
      critico: `Sulco ≤ ${limites.sulco_critico_mm} mm — ${a.troca.label}: ${a.troca.instrucao}`,
      monitorar: `Acima de ${limites.sulco_critico_mm} mm até ${limites.sulco_alerta_mm} mm — ${a.monitorar.label}: ${a.monitorar.instrucao}`,
      prazo_recap: `Prazo de ${limites.prazo_recap_dias} dias para iniciar o processo de recap ao entrar em monitorar`,
      mudanca_posicao: `Desvio entre pontos > ${limites.rodizio_desvio_mm} mm — ${a.rodizio.label}: ${a.rodizio.instrucao}`,
      ok: `Acima de ${limites.sulco_alerta_mm} mm — ${a.ok.label}: ${a.ok.instrucao}`,
      novo: `Sulco típico de pneu novo: ~${limites.sulco_novo_mm} mm`,
    },
    diagnosticos: Object.values(DIAGNOSTICOS).filter(
      (d) => d.codigo !== 'alinhamento' && d.codigo !== 'alinhamento_traseiro'
    ),
    acoes_catalogo: Object.values(ACOES),
  });
});

router.put('/', requireAdmin, async (req, res) => {
  try {
    const limites = await setLimites(req.body);
    res.json({
      ...limites,
      mensagem: 'Limites atualizados com sucesso',
    });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

export default router;
