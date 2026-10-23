/** Paginação opcional. Sem limit/page, as rotas continuam devolvendo o array atual. */

export function lerPaginacao(query, { padrao = 24, maximo = 50 } = {}) {
  const q = query || {};
  const pedido = ['limit', 'limite', 'page', 'pagina']
    .some((chave) => q[chave] != null && String(q[chave]).trim() !== '');
  if (!pedido) return null;
  const limiteBruto = parseInt(q.limite ?? q.limit, 10);
  const paginaBruta = parseInt(q.pagina ?? q.page, 10);
  const limite = Math.min(maximo, Math.max(1, Number.isFinite(limiteBruto) ? limiteBruto : padrao));
  const pagina = Math.max(1, Number.isFinite(paginaBruta) ? paginaBruta : 1);
  return { limite, pagina, offset: (pagina - 1) * limite };
}

export function envelopePagina(itens, total, pag) {
  const n = Math.max(0, Number(total) || 0);
  return {
    itens,
    total: n,
    pagina: pag.pagina,
    limite: pag.limite,
    paginas: Math.max(1, Math.ceil(n / pag.limite) || 1),
  };
}

export function textoNormalizado(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function veiculoCombinaBusca(veiculo, q) {
  const consulta = textoNormalizado(q);
  if (!consulta) return true;
  const hay = textoNormalizado([
    veiculo?.apelido,
    veiculo?.placa,
    veiculo?.tipo,
    veiculo?.marca,
    veiculo?.modelo,
  ].filter(Boolean).join(' '));
  if (hay.includes(consulta)) return true;
  const compactar = (texto) => textoNormalizado(texto).replace(/[^a-z0-9]/g, '');
  const consultaCompacta = compactar(q);
  return Boolean(consultaCompacta) && compactar(hay).includes(consultaCompacta);
}
