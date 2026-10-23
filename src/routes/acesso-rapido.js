/**
 * APIs públicas de acesso rápido (token WhatsApp, sem JWT)
 */
import { Router } from 'express';
import {
  validarTokenAcessoRapido,
  marcarTokenUsado,
  confirmarCadastroJaGravado,
  montarDetalheVeiculo,
  listarEstoqueFilial,
} from '../services/acesso-rapido.js';
import * as ops from '../services/whatsapp-ops.js';
import { getDb } from '../database.js';
import { projecaoCadastroCompleto } from '../schema-colunas.js';
import { assertVeiculoDaFilial } from '../auth.js';
import { metaTiposEquipamento, resolverTipoEquipamento } from '../equipamento-tipos.js';
import {
  TIPOS_PNEU,
  CONDICOES_PNEU,
  getLayout,
  LAYOUT_PADRAO,
  validarMontagem,
  labelPosicao,
  listarLayoutsPublicos,
} from '../pneus-layouts.js';
import { consultarProximoFogo } from '../numero-fogo.js';
import { invalidarExecutivoAoConfirmar } from '../services/invalidacao-executiva.js';

const router = Router();
router.use(invalidarExecutivoAoConfirmar());

async function tokenOuErro(token, tipos, { permitirUsado = false, req = null } = {}) {
  const row = await validarTokenAcessoRapido(String(token || ''), tipos, { permitirUsado });
  if (!row) {
    const err = new Error('Link inválido ou expirado');
    err.status = 401;
    throw err;
  }
  if (req) req.acessoRapido = row;
  return row;
}

