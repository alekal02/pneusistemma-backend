/**
 * Catálogo central de tipos de equipamento.
 * Fonte das regras (layout, unidade, perfil). Frontend consome GET /veiculos/meta.
 */

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Ordem de UI: tipos novos primeiro, depois legados de frota rodoviária. */
export const EQUIPAMENTO_TIPOS = [
  {
    codigo: 'compactador',
    label: 'Compactador',
    familia: 'rodoviario',
    unidade_uso: 'km',
    layout_padrao: 'compactador',
    layouts_permitidos: ['compactador'],
    perfil_medicao: 'caminhao',
    permite_recap: true,
    legado: false,
  },
  {
    codigo: 'mini_carregadeira',
    label: 'Mini carregadeira',
    familia: 'industrial',
    unidade_uso: 'horas',
    layout_padrao: 'skid_4',
    layouts_permitidos: ['skid_4'],
    perfil_medicao: 'industrial',
    permite_recap: false,
    legado: false,
  },
  {
    codigo: 'trator',
    label: 'Trator',
    familia: 'agricola',
    unidade_uso: 'horas',
    layout_padrao: 'trator_4',
    layouts_permitidos: ['trator_4'],
    perfil_medicao: 'trator',
    permite_recap: false,
    legado: false,
  },
  {
    codigo: 'giro_zero',
    label: 'Giro zero',
    familia: 'industrial',
    unidade_uso: 'horas',
    layout_padrao: 'giro_4',
    layouts_permitidos: ['giro_4'],
    perfil_medicao: 'industrial',
    permite_recap: false,
    legado: false,
  },
  {
    codigo: 'truck_tracao',
    label: 'Truck / Tração',
    familia: 'rodoviario',
    unidade_uso: 'km',
    layout_padrao: 'truck_10',
    layouts_permitidos: ['truck_10', 'truck_8', 'truck_8_b'],
    perfil_medicao: 'caminhao',
    permite_recap: true,
    legado: true,
  },
  {
    codigo: 'toco_mini',
    label: 'Toco / Mini',
    familia: 'rodoviario',
    unidade_uso: 'km',
    layout_padrao: 'toco_6',
    layouts_permitidos: ['toco_6'],
    perfil_medicao: 'caminhao',
    permite_recap: true,
    legado: true,
  },
  {
    codigo: 'utilitario',
    label: 'Utilitário / Varredeira',
    familia: 'rodoviario',
    unidade_uso: 'km',
    layout_padrao: 'utilitario_4',
    layouts_permitidos: ['utilitario_4'],
    perfil_medicao: 'caminhao',
    permite_recap: true,
    legado: true,
  },
  {
    codigo: 'outros',
    label: 'Outros',
    familia: 'outro',
    unidade_uso: 'km',
    layout_padrao: 'truck_10',
    layouts_permitidos: ['truck_10', 'truck_8', 'truck_8_b', 'toco_6', 'compactador', 'utilitario_4', 'trator_4'],
    perfil_medicao: 'caminhao',
    permite_recap: true,
    legado: false,
  },
];

const POR_CODIGO = new Map(EQUIPAMENTO_TIPOS.map((t) => [t.codigo, t]));

const ALIASES = {
  compactador: ['compactador', 'caminhao compactador', 'caminh compactador'],
  mini_carregadeira: ['mini carregadeira', 'mini-carregadeira', 'minicarregadeira', 'skid', 'skid steer', 'bobcat'],
  trator: ['trator', 'trator agricola'],
  giro_zero: ['giro zero', 'giro-zero', 'girozero', 'zero turn', 'zeroturn'],
  truck_tracao: ['truck / tracao', 'truck', 'truck / tração', 'truck tracao'],
  toco_mini: ['toco / mini', 'toco', 'toco/mini', 'toco mini'],
  utilitario: ['utilitario / varredeira', 'utilitario', 'varredeira'],
  outros: ['outros', 'outro'],
};

/** Labels para dropdowns (compatível com TIPOS_VEICULO antigo). */
export const TIPOS_VEICULO = EQUIPAMENTO_TIPOS.map((t) => t.label);

export function listarTiposEquipamento() {
  return EQUIPAMENTO_TIPOS.map((t) => ({ ...t, layouts_permitidos: [...t.layouts_permitidos] }));
}

export function getTipoEquipamento(codigo) {
  return POR_CODIGO.get(String(codigo || '').trim()) || null;
}

/**
 * Resolve tipo por codigo, label ou alias.
 * "mini" sozinho NÃO vira Toco. Mini carregadeira exige "carreg" / skid / bobcat.
 */
