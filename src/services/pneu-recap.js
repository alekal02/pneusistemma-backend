/**
 * Envio / retorno de recap: painel e chatbot WhatsApp.
 * Ex.: "pneu fogo 08251227 enviado para recap Bandag 26/08/2026"
 */
import { getLimites } from '../limites.js';
import { registrarMovimentacao, atualizarKmHrVeiculo, travarPneu } from './pneu-movimentacao.js';
import { capturarVagaDoPneu, abrirAlertaPosicaoVaga } from './alerta-posicao-vaga.js';

export const AJUDA_RECAP = [
  '*Enviar pneu para recap*',
  'pneu fogo 08251227 enviado para recap Bandag 26/08/2026',
  '',
  'Ou: *recap 08251227 Bandag 26/08/2026*',
  '',
  '*Receber da recap:*',
  'receber recap 08251227',
].join('\n');

function recapErro(mensagem, status = 400) {
  const err = new Error(mensagem);
  err.status = status;
  return err;
}

export function hojeISOBrasil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

export function parseDataEvento(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  let y;
  let m;
  let d;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    [, y, m, d] = iso;
  } else {
    const br = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!br) return null;
    d = br[1].padStart(2, '0');
    m = br[2].padStart(2, '0');
    y = br[3].length === 2 ? `20${br[3]}` : br[3];
  }
  const dt = new Date(`${y}-${m}-${d}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getFullYear() !== Number(y) || dt.getMonth() + 1 !== Number(m) || dt.getDate() !== Number(d)) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

export function formatarDataBr(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}/${m}/${y}`;
}

export function montarDetalhesEnviarRecap({ fogo, fornecedor, dataIso, extra } = {}) {
  const dataBr = formatarDataBr(dataIso);
  let s = `Pneu fogo ${fogo || '—'} enviado para recap`;
  if (fornecedor) s += ` ${fornecedor}`;
  if (dataBr) s += ` ${dataBr}`;
  if (extra) s += ` — ${extra}`;
  return s;
}

export function montarDetalhesReceberRecap({ fogo, fornecedor, dataIso, vida } = {}) {
  const dataBr = formatarDataBr(dataIso);
  let s = `Pneu fogo ${fogo || '—'} recebido da recap`;
  if (fornecedor) s += ` ${fornecedor}`;
  if (dataBr) s += ` ${dataBr}`;
  if (vida != null) s += ` — ${vida}ª vida`;
  return s;
}

