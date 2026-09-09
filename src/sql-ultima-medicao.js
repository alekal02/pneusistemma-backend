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
