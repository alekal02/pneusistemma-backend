/**
 * Comandos naturais do WhatsApp (sem menu).
 * Não grava nada — só interpreta o texto.
 */
import { POSICOES_PNEU } from '../pneus-layouts.js';

const POSICOES_CONHECIDAS = new Set(Object.keys(POSICOES_PNEU).map((p) => p.toUpperCase()));
function norm(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
}

const RE_DESC = /^(descarte|descartar|descarta|lixo|sucata|sucatear|desc)$/;
const RE_RECAP = /^(recap|recapagem|recapar|recape|recapeamento|rec)$/;
const RE_EST = /^(estoque|stock|desmontar|desmonta|estq|est)$/;
const RE_ONDE = /^(onde|localizar|localiza|achar|acha|encontrar|cad[eê]|status|situacao)$/;
const RE_TROCA = /^(trocar|troca|substituir|substitui|subst)$/;
const RE_CAD = /^(cadastrar|cadastro|cadastre|cadastra|cad)$/;
const RE_PNEU = /^(pneu|pneus|tire)$/;
const RE_LIXO = /^(pneu|por|pelo|pela|pro|pra|para|ao|a|o|um|uma|do|da|de|no|na|com|em|este|essa|esse|foi|vai|enviar|envie|manda|mandar|o|os)$/;

const TIPOS_CADASTRO_VEICULO = [
  [/^(caminhao|truck|tracao)$/, 'Truck / Tração'],
  [/^(trator|tratores)$/, 'Trator'],
  [/^(toco|mini)$/, 'Toco / Mini'],
  [/^(compactador|compactadora)$/, 'Compactador'],
  [/^(utilitario|varredeira)$/, 'Utilitário / Varredeira'],
  [/^(veiculo|veiculos)$/, null],
];

function parseCadastrar(parts) {
  const iCad = parts.findIndex((p) => RE_CAD.test(p));
  const semCad = parts.filter((_, i) => i !== iCad);
  const iPneu = semCad.findIndex((p) => RE_PNEU.test(p));
  if (iPneu >= 0) {
    const resto = semCad.filter((_, i) => i !== iPneu);
    const fogos = fogosDe(resto);
    return { tipo: 'cadastrar_pneu', fogo: fogos[0] || null };
  }

  let tipoVeiculo;
  let iTipo = -1;
  for (let i = 0; i < semCad.length; i += 1) {
    for (const [re, tipo] of TIPOS_CADASTRO_VEICULO) {
      if (re.test(semCad[i])) {
        tipoVeiculo = tipo;
        iTipo = i;
        break;
      }
    }
    if (iTipo >= 0) break;
  }

  const placaParts = semCad.filter((_, i) => i !== iTipo);
  const placa = placaParts.join('') || null;
  return {
    tipo: 'cadastrar_veiculo',
    placa: placa && /[0-9]/.test(placa) ? placa.toUpperCase() : null,
    tipoVeiculo: tipoVeiculo === undefined ? null : tipoVeiculo,
  };
}

function pareceTokenFogo(t) {
  const s = String(t || '').trim();
  if (!s || s.length < 2 || s.length > 24) return false;
  if (!/[0-9]/.test(s)) return false;
  if (!/^[a-z0-9][a-z0-9\-_./]*$/i.test(s)) return false;
  if (/^[0-9]+$/.test(s) && s.length < 3) return false;
  if (RE_DESC.test(s) || RE_RECAP.test(s) || RE_EST.test(s) || RE_ONDE.test(s) || RE_TROCA.test(s)) {
    return false;
  }
  if (RE_LIXO.test(s)) return false;
  return true;
}