export function resolverTipoEquipamento(tipoOuCodigo) {
  const raw = String(tipoOuCodigo || '').trim();
  if (!raw) return null;
  const byCodigo = POR_CODIGO.get(raw);
  if (byCodigo) return byCodigo;

  const n = norm(raw);
  const byLabel = EQUIPAMENTO_TIPOS.find((t) => norm(t.label) === n);
  if (byLabel) return byLabel;

  if (n.includes('mini') && (n.includes('carreg') || n.includes('skid') || n.includes('bobcat'))) {
    return POR_CODIGO.get('mini_carregadeira');
  }
  if (n.includes('giro') && n.includes('zero')) return POR_CODIGO.get('giro_zero');
  if (n.includes('compactador')) return POR_CODIGO.get('compactador');
  if (/\btrator\b/.test(n) || n.startsWith('trator')) return POR_CODIGO.get('trator');
  if (n.includes('toco')) return POR_CODIGO.get('toco_mini');
  if (n.includes('utilit') || n.includes('varred')) return POR_CODIGO.get('utilitario');
  if (n.includes('truck') || (n.includes('caminh') && n.includes('trac'))) {
    return POR_CODIGO.get('truck_tracao');
  }
  if (n === 'outros' || n === 'outro') return POR_CODIGO.get('outros');

  for (const [codigo, lista] of Object.entries(ALIASES)) {
    if (lista.some((a) => n === a || n.includes(a))) return POR_CODIGO.get(codigo);
  }
  return null;
}

export function labelTipoEquipamento(tipoOuCodigo) {
  return resolverTipoEquipamento(tipoOuCodigo)?.label || null;
}

export function codigoTipoEquipamento(tipoOuCodigo) {
  return resolverTipoEquipamento(tipoOuCodigo)?.codigo || null;
}

export function layoutPadraoDoCatalogo(tipoOuCodigo) {
  return resolverTipoEquipamento(tipoOuCodigo)?.layout_padrao || 'truck_10';
}

export function perfilMedicaoDoCatalogo(tipoOuCodigo) {
  return resolverTipoEquipamento(tipoOuCodigo)?.perfil_medicao || null;
}

/** Label + codigo para INSERT/UPDATE. coluna `tipo` legado permanece preenchida. */
export function camposTipoVeiculo(tipoOuCodigo, fallbackLabel = 'Truck / Tração') {
  const resolved = resolverTipoEquipamento(tipoOuCodigo);
  const bruto = tipoOuCodigo != null ? String(tipoOuCodigo).trim() : '';
  return {
    tipo: resolved?.label || bruto || fallbackLabel,
    tipo_codigo: resolved?.codigo || null,
  };
}

export function metaTiposEquipamento() {
  const tipos = listarTiposEquipamento();
  const layout_padrao_por_tipo = {};
  for (const t of tipos) layout_padrao_por_tipo[t.label] = t.layout_padrao;
  return {
    tipos: tipos.map((t) => t.label),
    tipos_equipamento: tipos,
    layout_padrao_por_tipo,
  };
}

/**
 * Código só quando o texto gravado é o código, o rótulo ou um alias exato.
 * "Truckado" não entra: o relatório geral inclui o registro sem regravar tipo_codigo.
 */
export function codigoTipoExato(tipo) {
  const raw = String(tipo || '').trim();
  if (!raw) return null;
  if (POR_CODIGO.has(raw)) return raw;
  const n = norm(raw);
  const byLabel = EQUIPAMENTO_TIPOS.find((t) => norm(t.label) === n);
  if (byLabel) return byLabel.codigo;
  for (const [codigo, lista] of Object.entries(ALIASES)) {
    if (lista.some((a) => n === norm(a))) return codigo;
  }
  return null;
}

/**
 * Preenche tipo_codigo só onde está vazio e o texto já é um tipo exato do catálogo.
 * Não altera label, layout, medições nem histórico. Não reclassifica "Truckado".
 */
export async function backfillTipoCodigoVeiculos(db) {
  const rows = await db.prepare(`
    SELECT id, tipo FROM veiculos
    WHERE tipo_codigo IS NULL OR tipo_codigo = ''
  `).all();
  const upd = db.prepare(`
    UPDATE veiculos SET tipo_codigo = ?
    WHERE id = ? AND (tipo_codigo IS NULL OR tipo_codigo = '')
  `);
  let n = 0;
  for (const row of rows) {
    const codigo = codigoTipoExato(row.tipo);
    if (!codigo) continue;
    const result = await upd.run(codigo, row.id);
    n += result.changes || 0;
  }
  if (n) console.log(`[migrate] tipo_codigo preenchido em ${n} veículo(s)`);
  return n;
}

export async function seedEquipamentoTipos(db) {
  const upsert = db.prepare(`
    INSERT INTO equipamento_tipos (
      codigo, label, familia, unidade_uso, layout_padrao, layouts_permitidos,
      perfil_medicao, permite_recap, legado, ativo
    ) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, 1)
    ON CONFLICT (codigo) DO UPDATE SET
      label = EXCLUDED.label,
      familia = EXCLUDED.familia,
      unidade_uso = EXCLUDED.unidade_uso,
      layout_padrao = EXCLUDED.layout_padrao,
      layouts_permitidos = EXCLUDED.layouts_permitidos,
      perfil_medicao = EXCLUDED.perfil_medicao,
      permite_recap = EXCLUDED.permite_recap,
      legado = EXCLUDED.legado,
      ativo = 1
  `);
  for (const t of EQUIPAMENTO_TIPOS) {
    await upsert.run(
      t.codigo,
      t.label,
      t.familia,
      t.unidade_uso,
      t.layout_padrao,
      JSON.stringify(t.layouts_permitidos),
      t.perfil_medicao,
      t.permite_recap ? 1 : 0,
      t.legado ? 1 : 0,
    );
  }
}
