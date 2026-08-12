/**
 * Corrige textos com encoding corrompido no banco
 * (ex: Caminh?o → Caminhão, Tra��o → Tração).
 *
 * Uso CLI: node src/fix-encoding.js
 * Também é chamado na inicialização do banco.
 */

const REPL = '\uFFFD'; // caractere de substituição �

const CORRECOES_EXATAS = [
  [`Truck / Tra${REPL}${REPL}o`, 'Truck / Tração'],
  [`Truck / Tra${REPL}o`, 'Truck / Tração'],
  ['Truck / Tracao', 'Truck / Tração'],
  ['Truck / Traçao', 'Truck / Tração'],
  ['Truck / Tracão', 'Truck / Tração'],
  [`Caminh${REPL}o Compactador`, 'Caminhão Compactador'],
  [`Caminh${REPL}o Basculante`, 'Caminhão Basculante'],
  [`Caminh${REPL}o Pipa`, 'Caminhão Pipa'],
  ['Caminh?o Compactador', 'Caminhão Compactador'],
  ['Caminh?o Basculante', 'Caminhão Basculante'],
  ['Caminh?o Pipa', 'Caminhão Pipa'],
  ['Caminhao Compactador', 'Caminhão Compactador'],
  ['Caminhao Basculante', 'Caminhão Basculante'],
  [`Utilit${REPL}rio`, 'Utilitário'],
  ['Utilit?rio', 'Utilitário'],
  [`Ve${REPL}culo`, 'Veículo'],
  ['Ve?culo', 'Veículo'],
];

const CORRECOES_REPLACE = [
  ['Caminh?o', 'Caminhão'],
  [`Caminh${REPL}o`, 'Caminhão'],
  ['Utilit?rio', 'Utilitário'],
  [`Utilit${REPL}rio`, 'Utilitário'],
  ['Ve?culo', 'Veículo'],
  [`Ve${REPL}culo`, 'Veículo'],
  ['Medi??o', 'Medição'],
  [`Medi${REPL}${REPL}o`, 'Medição'],
  ['n?o encontrado', 'não encontrado'],
  [`n${REPL}o encontrado`, 'não encontrado'],
  ['Traçao', 'Tração'],
  ['Tracão', 'Tração'],
  ['Tracao', 'Tração'],
  [`Tra${REPL}${REPL}o`, 'Tração'],
  [`Tra${REPL}o`, 'Tração'],
];

export function corrigirEncodingBanco(db) {
  if (!db) return 0;
  let total = 0;

  for (const [errado, correto] of CORRECOES_EXATAS) {
    const result = db.prepare('UPDATE veiculos SET tipo = ? WHERE tipo = ?').run(correto, errado);
    if (result.changes > 0) {
      console.log(`[encoding] tipo: → "${correto}" (${result.changes})`);
      total += result.changes;
    }
  }

  const tiposRuins = db.prepare(`
    SELECT DISTINCT tipo FROM veiculos
    WHERE tipo LIKE 'Truck / Tra%' AND tipo != 'Truck / Tração'
  `).all();
  for (const { tipo } of tiposRuins) {
    const result = db.prepare('UPDATE veiculos SET tipo = ? WHERE tipo = ?').run('Truck / Tração', tipo);
    if (result.changes > 0) {
      console.log(`[encoding] tipo heurístico → "Truck / Tração" (${result.changes})`);
      total += result.changes;
    }
  }

  for (const [errado, correto] of CORRECOES_REPLACE) {
    const tabelas = [
      { sql: 'UPDATE veiculos SET tipo = REPLACE(tipo, ?, ?) WHERE tipo LIKE ?', args: [errado, correto, `%${errado}%`] },
      { sql: 'UPDATE veiculos SET apelido = REPLACE(apelido, ?, ?) WHERE apelido LIKE ?', args: [errado, correto, `%${errado}%`] },
      { sql: 'UPDATE veiculos SET observacoes = REPLACE(observacoes, ?, ?) WHERE observacoes LIKE ?', args: [errado, correto, `%${errado}%`] },
      { sql: 'UPDATE medicoes SET observacoes = REPLACE(observacoes, ?, ?) WHERE observacoes LIKE ?', args: [errado, correto, `%${errado}%`] },
      { sql: 'UPDATE medicoes SET responsavel = REPLACE(responsavel, ?, ?) WHERE responsavel LIKE ?', args: [errado, correto, `%${errado}%`] },
    ];

    for (const { sql, args } of tabelas) {
      try {
        const result = db.prepare(sql).run(...args);
        if (result.changes > 0) {
          console.log(`[encoding] replace "${correto}" (${result.changes})`);
          total += result.changes;
        }
      } catch {
        // ignore
      }
    }
  }

  return total;
}

/** Normaliza tipo de veículo na leitura/gravação da API */
export function normalizarTipoVeiculo(tipo) {
  if (!tipo || typeof tipo !== 'string') return tipo;
  const t = tipo.trim();
  if (t === 'Truck / Tração' || t === 'Toco / Mini') return t;
  if (/^Truck\s*\/\s*Tra/i.test(t)) return 'Truck / Tração';
  if (/^Toco/i.test(t)) return 'Toco / Mini';
  if (t.includes(REPL) || t.includes('?')) {
    if (/Truck/i.test(t) && /Tra/i.test(t)) return 'Truck / Tração';
    if (/Caminh/i.test(t) && /Compactador/i.test(t)) return 'Caminhão Compactador';
  }
  return t;
}

const isMain = process.argv[1] && String(process.argv[1]).replace(/\\/g, '/').endsWith('fix-encoding.js');

if (isMain) {
  import('./database.js').then(({ getDb }) => {
    const total = corrigirEncodingBanco(getDb());
    console.log(total
      ? `Total: ${total} registro(s) corrigido(s).`
      : 'Nenhum dado corrompido encontrado.');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