function textoComando(texto) {
  return String(texto || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/** Detecta comando de recap no WhatsApp. Null = não é recap. */
export function parseComandoRecap(texto) {
  const raw = String(texto || '').trim();
  if (!raw) return null;
  const lower = textoComando(raw);

  if (/^(frota|placas|lista|ajuda|help|menu|relatorio|report|pdf)\b/.test(lower)) {
    return null;
  }

  const soAjuda = /^(recap|recapagem)$/.test(lower);
  if (soAjuda) {
    return { tipo: 'ajuda' };
  }

  const receber = /^(receber|recebido|pronto)\s+(recap|recapagem)\b/.test(lower)
    || /^(recap|recapagem)\s+(pronto|recebido|receber)\b/.test(lower);
  const enviar = !receber && (
    /\benviad[oa]\s+para\s+recap/.test(lower)
    || /\benviar\s+(para\s+)?recap/.test(lower)
    || /^(recap|recapagem)\b/.test(lower)
    || /\bpneu\b.+\brecap/.test(lower)
  );
  if (!enviar && !receber) return null;

  let dataIso = null;
  const dateMatch = raw.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch) {
    dataIso = parseDataEvento(dateMatch[1]);
  }

  let fogo = null;
  const fogoNamed = raw.match(/\bfogo\s*[:#-]?\s*([A-Za-z0-9]{3,})\b/i);
  if (fogoNamed) fogo = fogoNamed[1];
  if (!fogo) {
    const tokens = raw.split(/\s+/);
    for (const t of tokens) {
      const clean = t.replace(/[^A-Za-z0-9]/g, '');
      if (!/^[A-Za-z0-9]{4,}$/.test(clean)) continue;
      if (dateMatch && dateMatch[0].includes(t)) continue;
      if (/^(recap|recapagem|pneu|fogo|enviar|enviado|enviada|para|receber|recebido|pronto)$/i.test(clean)) {
        continue;
      }
      fogo = clean;
      break;
    }
  }

  if (!fogo) {
    return {
      tipo: receber ? 'receber' : 'enviar',
      fogo: null,
      erro: 'Informe o nº de fogo. Ex.: recap 08251227 Bandag 26/08/2026',
    };
  }

  if (receber) {
    return { tipo: 'receber', fogo, data: dataIso };
  }

  let rest = raw;
  rest = rest.replace(/\bfogo\s*[:#-]?\s*[A-Za-z0-9]+\b/ig, ' ');
  rest = rest.replace(new RegExp(fogo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  if (dateMatch) rest = rest.replace(dateMatch[0], ' ');
  rest = rest.replace(
    /\b(pneu|enviado|enviada|enviar|para|recap|recapagem)\b/ig,
    ' '
  );
  const fornecedor = rest.replace(/\s+/g, ' ').trim();
  if (!fornecedor) {
    return {
      tipo: 'enviar',
      fogo,
      data: dataIso,
      erro: `Informe o fornecedor. Ex.: recap ${fogo} Bandag 26/08/2026`,
    };
  }

  return { tipo: 'enviar', fogo, fornecedor, data: dataIso };
}

export async function buscarPneuPorFogo(db, filialId, fogo) {
  const n = String(fogo || '').trim();
  if (!n || !filialId) return null;
  const exact = await db.prepare(`
    SELECT * FROM pneus
    WHERE filial_id = ? AND ativo = 1 AND numero_fogo = ?
    LIMIT 1
  `).get(filialId, n);
  if (exact) return exact;
  return db.prepare(`
    SELECT * FROM pneus
    WHERE filial_id = ? AND ativo = 1
      AND LOWER(TRIM(numero_fogo)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(filialId, n);
}

async function veiculoDoPneu(db, pneu) {
  if (!pneu?.veiculo_id) return null;
  return db.prepare('SELECT * FROM veiculos WHERE id = ?').get(pneu.veiculo_id);
}

export async function enviarPneuParaRecap(db, {
  pneu,
  filialId,
  fornecedor,
  data,
  km_veiculo = null,
  hr_veiculo = null,
  sulco_mm = null,
  detalhesExtra = null,
}) {
  const fornecedorLimpo = String(fornecedor || '').trim();
  if (!fornecedorLimpo) {
    throw recapErro('Informe o fornecedor da recap');
  }
  if (!pneu) throw recapErro('Pneu não encontrado', 404);
  if (pneu.status_pneu === 'descarte' || pneu.ativo === 0) {
    throw recapErro('Pneu em descarte não pode ir para recap');
  }
  if (pneu.status_pneu === 'recapagem') {
    throw recapErro(
      `Este pneu já está em recapagem${pneu.recap_fornecedor ? ` (${pneu.recap_fornecedor})` : ''}`
    );
  }

  const limites = getLimites();
  const vidaAtual = pneu.vida_recap || 0;
  if (vidaAtual >= (limites.max_recaps || 6)) {
    throw recapErro(`Limite de recaps atingido (${limites.max_recaps}). Indique troca/descarte.`);
  }

  const dataIso = parseDataEvento(data) || hojeISOBrasil();
  const detalhes = montarDetalhesEnviarRecap({
    fogo: pneu.numero_fogo,
    fornecedor: fornecedorLimpo,
    dataIso,
    extra: detalhesExtra,
  });
  const vaga = await capturarVagaDoPneu(db, pneu);

  await db.transaction(async () => {
    const locked = await travarPneu(db, pneu.id);
    if (!locked || locked.status_pneu === 'recapagem' || locked.status_pneu === 'descarte' || locked.ativo === 0) {
      throw recapErro(
        locked?.status_pneu === 'descarte' || locked?.ativo === 0
          ? 'Pneu em descarte não pode ir para recap'
          : 'Este pneu já está em recapagem'
      );
    }
    const veiculo = await veiculoDoPneu(db, locked);
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : (veiculo?.km_atual ?? null);
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : (veiculo?.hr_atual ?? null);

    if (locked.status_pneu === 'montado' && locked.veiculo_id) {
      await registrarMovimentacao(db, {
        pneuId: locked.id,
        veiculoId: locked.veiculo_id,
        tipo: 'retirada',
        data: dataIso,
        km,
        hr,
        posicao: locked.posicao,
        detalhes: 'Retirou para enviar à recap',
        placa: veiculo?.placa || null,
        apelido: veiculo?.apelido || null,
        ciclo: locked.vida_recap || 0,
      });
      await atualizarKmHrVeiculo(db, locked.veiculo_id, filialId, km, hr);
    }

    await registrarMovimentacao(db, {
      pneuId: locked.id,
      veiculoId: locked.veiculo_id || null,
      tipo: 'enviar_recap',
      data: dataIso,
      km,
      hr,
      posicao: locked.posicao || null,
      sulcoMm: sulco_mm != null ? parseFloat(sulco_mm) : null,
      sulcoAntes: sulco_mm != null ? parseFloat(sulco_mm) : null,
      detalhes,
      placa: veiculo?.placa || null,
      apelido: veiculo?.apelido || null,
      ciclo: locked.vida_recap || 0,
    });

    await db.prepare(`
      UPDATE pneus SET
        status_pneu = 'recapagem',
        veiculo_id = NULL,
        posicao = NULL,
        data_instalacao = NULL,
        recap_fornecedor = ?,
        recap_enviado_em = ?,
        data_alerta_monitorar = NULL
      WHERE id = ?
    `).run(fornecedorLimpo, dataIso, pneu.id);
  });

  const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);
  if (vaga) {
    await abrirAlertaPosicaoVaga(db, {
      filialId: vaga.filialId,
      veiculoId: vaga.veiculoId,
      posicao: vaga.posicao,
      motivo: 'recap',
      pneuId: vaga.pneuId,
      numeroFogo: vaga.numeroFogo,
      detalhes,
    });
  }
  return {
    mensagem: detalhes,
    pneu: atualizado,
    vaga,
  };
}

export async function receberRecapPneu(db, {
  pneu,
  filialId,
  data,
  km_veiculo = null,
  hr_veiculo = null,
  sulco_mm = null,
  detalhesExtra = null,
}) {
  if (!pneu) throw recapErro('Pneu não encontrado', 404);
  if (pneu.status_pneu === 'descarte' || pneu.ativo === 0) {
    throw recapErro('Pneu em descarte não recebe recap');
  }
  if (pneu.status_pneu !== 'recapagem') {
    throw recapErro(
      `Este pneu não está em recapagem. Envie primeiro: recap ${pneu.numero_fogo || ''} Fornecedor 26/08/2026`
    );
  }

  const limites = getLimites();
  const novaVida = (pneu.vida_recap || 0) + 1;
  if (novaVida > (limites.max_recaps || 6)) {
    throw recapErro(`Limite de recaps atingido (${limites.max_recaps}). Indique troca/descarte.`);
  }

  const dataIso = parseDataEvento(data) || hojeISOBrasil();
  const fornecedor = pneu.recap_fornecedor || null;
  const detalhes = [
    montarDetalhesReceberRecap({
      fogo: pneu.numero_fogo,
      fornecedor,
      dataIso,
      vida: novaVida,
    }),
    detalhesExtra,
  ].filter(Boolean).join(' — ');

  await db.transaction(async () => {
    const locked = await travarPneu(db, pneu.id);
    if (!locked || locked.status_pneu !== 'recapagem') {
      throw recapErro('Este pneu não está em recapagem');
    }
    const vidaNova = (locked.vida_recap || 0) + 1;
    if (vidaNova > (limites.max_recaps || 6)) {
      throw recapErro(`Limite de recaps atingido (${limites.max_recaps}). Indique troca/descarte.`);
    }
    const veiculo = await veiculoDoPneu(db, locked);
    const km = km_veiculo != null ? parseInt(km_veiculo, 10) : (veiculo?.km_atual ?? null);
    const hr = hr_veiculo != null ? parseFloat(hr_veiculo) : (veiculo?.hr_atual ?? null);
    const sulcoInformado = sulco_mm != null && sulco_mm !== '' ? parseFloat(sulco_mm) : null;

    await registrarMovimentacao(db, {
      pneuId: locked.id,
      veiculoId: locked.veiculo_id || null,
      tipo: 'recap',
      data: dataIso,
      km,
      hr,
      posicao: locked.posicao || null,
      sulcoMm: Number.isFinite(sulcoInformado) ? sulcoInformado : null,
      sulcoDepois: Number.isFinite(sulcoInformado) ? sulcoInformado : null,
      detalhes,
      placa: veiculo?.placa || null,
      apelido: veiculo?.apelido || null,
      ciclo: vidaNova,
    });

    await db.prepare(`
      UPDATE pneus SET
        vida_recap = ?,
        condicao = 'recapado',
        status_pneu = 'estoque',
        veiculo_id = NULL,
        posicao = NULL,
        sulco_inicial_mm = COALESCE(?, sulco_inicial_mm),
        data_instalacao = NULL,
        km_instalacao = COALESCE(?, km_instalacao),
        data_alerta_monitorar = NULL,
        recap_fornecedor = NULL,
        recap_enviado_em = NULL
      WHERE id = ? AND status_pneu = 'recapagem'
    `).run(
      vidaNova,
      Number.isFinite(sulcoInformado) ? sulcoInformado : null,
      km_veiculo != null ? parseInt(km_veiculo, 10) : null,
      locked.id
    );
  });

  const atualizado = await db.prepare('SELECT * FROM pneus WHERE id = ?').get(pneu.id);
  return {
    mensagem: detalhes,
    pneu: atualizado,
  };
}
