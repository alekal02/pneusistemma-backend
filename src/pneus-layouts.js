/** Posições, papéis (direcional/tração) e layouts Truck / Toco / frota */

export const POSICOES_PNEU = {
  // Nomenclatura operacional (folhas de cadastro)
  '1E': 'Eixo 1 Esquerdo (dianteiro)',
  '1D': 'Eixo 1 Direito (dianteiro)',
  '2E': 'Eixo 2 Esquerdo (simples)',
  '2D': 'Eixo 2 Direito (simples)',
  '2EE': 'Eixo 2 Esq. Externo',
  '2EI': 'Eixo 2 Esq. Interno',
  '2DI': 'Eixo 2 Dir. Interno',
  '2DE': 'Eixo 2 Dir. Externo',
  '3E': 'Eixo 3 Esquerdo (simples)',
  '3D': 'Eixo 3 Direito (simples)',
  '3EE': 'Eixo 3 Esq. Externo',
  '3EI': 'Eixo 3 Esq. Interno',
  '3DI': 'Eixo 3 Dir. Interno',
  '3DE': 'Eixo 3 Dir. Externo',

  // Legado / frota urbana
  DD: 'Dianteiro Direito',
  DE: 'Dianteiro Esquerdo',
  TD: 'Traseiro Direito',
  TE: 'Traseiro Esquerdo',
  TDE: 'Traseiro Dir. Externo',
  TDI: 'Traseiro Dir. Interno',
  TEE: 'Traseiro Esq. Externo',
  TEI: 'Traseiro Esq. Interno',
  E2DE: 'Eixo 2 Dir. Externo',
  E2DI: 'Eixo 2 Dir. Interno',
  E2EE: 'Eixo 2 Esq. Externo',
  E2EI: 'Eixo 2 Esq. Interno',
  E3DE: 'Eixo 3 Dir. Externo',
  E3DI: 'Eixo 3 Dir. Interno',
  E3EE: 'Eixo 3 Esq. Externo',
  E3EI: 'Eixo 3 Esq. Interno',
  D: 'Dianteiro (moto)',
  T: 'Traseiro (moto)',
  ESTEPE: 'Estepe',
};

/** Papel da posição: direcional (dianteira) ou tracao (eixos de tração/truck) */
export const PAPEL_POSICAO = {
  '1E': 'direcional',
  '1D': 'direcional',
  '2E': 'tracao',
  '2D': 'tracao',
  '2EE': 'tracao',
  '2EI': 'tracao',
  '2DI': 'tracao',
  '2DE': 'tracao',
  '3E': 'tracao',
  '3D': 'tracao',
  '3EE': 'tracao',
  '3EI': 'tracao',
  '3DI': 'tracao',
  '3DE': 'tracao',
  DD: 'direcional',
  DE: 'direcional',
  D: 'direcional',
  TD: 'tracao',
  TE: 'tracao',
  T: 'tracao',
  TDE: 'tracao',
  TDI: 'tracao',
  TEE: 'tracao',
  TEI: 'tracao',
  E2DE: 'tracao',
  E2DI: 'tracao',
  E2EE: 'tracao',
  E2EI: 'tracao',
  E3DE: 'tracao',
  E3DI: 'tracao',
  E3EE: 'tracao',
  E3EI: 'tracao',
  ESTEPE: 'estepe',
};

export const ORDEM_POSICAO = Object.keys(POSICOES_PNEU);

