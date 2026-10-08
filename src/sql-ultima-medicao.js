/**
 * Join da última medição do pneu `p` (uma busca em vez de 4–7 subconsultas).
 * Alias: `um`
 */
export const SQL_LATERAL_ULTIMA_MEDICAO = `
LEFT JOIN LATERAL (
  SELECT sulco_externo, sulco_central, sulco_interno, sulco_auxiliar,
         data_medicao, created_at, diagnostico, acao_sugerida, id, km_veiculo
  FROM medicoes
  WHERE pneu_id = p.id
  ORDER BY data_medicao DESC, id DESC
  LIMIT 1
) um ON TRUE
`;

/** Uma linha por posição do caminhão — evita o log repetir o mesmo sulco do autosave. */
export const SQL_LOGS_MEDICAO_FILIAL = `
SELECT * FROM (
  SELECT DISTINCT ON (v.id, p.posicao)
    m.id,
    m.data_medicao,
    m.created_at,
    LEAST(
      COALESCE(m.sulco_externo, 999),
      COALESCE(m.sulco_central, 999),
      COALESCE(m.sulco_interno, 999),
      COALESCE(m.sulco_auxiliar, 999)
    ) as menor_raw,
    p.posicao,
    p.numero_fogo,
    v.id as veiculo_id,
    v.placa,
    v.apelido,
    v.tipo,
    v.layout_pneus
  FROM medicoes m
  JOIN pneus p ON p.id = m.pneu_id
  JOIN veiculos v ON v.id = p.veiculo_id AND v.ativo = 1 AND v.filial_id = ?
  ORDER BY v.id, p.posicao, COALESCE(m.created_at, m.data_medicao::timestamp) DESC, m.id DESC
) ult
ORDER BY COALESCE(ult.created_at, ult.data_medicao::timestamp) DESC, ult.id DESC
LIMIT ?
`;

export const SQL_LOGS_MEDICAO_SEMANA = `
SELECT * FROM (
  SELECT DISTINCT ON (COALESCE(v.id, 0), COALESCE(p.posicao, p.id::text))
    m.id, m.data_medicao, m.created_at,
    m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar,
    m.diagnostico, m.acao_sugerida, m.veiculo_placa, m.responsavel, m.observacoes,
    p.numero_fogo, p.posicao, p.status_pneu,
    v.id as veiculo_id, v.placa, v.apelido, v.tipo, v.layout_pneus
  FROM medicoes m
  JOIN pneus p ON p.id = m.pneu_id
  LEFT JOIN veiculos v ON v.id = p.veiculo_id
  WHERE p.filial_id = ?
    AND m.data_medicao >= ?
    AND m.data_medicao <= ?
  ORDER BY COALESCE(v.id, 0), COALESCE(p.posicao, p.id::text), m.data_medicao DESC, m.id DESC
) ult
ORDER BY ult.data_medicao DESC, ult.id DESC
LIMIT 80
`;