function tokensDe(texto) {
  const n = norm(texto)
    .replace(/[^\p{L}\p{N}\-_./]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n ? n.split(' ') : [];
}

function fogosDe(parts) {
  return parts.filter((p) => pareceTokenFogo(p));
}

/**
 * @returns {{ tipo: string, fogo?: string, fogo2?: string, placa?: string|null, tipoVeiculo?: string|null } | null}
 */
export function parseComandoNatural(texto) {
  const parts = tokensDe(texto);
  if (!parts.length) return null;

  if (parts.some((p) => RE_CAD.test(p))) {
    return parseCadastrar(parts);
  }

  if (parts.length < 2) return null;

  const fogos = fogosDe(parts);
  const iTroca = parts.findIndex((p) => RE_TROCA.test(p));
  const iPor = parts.findIndex((p) => p === 'por' || p === 'pelo' || p === 'pela');

  if (iTroca >= 0 && fogos.length >= 2) {
    return { tipo: 'troca', fogo: fogos[0], fogo2: fogos[1] };
  }
  if (iTroca >= 0 && fogos.length === 1) {
    return { tipo: 'troca', fogo: fogos[0] };
  }
  if (iPor > 0 && iTroca >= 0 && pareceTokenFogo(parts[iPor - 1]) && pareceTokenFogo(parts[iPor + 1])) {
    return { tipo: 'troca', fogo: parts[iPor - 1], fogo2: parts[iPor + 1] };
  }

  if (!fogos.length) return null;

  if (parts.some((p) => RE_ONDE.test(p))) {
    return { tipo: 'onde', fogo: fogos[0] };
  }
  if (parts.some((p) => RE_DESC.test(p))) {
    return { tipo: 'descarte', fogo: fogos[0] };
  }
  if (parts.some((p) => RE_RECAP.test(p))) {
    return { tipo: 'recap', fogo: fogos[0] };
  }
  if (parts.some((p) => RE_EST.test(p))) {
    return { tipo: 'estoque', fogo: fogos[0] };
  }
  return null;
}

export function pareceComandoNatural(texto) {
  return parseComandoNatural(texto) != null;
}

/**
 * Consultas de leitura. Não interpreta "estoque FOGO" (isso continua sendo movimentação).
 * @returns {{ tipo: 'estoque'|'placa'|'fogo', busca?: string|null, placa?: string, fogo?: string } | null}
 */
export function parseConsultaWhatsApp(texto) {
  const n = norm(texto);
  if (!n) return null;
  if (/^(estoque|estoques)$/.test(n)) return { tipo: 'estoque', busca: null };
  let m = n.match(/^(?:consultar|consulta|listar|ver)\s+estoque(?:\s+(.+))?$/);
  if (m) return { tipo: 'estoque', busca: (m[1] || '').trim() || null };
  m = n.match(/^(?:consultar|consulta|ver)\s+(?:a\s+)?placa\s+([a-z0-9-]{3,12})$/);
  if (m) return { tipo: 'placa', placa: m[1] };
  m = n.match(/^(?:consultar|consulta|ver)\s+fogo\s+([a-z0-9][a-z0-9\-_./]{1,23})$/);
  if (m) return { tipo: 'fogo', fogo: m[1] };
  m = n.match(/^(?:consultar|consulta|ver)\s+([a-z0-9][a-z0-9\-_./]{2,23})$/);
  if (m) {
    const tok = m[1];
    if (tok.includes('-') || tok.length > 8) return { tipo: 'fogo', fogo: tok };
    return { tipo: 'placa', placa: tok };
  }
  return null;
}

function parseNumeroSulco(token) {
  const t = String(token || '').trim();
  if (!t) return NaN;
  if (/^\d+,\d+$/.test(t)) return Number(t.replace(',', '.'));
  if (/^\d+([.]\d+)?$/.test(t)) return Number(t);
  return NaN;
}

/** Vírgula só é decimal com `;` `/` ou espaço: 14,5;14,5;14,5 ou 14,5 14,5 14,5. */
export function parseValoresSulco(bruto) {
  const raw = String(bruto || '').trim();
  if (!raw) return [];
  if (/[;/]/.test(raw)) {
    return raw.split(/[;/]/).map((p) => parseNumeroSulco(p));
  }
  if (/\s/.test(raw)) {
    const nums = raw.split(/\s+/).map((p) => parseNumeroSulco(p));
    if (nums.length >= 3 && nums.every(Number.isFinite)) return nums;
  }
  if (raw.includes('.')) {
    return raw.split(',').map((p) => Number(String(p).trim()));
  }
  const partes = raw.split(',').map((p) => String(p).trim()).filter(Boolean);
  if (partes.every((p) => /^\d+$/.test(p))) return partes.map(Number);
  return partes.map((p) => parseNumeroSulco(p));
}

export function parseKmWhatsApp(texto) {
  const lines = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(?:km|quilometragem)\s*[:=]?\s*(\d{1,8})$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * @returns {{ posicao: string, valores: number[]|null, erro?: string } | null}
 */
export function parseLinhaMedicao(linha) {
  const t = String(linha || '').trim();
  if (!t) return null;
  const m = t.match(/^([A-Za-z0-9]{1,8})\s*[:\-.]?\s+(.+)$/);
  if (!m) return null;
  const posicao = m[1].toUpperCase();
  if (/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(posicao)) return null;
  const parecePos = POSICOES_CONHECIDAS.has(posicao)
    || /^[0-9][A-Z]{1,3}$/.test(posicao)
    || /^E[0-9][A-Z]{1,2}$/.test(posicao);
  if (!parecePos) return null;
  const valores = parseValoresSulco(m[2]);
  if (!POSICOES_CONHECIDAS.has(posicao)) {
    return { posicao, valores, erro: 'posicao_desconhecida' };
  }
  if (!valores.length || valores.some((v) => !Number.isFinite(v))) {
    return { posicao, valores: null, erro: 'valores_invalidos' };
  }
  if (valores.length !== 3 && valores.length !== 4) {
    return { posicao, valores, erro: 'qtd_valores' };
  }
  return { posicao, valores };
}

function parecePlacaLinha(texto) {
  const p = String(texto || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (p.length < 3 || p.length > 10) return false;
  if (!/[A-Z]/.test(p) || !/[0-9]/.test(p)) return false;
  if (/^[0-9]+$/.test(p)) return false;
  return true;
}

function tokenPosicao(tok) {
  const posicao = String(tok || '').toUpperCase().replace(/[:.\-]+$/g, '');
  if (!/^[A-Z0-9]{1,8}$/.test(posicao)) return null;
  if (/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(posicao)) return null;
  const parece = POSICOES_CONHECIDAS.has(posicao)
    || /^[0-9][A-Z]{1,3}$/.test(posicao)
    || /^E[0-9][A-Z]{1,2}$/.test(posicao);
  return parece ? posicao : null;
}

function tokenGrupoSulco(tok) {
  return /^(\d{1,2}([.,]\d+)?)([,;/](\d{1,2}([.,]\d+)?)){2,3}$/.test(String(tok || ''));
}

function tokenNumeroSulco(tok) {
  return Number.isFinite(parseNumeroSulco(tok));
}

function tokenPlaca(tok) {
  if (tokenPosicao(tok)) return false;
  return parecePlacaLinha(tok);
}

/**
 * Quebra "ABC1D23 1E 14 14 14 1D 12 12 12" em linhas que o parser atual já valida.
 * Número de sulco não abre posição. Linha já no formato antigo permanece igual.
 * @returns {string[] | null}
 */
function expandirLinhaMedicao(line) {
  const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const posicoes = tokens.map((t) => tokenPosicao(t)).filter(Boolean);
  if (!posicoes.length) return null;
  const soUmaPosicaoNoInicio = Boolean(tokenPosicao(tokens[0]))
    && posicoes.length === 1
    && tokens.slice(1).every((t) => tokenNumeroSulco(t) || tokenGrupoSulco(t));
  if (soUmaPosicaoNoInicio) return null;

  const blocos = [];
  let i = 0;
  while (i < tokens.length) {
    if (/^(?:km|quilometragem)$/i.test(tokens[i]) && /^\d{1,8}$/.test(tokens[i + 1] || '')) {
      blocos.push(`KM ${tokens[i + 1]}`);
      i += 2;
      continue;
    }
    const pos = tokenPosicao(tokens[i]);
    if (pos) {
      i += 1;
      const vals = [];
      while (
        i < tokens.length
        && !tokenPosicao(tokens[i])
        && !tokenPlaca(tokens[i])
        && !/^(?:km|quilometragem)$/i.test(tokens[i])
      ) {
        if (!(tokenNumeroSulco(tokens[i]) || tokenGrupoSulco(tokens[i]))) return null;
        vals.push(tokens[i]);
        i += 1;
        if (tokenGrupoSulco(vals[vals.length - 1])) break;
      }
      blocos.push(`${pos} ${vals.join(' ')}`.trim());
      continue;
    }
    if (tokenPlaca(tokens[i])) {
      blocos.push(String(tokens[i]).replace(/[^A-Za-z0-9-]/g, '').toUpperCase());
      i += 1;
      continue;
    }
    return null;
  }
  return blocos.length ? blocos : null;
}

/**
 * Placa + linhas `1E 14,14,14` (3 ou 4 valores), também numa linha só.
 * @returns {{ tipo: 'medir', placa: string|null, linhas: object[] } | null}
 */
export function parseMedicaoWhatsApp(texto) {
  const lines = [];
  for (const raw of String(texto || '').split(/\r?\n/)) {
    const linha = raw.trim();
    if (!linha) continue;
    const exp = expandirLinhaMedicao(linha);
    if (exp) lines.push(...exp);
    else lines.push(linha);
  }
  if (!lines.length) return null;

  let placa = null;
  let km = null;
  const linhas = [];
  for (const line of lines) {
    const kmLinha = parseKmWhatsApp(line);
    if (kmLinha != null) {
      km = kmLinha;
      continue;
    }
    const med = parseLinhaMedicao(line);
    if (med) {
      linhas.push(med);
      continue;
    }
    if (!placa && parecePlacaLinha(line)) {
      placa = String(line).replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
    }
  }
  if (!linhas.length) return null;
  return { tipo: 'medir', placa, linhas, km };
}

export function pareceMedicaoWhatsApp(texto) {
  return parseMedicaoWhatsApp(texto) != null;
}