export const LAYOUTS_PNEU = {
  truck_10: {
    id: 'truck_10',
    nome: 'Truck 10 pneus — dianteira + 2 eixos duplos',
    descricao: '3 eixos: 2 na dianteira + 4 no 2º eixo + 4 no 3º eixo',
    posicoes: ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3EE', '3EI', '3DI', '3DE'],
  },
  truck_8: {
    id: 'truck_8',
    nome: 'Truck 8 pneus — dianteira + eixo duplo + eixo simples',
    descricao: '3 eixos: 2 na dianteira + 4 no 2º eixo + 2 no 3º eixo',
    posicoes: ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3E', '3D'],
  },
  truck_8_b: {
    id: 'truck_8_b',
    nome: 'Truck 8 pneus — dianteira + eixo simples + eixo duplo',
    descricao: '3 eixos: 2 na dianteira + 2 no 2º eixo + 4 no 3º eixo',
    posicoes: ['1E', '1D', '2E', '2D', '3EE', '3EI', '3DI', '3DE'],
  },
  toco_6: {
    id: 'toco_6',
    nome: 'Toco / Mini 6 pneus — dianteira + tração dupla',
    descricao: '2 eixos: 2 na dianteira + 4 na tração',
    posicoes: ['1E', '1D', '2EE', '2EI', '2DI', '2DE'],
  },
  padrao_5: {
    id: 'padrao_5',
    nome: 'Padrão — 4 rodas + estepe',
    descricao: 'Utilitário, van ou caminhão leve',
    posicoes: ['DD', 'DE', 'TD', 'TE', 'ESTEPE'],
  },
  utilitario_4: {
    id: 'utilitario_4',
    nome: 'Utilitário — 4 rodas',
    descricao: 'Sem estepe cadastrado',
    posicoes: ['DD', 'DE', 'TD', 'TE'],
  },
  duplo_traseiro: {
    id: 'duplo_traseiro',
    nome: 'Caminhão — duplo traseiro (6 + estepe)',
    descricao: '1 eixo dianteiro + 1 eixo duplo traseiro',
    posicoes: ['DD', 'DE', 'TDE', 'TDI', 'TEE', 'TEI', 'ESTEPE'],
  },
  truck_10_estepe: {
    id: 'truck_10_estepe',
    nome: 'Caminhão pesado — 10 + estepe',
    descricao: 'Dianteiro + 2 eixos duplos + estepe (legado)',
    posicoes: ['DD', 'DE', 'E2DE', 'E2DI', 'E2EE', 'E2EI', 'E3DE', 'E3DI', 'E3EE', 'E3EI', 'ESTEPE'],
  },
  compactador: {
    id: 'compactador',
    nome: 'Compactador / Basculante — 8 rodas (legado)',
    descricao: 'Layout legado frota urbana',
    posicoes: ['DD', 'DE', 'E2DE', 'E2DI', 'E2EE', 'E2EI', 'E3DE', 'E3EE'],
  },
  moto_2: {
    id: 'moto_2',
    nome: 'Moto — 2 pneus',
    descricao: 'Dianteiro e traseiro',
    posicoes: ['D', 'T'],
  },
};

export const LAYOUT_PADRAO = 'truck_10';

export const TIPOS_PNEU = ['direcional', 'misto', 'borrachudo'];
export const CONDICOES_PNEU = ['novo', 'recapado'];
export const STATUS_PNEU = ['montado', 'estoque', 'recapagem', 'descarte'];

export const LABELS_TIPO_PNEU = {
  direcional: 'Direcional',
  misto: 'Misto (tração)',
  borrachudo: 'Borrachudo',
};

export function labelTipoPneu(codigo) {
  return LABELS_TIPO_PNEU[codigo] || codigo || '—';
}

export function getLayout(id) {
  return LAYOUTS_PNEU[id] || LAYOUTS_PNEU[LAYOUT_PADRAO];
}

export function labelPosicao(codigo) {
  return POSICOES_PNEU[codigo] || codigo;
}

export function papelPosicao(codigo) {
  return PAPEL_POSICAO[codigo] || 'tracao';
}

/** Lado oposto no mesmo eixo (ex.: 1E ↔ 1D, 2EE ↔ 2DE). */
const POSICAO_ESPELHADA = {
  '1E': '1D',
  '1D': '1E',
  '2E': '2D',
  '2D': '2E',
  '2EE': '2DE',
  '2DE': '2EE',
  '2EI': '2DI',
  '2DI': '2EI',
  '3E': '3D',
  '3D': '3E',
  '3EE': '3DE',
  '3DE': '3EE',
  '3EI': '3DI',
  '3DI': '3EI',
  DE: 'DD',
  DD: 'DE',
  TE: 'TD',
  TD: 'TE',
  TEE: 'TDE',
  TDE: 'TEE',
  TEI: 'TDI',
  TDI: 'TEI',
  E2EE: 'E2DE',
  E2DE: 'E2EE',
  E2EI: 'E2DI',
  E2DI: 'E2EI',
  E3EE: 'E3DE',
  E3DE: 'E3EE',
  E3EI: 'E3DI',
  E3DI: 'E3EI',
};

export function posicaoEspelhada(codigo) {
  if (!codigo) return null;
  return POSICAO_ESPELHADA[codigo] || null;
}

