import fs from 'fs';

const html = fs.readFileSync('frontend/index.html', 'utf8');
const js = fs.readFileSync('frontend/src/app.js', 'utf8');
const css = fs.readFileSync('frontend/src/style.css', 'utf8');

let falhas = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!cond) falhas += 1;
}

for (const id of [
  'pneu-destino-estoque',
  'pneu-edit-status',
  'pneu-destino-obs',
  'btn-pneu-enviar-recap',
  'btn-pneu-enviar-descarte',
]) {
  ok(html.includes(`id="${id}"`), `html #${id}`);
}

ok(js.includes("mostrarDestinoEstoque(p.status_pneu === 'estoque')"), 'mostra destino só no estoque');
ok(js.includes("mostrarDestinoEstoque(false)"), 'esconde destino no cadastro novo');
ok(js.includes("enviarPneuEstoqueDestino('recap')"), 'botão recap ligado');
ok(js.includes("enviarPneuEstoqueDestino('descarte')"), 'botão descarte ligado');
ok(js.includes('/evento'), 'chama POST /evento');
ok(js.includes("tipo === 'recap'") && js.includes("status !== 'estoque'"), 'guarda só estoque');
ok(js.includes("filtro.value = ehRecap ? 'recapagem' : 'descarte'"), 'troca filtro da lista após envio');
ok(js.includes('abrirModalTratamentoDescarte'), 'descarte abre tratamento');
ok(css.includes('.pneu-destino-box'), 'css do bloco destino');
ok(!html.includes('id="pneu-destino-estoque" class="pneu-destino-box hidden"') === false, 'bloco começa oculto');

const btnRecapType = /id="btn-pneu-enviar-recap"[^>]*type="button"|type="button"[^>]*id="btn-pneu-enviar-recap"/;
const btnDescType = /id="btn-pneu-enviar-descarte"[^>]*type="button"|type="button"[^>]*id="btn-pneu-enviar-descarte"/;
ok(btnRecapType.test(html), 'botão recap não submete o form');
ok(btnDescType.test(html), 'botão descarte não submete o form');

console.log(falhas ? `\n${falhas} FALHA(S) no front` : '\nFRONT: ligações OK');
process.exit(falhas ? 1 : 0);
