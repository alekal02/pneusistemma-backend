/**
 * APIs públicas de acesso rápido (token WhatsApp, sem JWT)
 */
import { Router } from 'express';
import {
  validarTokenAcessoRapido,
  marcarTokenUsado,
  montarDetalheVeiculo,
  listarEstoqueFilial,
} from '../services/acesso-rapido.js';
import * as ops from '../services/whatsapp-ops.js';
import { getDb } from '../database.js';
import { assertVeiculoDaFilial } from '../auth.js';
import {
  TIPOS_PNEU,
  CONDICOES_PNEU,
  getLayout,
  LAYOUT_PADRAO,
  validarMontagem,
  labelPosicao,
} from '../pneus-layouts.js';

const router = Router();

async function tokenOuErro(token, tipos) {
  const row = await validarTokenAcessoRapido(String(token || ''), tipos);
  if (!row) {
    const err = new Error('Link inválido ou expirado');
    err.status = 401;
    throw err;
  }
  return row;
}

router.get('/', async (req, res, next) => {
  try {
    const row = await tokenOuErro(req.query.token);
    const db = getDb();
    const filial = await db.prepare(`
      SELECT id, nome, codigo FROM filiais WHERE id = ? AND ativo = 1
    `).get(row.filial_id);
    if (!filial) return res.status(404).json({ erro: 'Filial não encontrada' });

    const payload = {
      tipo: row.tipo || 'medir',
      token: row.token,
      filial,
      expira_em: row.expira_em,
    };

    if (row.tipo === 'cadastrar_veiculo' || row.tipo === 'cadastrar_pneu') {
      return res.json(payload);
    }

    if (!row.veiculo_id) {
      return res.status(400).json({ erro: 'Token sem veículo vinculado' });
    }

    const veiculo = await montarDetalheVeiculo(row.veiculo_id, row.filial_id);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    if (row.tipo === 'troca') {
      const estoque = await listarEstoqueFilial(row.filial_id, 50);
      return res.json({
        ...payload,
        veiculo,
        estoque,
        pneus_montados: veiculo.pneus || [],
      });
    }

    // medir (compatível com GET /veiculos/acesso-rapido)
    res.json({
      ...veiculo,
      tipo_token: 'medir',
      tipo: 'medir',
      token_acesso: row.token,
      token_valido: true,
      filial,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.post('/veiculo', async (req, res, next) => {
  try {
    const { token, placa, apelido, tipo, km_atual, layout_pneus } = req.body || {};
    const row = await tokenOuErro(token, ['cadastrar_veiculo']);
    if (!placa?.trim()) return res.status(400).json({ erro: 'Placa é obrigatória' });

    const created = await ops.criarVeiculo(row.filial_id, {
      placa: placa.trim(),
      apelido: apelido || null,
      tipo: tipo || 'Truck / Tração',
      km_atual: km_atual ?? 0,
      layout_pneus: layout_pneus || null,
    });
    await marcarTokenUsado(row.id);

    res.status(201).json({
      mensagem: `Caminhão ${String(placa).trim().toUpperCase()} cadastrado`,
      veiculo_id: created.id,
      total_posicoes: created.total_posicoes,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.post('/pneu', async (req, res, next) => {
  try {
    const {
      token, numero_fogo, marca, modelo, tipo_pneu, condicao, sulco_inicial_mm,
    } = req.body || {};
    const row = await tokenOuErro(token, ['cadastrar_pneu']);
    if (!String(numero_fogo || '').trim()) {
      return res.status(400).json({ erro: 'Nº de fogo é obrigatório' });
    }
    if (!String(modelo || '').trim()) {
      return res.status(400).json({ erro: 'Modelo é obrigatório' });
    }
    const tipo = String(tipo_pneu || 'misto');
    const cond = String(condicao || 'novo');
    if (!TIPOS_PNEU.includes(tipo)) {
      return res.status(400).json({ erro: `Padrão inválido: ${TIPOS_PNEU.join(', ')}` });
    }
    if (!CONDICOES_PNEU.includes(cond)) {
      return res.status(400).json({ erro: `Condição inválida: ${CONDICOES_PNEU.join(', ')}` });
    }

    const created = await ops.criarPneuEstoque(row.filial_id, {
      numero_fogo: String(numero_fogo).trim(),
      marca: marca || null,
      modelo: String(modelo).trim(),
      tipo_pneu: tipo,
      condicao: cond,
      sulco_inicial_mm: sulco_inicial_mm ?? null,
    });
    await marcarTokenUsado(row.id);

    res.status(201).json({
      mensagem: `Pneu fogo ${created.numero_fogo || numero_fogo} no estoque`,
      pneu: created,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Troca em uma transação: retira pneu montado e monta outro do estoque na mesma posição.
 */
router.post('/troca', async (req, res, next) => {
  try {
    const {
      token,
      retirar_pneu_id,
      retirar_posicao,
      montar_pneu_id,
      km_veiculo,
    } = req.body || {};
    const row = await tokenOuErro(token, ['troca']);
    if (!montar_pneu_id) {
      return res.status(400).json({ erro: 'Informe o pneu do estoque para montar' });
    }
    if (!retirar_pneu_id && !retirar_posicao) {
      return res.status(400).json({ erro: 'Informe o pneu ou a posição a retirar' });
    }

    const filialId = row.filial_id;
    const veiculo = await assertVeiculoDaFilial(row.veiculo_id, filialId);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const db = getDb();
    let montado = null;
    if (retirar_pneu_id) {
      montado = await db.prepare(`
        SELECT * FROM pneus
        WHERE id = ? AND veiculo_id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'montado'
      `).get(retirar_pneu_id, veiculo.id, filialId);
    } else {
      montado = await db.prepare(`
        SELECT * FROM pneus
        WHERE veiculo_id = ? AND posicao = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'montado'
      `).get(veiculo.id, String(retirar_posicao).toUpperCase(), filialId);
    }
    if (!montado) {
      return res.status(404).json({ erro: 'Pneu montado não encontrado nessa posição' });
    }

    const estoque = await db.prepare(`
      SELECT * FROM pneus
      WHERE id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'estoque'
    `).get(montar_pneu_id, filialId);
    if (!estoque) {
      return res.status(404).json({ erro: 'Pneu do estoque não encontrado' });
    }

    const posicao = montado.posicao;
    const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
    if (!layout.posicoes.includes(posicao)) {
      return res.status(400).json({ erro: `Posição ${posicao} inválida no layout` });
    }
    const validacao = validarMontagem({
      condicao: estoque.condicao,
      tipo_pneu: estoque.tipo_pneu,
      posicao,
    });
    if (!validacao.ok) {
      return res.status(400).json({ erro: validacao.erros.join(' ') });
    }

    await ops.desmontarPneu({ filialId, pneuId: montado.id });
    const montagem = await ops.montarPneu({
      filialId,
      pneuId: estoque.id,
      veiculoId: veiculo.id,
      posicao,
    });
    await marcarTokenUsado(row.id);

    const detalhe = await montarDetalheVeiculo(veiculo.id, filialId);
    res.json({
      mensagem: `Trocou fogo ${montado.numero_fogo} → ${montagem.fogo} em ${labelPosicao(posicao)}`,
      retirado: { id: montado.id, fogo: montado.numero_fogo, posicao },
      montado: montagem,
      veiculo: detalhe,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

export default router;