/** Lado do veículo: esquerdo | direito (null = indefinido / estepe / moto) */
const LADO_POSICAO = {
  '1E': 'esquerdo',
  '1D': 'direito',
  '2E': 'esquerdo',
  '2D': 'direito',
  '2EE': 'esquerdo',
  '2EI': 'esquerdo',
  '2DI': 'direito',
  '2DE': 'direito',
  '3E': 'esquerdo',
  '3D': 'direito',
  '3EE': 'esquerdo',
  '3EI': 'esquerdo',
  '3DI': 'direito',
  '3DE': 'direito',
  DE: 'esquerdo',
  DD: 'direito',
  TE: 'esquerdo',
  TD: 'direito',
  TEE: 'esquerdo',
  TEI: 'esquerdo',
  TDI: 'direito',
  TDE: 'direito',
  E2EE: 'esquerdo',
  E2EI: 'esquerdo',
  E2DI: 'direito',
  E2DE: 'direito',
  E3EE: 'esquerdo',
  E3EI: 'esquerdo',
  E3DI: 'direito',
  E3DE: 'direito',
};

export function ladoPosicao(codigo) {
  if (!codigo) return null;
  return LADO_POSICAO[codigo] || null;
}

export function ordenarPosicoes(posicoes) {
  const ordem = ORDEM_POSICAO;
  return [...posicoes].sort((a, b) => {
    const ia = ordem.indexOf(a);
    const ib = ordem.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

export function sqlOrderPosicao(campo = 'p.posicao') {
  const cases = ORDEM_POSICAO.map((p, i) => `WHEN '${p}' THEN ${i + 1}`).join(' ');
  return `CASE ${campo} ${cases} ELSE 999 END`;
}

/**
 * Regra de negócio: recapado só em tração/truck; novo em qualquer posição.
 * Direcional preferencialmente na dianteira.
 */
export function validarMontagem({ condicao, tipo_pneu, posicao }, { strictTipo = false } = {}) {
  const papel = papelPosicao(posicao);
  const erros = [];
  const avisos = [];

  if (condicao === 'recapado' && papel === 'direcional') {
    erros.push('Pneu recapado não pode ir na dianteira (direcional). Use eixo de tração/truck.');
  }

  if (strictTipo && tipo_pneu === 'direcional' && papel === 'tracao') {
    avisos.push('Pneu direcional montado em eixo de tração — verifique se é intencional.');
  }

  if (tipo_pneu === 'misto' && papel === 'direcional') {
    avisos.push('Pneu misto na dianteira — preferível usar direcional no eixo 1.');
  }

  if (tipo_pneu === 'borrachudo' && papel === 'direcional') {
    avisos.push('Pneu borrachudo na dianteira — use preferencialmente em eixos de tração.');
  }

  return { ok: erros.length === 0, erros, avisos, papel };
}

/**
 * Atualiza só o layout do veículo.
 * Não cria pneus fantasma — posições fora do layout voltam ao estoque.
 */
export async function aplicarLayoutPneus(db, veiculoId, layoutId, posicoesCustom) {
  const layout = posicoesCustom?.length
    ? { posicoes: ordenarPosicoes(posicoesCustom) }
    : getLayout(layoutId);

  const desejadas = layout.posicoes;

  const montados = await db.prepare(`
    SELECT id, posicao, filial_id FROM pneus
    WHERE veiculo_id = ? AND ativo = 1 AND status_pneu = 'montado'
  `).all(veiculoId);

  const desmontar = db.prepare(`
    UPDATE pneus SET
      veiculo_id = NULL,
      posicao = NULL,
      status_pneu = 'estoque',
      data_instalacao = NULL
    WHERE id = ?
  `);
  const mov = db.prepare(`
    INSERT INTO movimentacoes (pneu_id, veiculo_id, tipo, posicao, detalhes)
    VALUES (?, ?, 'desmontagem', ?, 'Removido por mudança de layout')
  `);

  for (const p of montados) {
    if (!desejadas.includes(p.posicao)) {
      await desmontar.run(p.id);
      await mov.run(p.id, veiculoId, p.posicao);
    }
  }

  await db.prepare(`
    UPDATE veiculos SET layout_pneus = ?, updated_at = NOW()
    WHERE id = ?
  `).run(layoutId || 'personalizado', veiculoId);

  return desejadas;
}
