/**
 * Carga inicial da frota — veículos + pneus montados + estoque em uma planilha.
 * Não altera o fluxo diário de medição: depois da importação, mede no diagrama.
 */
import { Router } from 'express';
import { getDb } from '../database.js';
import { comSavepoint, ehViolacaoUnique } from '../db-utils.js';
import { requireAuth, requireFilial, filialScopeId } from '../auth.js';
import { normalizarTipoVeiculo } from '../fix-encoding.js';
import {
  LAYOUTS_PNEU,
  LAYOUT_PADRAO,
  aplicarLayoutPneus,
  getLayout,
  validarMontagem,
} from '../pneus-layouts.js';
import {
  parseCsv,
  toCsv,
  FROTA_TEMPLATE_HEADERS,
  FROTA_TEMPLATE_ROWS,
  mapLayoutId,
  mapTipoPneu,
  mapCondicao,
  mapStatusPneu,
} from '../csv-utils.js';

const router = Router();
router.use(requireAuth);
router.use(requireFilial);

router.get('/import/modelo', (_req, res) => {
  const csv = toCsv(FROTA_TEMPLATE_HEADERS, FROTA_TEMPLATE_ROWS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-carga-frota.csv"');
  res.send(csv);
});

router.post('/import', async (req, res, next) => {
  const filialId = filialScopeId(req);
  const db = getDb();

  let rows = Array.isArray(req.body?.itens) ? req.body.itens : null;
  if (!rows && req.body?.csv) rows = parseCsv(req.body.csv).rows;
  if (!rows?.length) {
    return res.status(400).json({ erro: 'Nenhuma linha para importar. Envie csv ou itens[].' });
  }

  const veiculosCriados = [];
  const veiculosReutilizados = [];
  const pneusMontados = [];
  const pneusEstoque = [];
  const erros = [];
  const avisos = [];
  const cacheVeiculo = new Map(); // placa → { id, layout }

  const findVeiculo = db.prepare(`
    SELECT id, placa, layout_pneus, km_atual FROM veiculos
    WHERE placa = ? AND filial_id = ? AND ativo = 1
  `);
  const insertVeiculo = db.prepare(`
    INSERT INTO veiculos (placa, apelido, tipo, marca, modelo, ano, km_atual, hr_atual, observacoes, layout_pneus, filial_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPneuEstoque = db.prepare(`
    INSERT INTO pneus (
      veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, ativo, observacoes
    ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estoque', 1, ?)
  `);
  const insertPneuMontado = db.prepare(`
    INSERT INTO pneus (
      veiculo_id, posicao, filial_id, marca, modelo, medida, dot, numero_fogo,
      tipo_pneu, condicao, vida_recap, sulco_inicial_mm, status_pneu, data_instalacao, km_instalacao, ativo, observacoes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'montado', date('now', 'localtime'), ?, 1, ?)
  `);
  const insertMov = db.prepare(`
    INSERT INTO movimentacoes (pneu_id, veiculo_id, tipo, data_evento, km_veiculo, posicao, detalhes)
    VALUES (?, ?, 'montagem', date('now', 'localtime'), ?, ?, ?)
  `);
  const ocupado = db.prepare(`
    SELECT id, numero_fogo FROM pneus
    WHERE veiculo_id = ? AND posicao = ? AND ativo = 1 AND status_pneu = 'montado'
  `);

  async function garantirVeiculo(raw, linha) {
    const placa = String(raw.placa || '').trim().toUpperCase();
    if (!placa) return null;
    if (cacheVeiculo.has(placa)) return cacheVeiculo.get(placa);

    const existente = await findVeiculo.get(placa, filialId);
    if (existente) {
      const info = { id: existente.id, placa, layout: existente.layout_pneus || LAYOUT_PADRAO, novo: false };
      cacheVeiculo.set(placa, info);
      veiculosReutilizados.push(placa);
      return info;
    }

    const tipo = normalizarTipoVeiculo(raw.tipo_veiculo || raw.tipo) || 'Truck / Tração';
    const layoutId = mapLayoutId(raw.layout_pneus || raw.layout, tipo);
    if (!LAYOUTS_PNEU[layoutId]) {
      erros.push({ linha, placa, erro: `Layout inválido: ${raw.layout_pneus || raw.layout}` });
      return null;
    }

    const km = raw.km_atual !== '' && raw.km_atual != null ? parseInt(raw.km_atual, 10) : 0;
    const hr = raw.hr_atual !== '' && raw.hr_atual != null ? parseFloat(raw.hr_atual) : 0;

    try {
      const info = await comSavepoint(db, async () => {
        const result = await insertVeiculo.run(
          placa,
          String(raw.apelido || '').trim() || null,
          tipo,
          null,
          null,
          null,
          Number.isFinite(km) ? km : 0,
          Number.isFinite(hr) ? hr : 0,
          String(raw.observacoes_veiculo || '').trim() || null,
          layoutId,
          filialId
        );
        await aplicarLayoutPneus(db, result.lastInsertRowid, layoutId, null);
        return { id: result.lastInsertRowid, placa, layout: layoutId, novo: true };
      });
      cacheVeiculo.set(placa, info);
      veiculosCriados.push({ id: info.id, placa, layout: layoutId });
      return info;
    } catch (err) {
      if (ehViolacaoUnique(err)) {
        const again = await findVeiculo.get(placa, filialId);
        if (again) {
          const info = { id: again.id, placa, layout: again.layout_pneus || LAYOUT_PADRAO, novo: false };
          cacheVeiculo.set(placa, info);
          return info;
        }
      }
      erros.push({ linha, placa, erro: err.message });
      return null;
    }
  }

  try {
    await db.transaction(async () => {
      for (const raw of rows) {
        const linha = raw.__linha || '?';
        const fogo = String(raw.numero_fogo || raw.fogo || '').trim();
        const placa = String(raw.placa || '').trim().toUpperCase();
        const posicao = String(raw.posicao || '').trim().toUpperCase();
        const status = mapStatusPneu(raw.status, { placa, posicao });

        // Linha só de veículo (sem pneu): cadastra o caminhão
        if (!fogo) {
          if (!placa) {
            erros.push({ linha, erro: 'Informe placa (veículo) ou numero_fogo (pneu)' });
            continue;
          }
          await garantirVeiculo(raw, linha);
          continue;
        }

        const tipoPneu = mapTipoPneu(raw.tipo_pneu || raw.tipo);
        const condicao = mapCondicao(raw.condicao);
        let vida = raw.vida_recap !== '' && raw.vida_recap != null
          ? parseInt(raw.vida_recap, 10)
          : (condicao === 'recapado' ? 1 : 0);
        if (!Number.isFinite(vida) || vida < 0) vida = 0;
        if (condicao === 'novo') vida = 0;
        const sulco = raw.sulco_inicial_mm !== '' && raw.sulco_inicial_mm != null
          ? parseFloat(String(raw.sulco_inicial_mm).replace(',', '.'))
          : null;
        const marca = String(raw.marca || '').trim() || null;
        const medida = String(raw.medida || '').trim() || null;
        const dot = String(raw.dot || '').trim() || null;
        const obs = String(raw.observacoes || '').trim() || null;

        if (status === 'montado') {
          if (!placa || !posicao) {
            erros.push({
              linha,
              numero_fogo: fogo,
              erro: 'Pneu montado exige placa e posicao (ex.: 1E, 2EE)',
            });
            continue;
          }

          const veiculo = await garantirVeiculo(raw, linha);
          if (!veiculo) continue;

          const layout = getLayout(veiculo.layout);
          if (!layout.posicoes.includes(posicao)) {
            erros.push({
              linha,
              numero_fogo: fogo,
              placa,
              erro: `Posição ${posicao} não existe no layout ${veiculo.layout}`,
            });
            continue;
          }

          const ja = await ocupado.get(veiculo.id, posicao);
          if (ja) {
            erros.push({
              linha,
              numero_fogo: fogo,
              placa,
              erro: `Posição ${posicao} já ocupada pelo fogo ${ja.numero_fogo || ja.id}`,
            });
            continue;
          }

          const validacao = validarMontagem({ condicao, tipo_pneu: tipoPneu, posicao });
          if (validacao.avisos?.length) {
            avisos.push({ linha, numero_fogo: fogo, aviso: validacao.avisos.join(' ') });
          }
          // Na carga inicial, avisos não bloqueiam; erros graves de regra (ex. recap na dianteira) viram aviso
          if (!validacao.ok) {
            avisos.push({ linha, numero_fogo: fogo, aviso: validacao.erros.join(' ') });
          }

          const kmInst = raw.km_atual !== '' && raw.km_atual != null
            ? parseInt(raw.km_atual, 10)
            : 0;

          try {
            const criado = await comSavepoint(db, async () => {
              const result = await insertPneuMontado.run(
                veiculo.id,
                posicao,
                filialId,
                marca,
                null,
                medida,
                dot,
                fogo,
                tipoPneu,
                condicao,
                vida,
                Number.isFinite(sulco) ? sulco : null,
                Number.isFinite(kmInst) ? kmInst : 0,
                obs
              );
              await insertMov.run(
                result.lastInsertRowid,
                veiculo.id,
                Number.isFinite(kmInst) ? kmInst : 0,
                posicao,
                'Carga inicial da frota — pneu já em uso'
              );
              return result;
            });
            pneusMontados.push({ id: criado.lastInsertRowid, numero_fogo: fogo, placa, posicao });
          } catch (err) {
            if (ehViolacaoUnique(err)) {
              erros.push({ linha, numero_fogo: fogo, erro: 'Nº de fogo já existe nesta filial' });
            } else {
              erros.push({ linha, numero_fogo: fogo, erro: err.message });
            }
          }
          continue;
        }

        // Estoque
        try {
          const result = await comSavepoint(db, () => insertPneuEstoque.run(
            filialId,
            marca,
            null,
            medida,
            dot,
            fogo,
            tipoPneu,
            condicao,
            vida,
            Number.isFinite(sulco) ? sulco : null,
            obs
          ));
          pneusEstoque.push({ id: result.lastInsertRowid, numero_fogo: fogo });
        } catch (err) {
          if (ehViolacaoUnique(err)) {
            erros.push({ linha, numero_fogo: fogo, erro: 'Nº de fogo já existe nesta filial' });
          } else {
            erros.push({ linha, numero_fogo: fogo, erro: err.message });
          }
        }
      }
    });
  } catch (err) {
    return next(err);
  }

  const total =
    veiculosCriados.length + pneusMontados.length + pneusEstoque.length;

  if (!total && erros.length) {
    return res.status(400).json({
      erro: 'Nada foi importado',
      veiculos: 0,
      pneus_montados: 0,
      pneus_estoque: 0,
      erros,
      avisos,
    });
  }

  res.status(201).json({
    mensagem: `Carga concluída: ${veiculosCriados.length} veículo(s), ${pneusMontados.length} pneu(s) montado(s), ${pneusEstoque.length} no estoque`,
    veiculos: veiculosCriados.length,
    veiculos_existentes: [...new Set(veiculosReutilizados)].length,
    pneus_montados: pneusMontados.length,
    pneus_estoque: pneusEstoque.length,
    detalhes: { veiculosCriados, pneusMontados, pneusEstoque },
    erros,
    avisos,
  });
});

export default router;
