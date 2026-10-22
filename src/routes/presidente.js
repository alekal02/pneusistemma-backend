/**
 * Visão executiva do presidente. Somente leitura.
 */
import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireLeituraExecutiva } from '../auth.js';
import {
  lerFiltrosQuery,
  obterResumoExecutivo,
  obterEvolucaoExecutiva,
  obterDetalheExecutivo,
  obterSnapshotCompleto,
} from '../services/dashboard-executivo.js';
import { gerarPdfExecutivoBuffer, nomeArquivoExecutivo } from '../services/dashboard-executivo-pdf.js';

const router = Router();

router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ erro: 'A visão executiva é somente leitura.' });
  }
  next();
});
router.use(requireLeituraExecutiva);

function falha(err, res, next) {
  if (err?.status) return res.status(err.status).json({ erro: err.message });
  return next(err);
}

router.get('/visao', async (req, res, next) => {
  try {
    const filtros = lerFiltrosQuery(req.query);
    res.json(await obterResumoExecutivo(getDb(), filtros));
  } catch (err) {
    falha(err, res, next);
  }
});

router.get('/evolucao', async (req, res, next) => {
  try {
    const filtros = lerFiltrosQuery(req.query);
    res.json(await obterEvolucaoExecutiva(getDb(), filtros));
  } catch (err) {
    falha(err, res, next);
  }
});

router.get('/detalhe', async (req, res, next) => {
  try {
    const filtros = lerFiltrosQuery(req.query);
    const filialId = req.query.filial_foco != null && req.query.filial_foco !== ''
      ? Number(req.query.filial_foco)
      : null;
    const veiculoId = req.query.veiculo_id != null && req.query.veiculo_id !== ''
      ? Number(req.query.veiculo_id)
      : null;
    if (filialId != null && (!Number.isInteger(filialId) || filialId <= 0)) {
      return res.status(400).json({ erro: 'Filial inválida.' });
    }
    if (veiculoId != null && (!Number.isInteger(veiculoId) || veiculoId <= 0)) {
      return res.status(400).json({ erro: 'Veículo inválido.' });
    }
    res.json(await obterDetalheExecutivo(getDb(), filtros, {
      recorte: String(req.query.recorte || 'pneus'),
      foco: String(req.query.foco || ''),
      filialId,
      veiculoId,
      pagina: req.query.pagina,
      limite: req.query.limite,
    }));
  } catch (err) {
    falha(err, res, next);
  }
});

router.get('/visao.pdf', async (req, res, next) => {
  try {
    const filtros = lerFiltrosQuery(req.query);
    const pacote = await obterSnapshotCompleto(getDb(), filtros);
    const buffer = await gerarPdfExecutivoBuffer(pacote);
    const filename = nomeArquivoExecutivo(pacote.snapshot?.gerado_em);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    falha(err, res, next);
  }
});

export default router;
