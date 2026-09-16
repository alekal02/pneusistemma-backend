import { pareceFogoAvulso, ehConversaLivre } from '../src/services/whatsapp-menu.js';

let falhas = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!cond) falhas += 1;
}

ok(!pareceFogoAvulso('fechou'), 'fechou não é fogo');
ok(!pareceFogoAvulso('rlx'), 'rlx não é fogo');
ok(!pareceFogoAvulso('flws'), 'flws não é fogo');
ok(!pareceFogoAvulso('FLWS'), 'FLWS não é fogo');
ok(!pareceFogoAvulso('valeu'), 'valeu não é fogo');
ok(!pareceFogoAvulso('blz'), 'blz não é fogo');
ok(!pareceFogoAvulso('ok'), 'ok não é fogo');
ok(!pareceFogoAvulso('menu'), 'menu não é fogo');
ok(!pareceFogoAvulso('12'), '12 sozinho não é fogo');
ok(pareceFogoAvulso('0501-0042'), '0501-0042 é fogo');
ok(pareceFogoAvulso('AP1-0134'), 'AP1-0134 é fogo');
ok(pareceFogoAvulso('fogo 1234'), 'fogo 1234 é fogo');
ok(pareceFogoAvulso('08251227'), '08251227 é fogo');
ok(pareceFogoAvulso('F-1001'), 'F-1001 é fogo');
ok(ehConversaLivre('fechou'), 'fechou é conversa');
ok(ehConversaLivre('rlx'), 'rlx é conversa');
ok(ehConversaLivre('flws'), 'flws é conversa');
ok(!ehConversaLivre('0501-0042'), 'marca de fogo não é conversa');

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nFOGO AVULSO OK');
process.exit(falhas ? 1 : 0);