router.get('/', async (req, res, next) => {
  try {
    const row = await tokenOuErro(req.query.token, null, { permitirUsado: true });
    const ja = await confirmarCadastroJaGravado(row);
    if (ja?.status) return res.status(ja.status).json({ erro: ja.erro });
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
      ...(ja?.ja_gravado ? { ja_gravado: true, mensagem: ja.mensagem } : {}),
    };

    if (row.tipo === 'cadastrar_veiculo') {
      const cat = metaTiposEquipamento();
      let veiculo = null;
      if (row.veiculo_id) {
        const colCadastro = await projecaoCadastroCompleto(db, 'veiculos');
        veiculo = await db.prepare(`
          SELECT id, placa, apelido, tipo, marca, modelo, km_atual, hr_atual, layout_pneus, ${colCadastro}
          FROM veiculos WHERE id = ? AND filial_id = ?
        `).get(row.veiculo_id, row.filial_id);
      }
      return res.json({
        ...payload,
        tipos: cat.tipos,
        tipos_equipamento: cat.tipos_equipamento,
        layouts: listarLayoutsPublicos(),
        veiculo,
        pre_cadastro: Boolean(veiculo && Number(veiculo.cadastro_completo) !== 1),
      });
    }
    if (row.tipo === 'cadastrar_pneu') {
      const proximo_fogo = await consultarProximoFogo(db, row.filial_id).catch(() => null);
      let pneu = null;
      if (row.pneu_id) {
        const colCadastro = await projecaoCadastroCompleto(db, 'pneus');
        pneu = await db.prepare(`
          SELECT id, numero_fogo, marca, modelo, tipo_pneu, condicao, sulco_inicial_mm, ${colCadastro}
          FROM pneus WHERE id = ? AND filial_id = ?
        `).get(row.pneu_id, row.filial_id);
      }
      return res.json({
        ...payload,
        proximo_fogo,
        pneu,
        pre_cadastro: Boolean(pneu && Number(pneu.cadastro_completo) !== 1),
      });
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
    const proximo_fogo = await consultarProximoFogo(db, row.filial_id).catch(() => null);
    res.json({
      ...veiculo,
      tipo_token: 'medir',
      tipo: 'medir',
      token_acesso: row.token,
      token_valido: true,
      filial,
      proximo_fogo,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.get('/proximo-fogo', async (req, res, next) => {
  try {
    const row = await tokenOuErro(req.query.token, ['cadastrar_pneu', 'medir']);
    const info = await consultarProximoFogo(getDb(), row.filial_id);
    res.json(info);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

router.post('/veiculo', async (req, res, next) => {
  try {
    const { token, placa, apelido, tipo, km_atual, hr_atual, layout_pneus, marca, modelo } = req.body || {};
    const row = await tokenOuErro(token, ['cadastrar_veiculo'], { permitirUsado: true, req });
    const ja = await confirmarCadastroJaGravado(row);
    if (ja?.ja_gravado) return res.status(200).json(ja);
    if (ja?.status) return res.status(ja.status).json({ erro: ja.erro });
    if (!String(modelo || '').trim()) {
      return res.status(400).json({ erro: 'Modelo é obrigatório' });
    }
    if (!String(marca || '').trim()) {
      return res.status(400).json({ erro: 'Fabricante é obrigatório' });
    }
    if (!layout_pneus) {
      return res.status(400).json({ erro: 'Configuração dos eixos é obrigatória' });
    }
    if (!row.veiculo_id && !placa?.trim()) {
      return res.status(400).json({ erro: 'Placa é obrigatória' });
    }

    const db = getDb();
    const created = await db.transaction(async () => {
      const salvo = row.veiculo_id
        ? await ops.completarVeiculo(row.filial_id, row.veiculo_id, {
          placa, apelido, tipo, km_atual, layout_pneus, marca, modelo,
        })
        : await ops.criarVeiculo(row.filial_id, {
          placa: placa.trim(),
          apelido: apelido || null,
          tipo: tipo || 'Truck / Tração',
          km_atual: km_atual ?? 0,
          hr_atual: hr_atual ?? 0,
          layout_pneus: layout_pneus || null,
          marca,
          modelo,
        });
      if (!salvo?.id) {
        const err = new Error('O banco não confirmou o veículo');
        err.status = 500;
        throw err;
      }
      await marcarTokenUsado(row.id, { veiculoId: salvo.id });
      return salvo;
    });

    const placaOk = created.placa || String(placa || '').trim().toUpperCase();
    const cat = resolverTipoEquipamento(tipo);
    const rotulo = cat?.familia === 'rodoviario' || !cat ? 'Caminhão' : 'Equipamento';
    res.status(201).json({
      mensagem: `${rotulo} ${placaOk} cadastrado`,
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
    const row = await tokenOuErro(token, ['cadastrar_pneu'], { permitirUsado: true, req });
    const ja = await confirmarCadastroJaGravado(row);
    if (ja?.ja_gravado) return res.status(200).json(ja);
    if (ja?.status) return res.status(ja.status).json({ erro: ja.erro });
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

    const db = getDb();
    const created = await db.transaction(async () => {
      const salvo = row.pneu_id
        ? await ops.completarPneu(row.filial_id, row.pneu_id, {
          numero_fogo,
          marca: marca || null,
          modelo: String(modelo).trim(),
          tipo_pneu: tipo,
          condicao: cond,
          sulco_inicial_mm: sulco_inicial_mm ?? null,
        })
        : await ops.criarPneuEstoque(row.filial_id, {
          numero_fogo,
          marca: marca || null,
          modelo: String(modelo).trim(),
          tipo_pneu: tipo,
          condicao: cond,
          sulco_inicial_mm: sulco_inicial_mm ?? null,
        });
      if (!salvo?.id) {
        const err = new Error('O banco não confirmou o pneu');
        err.status = 500;
        throw err;
      }
      await marcarTokenUsado(row.id, { pneuId: salvo.id });
      return salvo;
    });

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
 * Lista frota da filial do token (para mover/trocar entre veículos no link de medição).
 */
router.get('/frota', async (req, res, next) => {
  try {
    const row = await tokenOuErro(req.query.token, ['medir', 'troca']);
    const frota = await ops.listarFrota(row.filial_id);
    const estoque = await listarEstoqueFilial(row.filial_id, 80);
    res.json({
      filial_id: row.filial_id,
      veiculo_token_id: row.veiculo_id,
      frota,
      estoque,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Posições (livres e ocupadas) de um veículo da filial do token.
 */
router.get('/veiculo-posicoes', async (req, res, next) => {
  try {
    const row = await tokenOuErro(req.query.token, ['medir', 'troca']);
    const veiculoId = parseInt(req.query.veiculo_id, 10);
    if (!veiculoId) return res.status(400).json({ erro: 'Informe veiculo_id' });

    const veiculo = await assertVeiculoDaFilial(veiculoId, row.filial_id);
    if (!veiculo) return res.status(404).json({ erro: 'Veículo não encontrado' });

    const layout = getLayout(veiculo.layout_pneus || LAYOUT_PADRAO);
    const db = getDb();
    const montados = await db.prepare(`
      SELECT id, numero_fogo, posicao, tipo_pneu, condicao
      FROM pneus
      WHERE veiculo_id = ? AND filial_id = ? AND ativo = 1 AND status_pneu = 'montado'
    `).all(veiculo.id, row.filial_id);
    const porPos = Object.fromEntries(montados.map((p) => [p.posicao, p]));

    res.json({
      veiculo: { id: veiculo.id, placa: veiculo.placa, apelido: veiculo.apelido },
      posicoes: layout.posicoes.map((codigo) => ({
        codigo,
        label: labelPosicao(codigo),
        livre: !porPos[codigo],
        pneu: porPos[codigo] || null,
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

/**
 * Ações do pneu no link de medição (token medir/troca).
 * acao: estoque | recap | descarte | reposicionar | troca_estoque | mover_frota
 */
router.post('/pneu-acao', async (req, res, next) => {
  try {
    const {
      token,
      acao,
      pneu_id,
      posicao,
      montar_pneu_id,
      veiculo_destino_id,
      motivo,
      permitir_vazio,
    } = req.body || {};
    const row = await tokenOuErro(token, ['medir', 'troca'], { req });
    const acaoNorm = String(acao || '');
    const pneuId = parseInt(
      acaoNorm === 'montar_estoque' ? (montar_pneu_id || pneu_id) : pneu_id,
      10,
    );
    if (!pneuId) return res.status(400).json({ erro: 'Informe pneu_id' });
    if (!acao) return res.status(400).json({ erro: 'Informe a ação' });

    const filialId = row.filial_id;
    const db = getDb();
    const pneu = await db.prepare(`
      SELECT * FROM pneus WHERE id = ? AND filial_id = ? AND ativo = 1
    `).get(pneuId, filialId);
    if (!pneu) return res.status(404).json({ erro: 'Pneu não encontrado' });

    // No link de medição, só age sobre pneus do veículo do token (exceto estoque na troca)
    if (pneu.status_pneu === 'montado' && row.veiculo_id && Number(pneu.veiculo_id) !== Number(row.veiculo_id)) {
      return res.status(403).json({ erro: 'Este link só permite ações nos pneus deste caminhão' });
    }

    let result;
    switch (acaoNorm) {
      case 'estoque': {
        result = await ops.enviarAoEstoqueOuTrocar({
          filialId,
          pneuId,
          pneuEstoqueId: montar_pneu_id,
          permitirVazio: ops.autorizarDesmontagemSimples(permitir_vazio),
        });
        if (result.modo === 'desmontagem_simples') {
          result = { mensagem: `Fogo ${result.fogo} enviado ao estoque`, ...result };
        }
        break;
      }
      case 'recap': {
        const substId = montar_pneu_id ? parseInt(montar_pneu_id, 10) : null;
        result = await ops.registrarRecap({
          filialId,
          pneuId,
          pneuEstoqueId: substId || null,
        });
        const montou = result.substituto
          ? ` · fogo ${result.substituto.fogo} montado em ${result.substituto.posicao}`
          : '';
        result = {
          mensagem: `Fogo ${result.fogo} enviado à recapagem (${result.vida}ª vida)${montou}`,
          ...result,
        };
        break;
      }
      case 'descarte': {
        const substId = montar_pneu_id ? parseInt(montar_pneu_id, 10) : null;
        result = await ops.registrarDescarte({
          filialId,
          pneuId,
          motivo: motivo || null,
          pneuEstoqueId: substId || null,
        });
        const montou = result.substituto
          ? ` · fogo ${result.substituto.fogo} montado em ${result.substituto.posicao}`
          : '';
        result = { mensagem: `Fogo ${result.fogo} enviado ao descarte${montou}`, ...result };
        break;
      }
      case 'reposicionar': {
        if (!posicao) return res.status(400).json({ erro: 'Informe a nova posição' });
        if (pneu.status_pneu !== 'montado' || !pneu.veiculo_id) {
          return res.status(400).json({ erro: 'Pneu precisa estar montado' });
        }
        result = await ops.moverOuTrocarNaFrota({
          filialId,
          pneuId,
          veiculoDestinoId: pneu.veiculo_id,
          posicaoDestino: posicao,
          detalhes: 'Acesso rápido · mudou de posição no mesmo caminhão',
        });
        break;
      }
      case 'troca_estoque':
        if (!montar_pneu_id) return res.status(400).json({ erro: 'Informe o pneu do estoque' });
        result = await ops.trocarPorEstoque({
          filialId,
          pneuMontadoId: pneuId,
          pneuEstoqueId: parseInt(montar_pneu_id, 10),
        });
        break;
      case 'mover_frota':
        if (!veiculo_destino_id || !posicao) {
          return res.status(400).json({ erro: 'Informe veículo e posição de destino' });
        }
        result = await ops.moverOuTrocarNaFrota({
          filialId,
          pneuId,
          veiculoDestinoId: parseInt(veiculo_destino_id, 10),
          posicaoDestino: posicao,
          detalhes: 'Acesso rápido · mover/trocar na frota',
        });
        break;
      default:
        return res.status(400).json({
          erro: 'acao inválida (estoque, recap, descarte, reposicionar, troca_estoque, mover_frota)',
        });
    }

    await marcarTokenUsado(row.id);
    const veiculoId = row.veiculo_id || result?.origem?.para?.veiculo_id || pneu.veiculo_id;
    const detalhe = veiculoId ? await montarDetalheVeiculo(veiculoId, filialId) : null;
    res.json({ ...result, veiculo: detalhe });
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
    const row = await tokenOuErro(token, ['troca'], { req });
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

    const troca = await ops.trocarPorEstoque({
      filialId,
      pneuMontadoId: montado.id,
      pneuEstoqueId: estoque.id,
    });
    await marcarTokenUsado(row.id);

    const detalhe = await montarDetalheVeiculo(veiculo.id, filialId);
    res.json({
      mensagem: troca.mensagem || `Trocou fogo ${montado.numero_fogo} → ${troca.montado?.fogo} em ${labelPosicao(posicao)}`,
      retirado: { id: montado.id, fogo: montado.numero_fogo, posicao },
      montado: troca.montado,
      veiculo: detalhe,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    next(err);
  }
});

export default router;
