import {
  normalizarFogoInformado,
  ehPlaceholderFogo,
} from '../src/numero-fogo.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(ehPlaceholderFogo('S/N'), 'S/N deve ser placeholder');
assert(ehPlaceholderFogo(''), 'vazio deve ser placeholder');
assert(!ehPlaceholderFogo('1224510'), '1224510 não é placeholder');
assert(!ehPlaceholderFogo('CLG0748'), 'CLG0748 não é placeholder');

assert(
  normalizarFogoInformado('1224510', '0501', { padrao_obrigatorio: false }) === '1224510',
  'planilha numérica deve manter o fogo na unidade com legado',
);
assert(
  normalizarFogoInformado('377', '0501', { padrao_obrigatorio: false }) === '377',
  'fogo curto da planilha deve ser mantido',
);
assert(
  normalizarFogoInformado('CLG0748', '0501', { padrao_obrigatorio: false }) === 'CLG0748',
  'fogo alfanumérico deve ser mantido',
);
assert(
  normalizarFogoInformado('S/N', '0501', { padrao_obrigatorio: false }) === null,
  'S/N deve gerar automático',
);
assert(
  normalizarFogoInformado('0001', '0501', { padrao_obrigatorio: true }) === '0501-0001',
  'unidade 100% no padrão ainda completa sequência curta',
);

console.log('ok: fogos da planilha são preservados na unidade com legado');
