/**
 * Ciclos de desgaste do mesmo pneu, só com fatos já gravados.
 * Estoque não entra em KM/horas. Dado ausente permanece nulo.
 */

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function instante(ev) {
  if (ev.created_at) {
    const t = new Date(ev.created_at).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (ev.data) {
    const t = new Date(`${String(ev.data).slice(0, 10)}T12:00:00`).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function cmpEvento(a, b) {
  const ta = instante(a);
  const tb = instante(b);
  if (ta !== tb) return ta - tb;
  if (a._kind !== b._kind) return a._kind === 'mov' ? -1 : 1;
  return (Number(a.id) || 0) - (Number(b.id) || 0);
}

export function labelCiclo(ciclo) {
  const n = num(ciclo);
  if (n == null) return null;
  if (n <= 0) return 'Original';
  return `R${n}`;
}

export function sulcoDeMedicao(m) {
  if (!m) return null;
  const vals = [m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.sulco_mm]
    .map(num)
    .filter((n) => n != null);
  if (!vals.length) return null;
  return Math.min(...vals);
}

function papelRecap(mv) {
  if (!mv || mv._kind === 'med') return null;
  const tipo = mv.tipo;
  if (tipo === 'retorno_recap') return 'inicio';
  if (tipo === 'enviar_recap') return 'fim';
  if (tipo === 'recap') {
    return /recebid/i.test(String(mv.detalhes || '')) ? 'inicio' : 'fim';
  }
  return null;
}

function cicloExplicito(item) {
  if (item.ciclo == null || item.ciclo === '') return null;
  return num(item.ciclo);
}

function fmtData(iso) {
  if (!iso) return null;
  return String(iso).slice(0, 10);
}

function diasEntre(a, b) {
  if (!a || !b || a === b) return null;
  const da = new Date(`${a}T12:00:00`);
  const db = new Date(`${b}T12:00:00`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.round((db - da) / 86400000);
}

function usoNoCiclo(items) {
  const ordenados = [...items].sort(cmpEvento);
  let aberto = null;
  let km = 0;
  let horas = 0;
  let temKm = false;
  let temHoras = false;

  function fechar(kmFim, hrFim) {
    if (!aberto) return;
    if (aberto.km != null && kmFim != null) {
      const d = kmFim - aberto.km;
      if (d >= 0) {
        km += d;
        temKm = true;
      }
    }
    if (aberto.hr != null && hrFim != null) {
      const d = hrFim - aberto.hr;
      if (d >= 0) {
        horas += d;
        temHoras = true;
      }
    }
    aberto = null;
  }

  for (const ev of ordenados) {
    if (ev._kind === 'mov' && ev.tipo === 'montagem') {
      aberto = {
        veiculoId: ev.veiculo_id ?? null,
        km: num(ev.km_veiculo),
        hr: num(ev.hr_veiculo),
      };
      continue;
    }
    if (ev._kind === 'mov' && ev.tipo === 'mudanca_posicao') {
      if (
        aberto
        && ev.veiculo_id != null
        && aberto.veiculoId != null
        && Number(ev.veiculo_id) !== Number(aberto.veiculoId)
      ) {
        aberto = {
          veiculoId: ev.veiculo_id,
          km: num(ev.km_veiculo),
          hr: num(ev.hr_veiculo),
        };
      }
      continue;
    }
    const fecha = ev._kind === 'mov' && (
      ev.tipo === 'retirada'
      || ev.tipo === 'desmontagem'
      || ev.tipo === 'descarte'
      || papelRecap(ev) === 'fim'
    );
    if (fecha) fechar(num(ev.km_veiculo), num(ev.hr_veiculo));
  }

  if (aberto) {
    const meds = ordenados.filter((e) => e._kind === 'med' && (
      aberto.veiculoId == null
      || e.veiculo_id == null
      || Number(e.veiculo_id) === Number(aberto.veiculoId)
    ));
    const ultima = [...meds].reverse().find((m) => num(m.km_veiculo) != null || num(m.hr_veiculo) != null);
    if (ultima) fechar(num(ultima.km_veiculo), num(ultima.hr_veiculo));
  }

  return {
    km: temKm ? round1(km) : null,
    horas: temHoras ? round1(horas) : null,
  };
}

function indicadoresDoGrupo(ciclo, items) {
  const ordenados = [...items].sort(cmpEvento);
  let inicialRecap = null;
  const pontos = [];
  for (const ev of ordenados) {
    if (papelRecap(ev) === 'inicio') {
      const s = num(ev.sulco_depois) ?? num(ev.sulco_mm);
      if (s != null && inicialRecap == null) inicialRecap = s;
    }
    if (ev._kind === 'med') {
      const s = sulcoDeMedicao(ev);
      if (s != null) pontos.push(s);
    } else if (papelRecap(ev) === 'fim') {
      const s = num(ev.sulco_antes);
      if (s != null) pontos.push(s);
    }
  }

  const inicial = inicialRecap != null ? inicialRecap : (pontos[0] ?? null);
  const atual = pontos.length ? pontos[pontos.length - 1] : null;
  const temLeituraDepois = inicialRecap != null ? pontos.length >= 1 : pontos.length >= 2;
  let consumido = null;
  if (temLeituraDepois && inicial != null && atual != null && atual <= inicial) {
    consumido = round1(inicial - atual);
  }

  const uso = usoNoCiclo(ordenados);
  let rendimento = null;
  let rendimentoUnidade = null;
  if (consumido != null && consumido > 0 && uso.km != null) {
    rendimento = round1(uso.km / consumido);
    rendimentoUnidade = 'km/mm';
  } else if (consumido != null && consumido > 0 && uso.horas != null) {
    rendimento = round1(uso.horas / consumido);
    rendimentoUnidade = 'h/mm';
  }

  const veiculos = [];
  const posicoes = [];
  const vistosV = new Set();
  const vistosP = new Set();
  for (const ev of ordenados) {
    const placa = ev.veiculo_placa || null;
    const apelido = ev.veiculo_apelido || null;
    const rotulo = placa && apelido ? `${placa}/${apelido}` : (placa || apelido);
    if (rotulo && !vistosV.has(rotulo)) {
      vistosV.add(rotulo);
      veiculos.push(rotulo);
    }
    if (ev.posicao && !vistosP.has(ev.posicao)) {
      vistosP.add(ev.posicao);
      posicoes.push(ev.posicao);
    }
  }

  const datas = ordenados.map((e) => fmtData(e.data)).filter(Boolean).sort();
  const inicio = datas[0] || null;
  const fim = datas.length ? datas[datas.length - 1] : null;

  return {
    ciclo,
    ciclo_label: labelCiclo(ciclo),
    sulco_inicial: inicial,
    sulco_atual: atual,
    mm_consumidos: consumido,
    km: uso.km,
    horas: uso.horas,
    rendimento,
    rendimento_unidade: rendimentoUnidade,
    veiculos,
    posicoes,
    inicio,
    fim,
    duracao_dias: diasEntre(inicio, fim),
    custo: null,
    custo_por_uso: null,
    custo_por_uso_unidade: null,
  };
}

function custoDoCiclo(ciclo, itens) {
  if (ciclo == null) return null;
  let sum = 0;
  let any = false;
  for (const ev of itens) {
    if (ev._kind !== 'mov') continue;
    const c = num(ev.custo);
    if (c == null) continue;
    if (papelRecap(ev) === 'fim') {
      if (ev._ciclo != null && ev._ciclo + 1 === ciclo) {
        sum += c;
        any = true;
      }
      continue;
    }
    if (ev._ciclo === ciclo) {
      sum += c;
      any = true;
    }
  }
  return any ? round1(sum) : null;
}

function normalizar(movimentacoes, medicoes) {
  const movs = (movimentacoes || []).map((m) => ({
    ...m,
    _kind: 'mov',
    data: m.data_evento || m.data || null,
  }));
  const meds = (medicoes || []).map((m) => ({
    ...m,
    _kind: 'med',
    data: m.data_medicao || m.data || null,
  }));
  const temLimite = movs.some((m) => papelRecap(m));
  const inicios = movs.filter((m) => papelRecap(m) === 'inicio');

  function cicloDe(item) {
    const ex = cicloExplicito(item);
    if (ex != null) return ex;
    if (!temLimite) return null;
    const antes = inicios.filter((ini) => cmpEvento(ini, item) < 0).length;
    if (papelRecap(item) === 'inicio') return antes + 1;
    return antes;
  }

  for (const item of [...movs, ...meds]) item._ciclo = cicloDe(item);
  return [...movs, ...meds];
}

export function calcularCiclos({ movimentacoes = [], medicoes = [] } = {}) {
  const itens = normalizar(movimentacoes, medicoes);
  const grupos = new Map();
  for (const item of itens) {
    const chave = item._ciclo == null ? 'sem' : String(item._ciclo);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(item);
  }
  const ciclos = [...grupos.entries()]
    .map(([chave, items]) => {
      const ciclo = chave === 'sem' ? null : Number(chave);
      const ind = indicadoresDoGrupo(ciclo, items);
      ind.custo = custoDoCiclo(ciclo, itens);
      if (ind.custo != null && ind.km != null && ind.km > 0) {
        ind.custo_por_uso = round1(ind.custo / ind.km);
        ind.custo_por_uso_unidade = 'R$/km';
      } else if (ind.custo != null && ind.horas != null && ind.horas > 0) {
        ind.custo_por_uso = round1(ind.custo / ind.horas);
        ind.custo_por_uso_unidade = 'R$/h';
      }
      return ind;
    })
    .sort((a, b) => {
      if (a.ciclo == null) return 1;
      if (b.ciclo == null) return -1;
      return a.ciclo - b.ciclo;
    });
  return ciclos;
}

function linhaUtil(c) {
  if (c.km != null || c.horas != null) return true;
  if (c.mm_consumidos != null && c.mm_consumidos > 0) return true;
  return c.sulco_inicial != null && c.sulco_atual != null && c.sulco_inicial !== c.sulco_atual;
}

export function linhasEvolucao(pneuId, numeroFogo, ciclos) {
  return (ciclos || []).filter(linhaUtil).map((c) => ({
    pneu_id: pneuId,
    fogo: numeroFogo || `ID ${pneuId}`,
    veiculo: c.veiculos.join(' · ') || null,
    posicao: c.posicoes.join(', ') || null,
    ciclo: c.ciclo_label,
    inicial: c.sulco_inicial,
    atual: c.sulco_atual,
    consumido: c.mm_consumidos,
    km: c.km,
    horas: c.horas,
    rendimento: c.rendimento,
    rendimento_unidade: c.rendimento_unidade,
  }));
}

function mediana(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round1((s[mid - 1] + s[mid]) / 2);
}

export async function carregarEvolucaoDesgaste(db, filialId, { limite = 40 } = {}) {
  const medicoes = await db.prepare(`
    SELECT
      m.id, m.pneu_id, m.data_medicao, m.km_veiculo, m.hr_veiculo,
      m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar, m.sulco_mm,
      m.veiculo_id, m.veiculo_placa, m.veiculo_apelido, m.posicao, m.ciclo, m.created_at,
      p.numero_fogo
    FROM medicoes m
    JOIN pneus p ON p.id = m.pneu_id
    WHERE p.filial_id = ?
  `).all(filialId);

  const movimentacoes = await db.prepare(`
    SELECT
      mv.id, mv.pneu_id, mv.tipo, mv.data_evento, mv.km_veiculo, mv.hr_veiculo,
      mv.posicao, mv.sulco_mm, mv.sulco_antes, mv.sulco_depois, mv.veiculo_id,
      mv.veiculo_placa, mv.veiculo_apelido, mv.ciclo, mv.custo, mv.detalhes, mv.created_at,
      p.numero_fogo
    FROM movimentacoes mv
    JOIN pneus p ON p.id = mv.pneu_id
    WHERE p.filial_id = ?
  `).all(filialId);

  const porPneu = new Map();
  function bucket(row) {
    if (!porPneu.has(row.pneu_id)) {
      porPneu.set(row.pneu_id, { fogo: row.numero_fogo, med: [], mov: [] });
    }
    return porPneu.get(row.pneu_id);
  }
  for (const m of medicoes) bucket(m).med.push(m);
  for (const mv of movimentacoes) bucket(mv).mov.push(mv);

  const linhas = [];
  for (const [pneuId, bag] of porPneu) {
    const ciclos = calcularCiclos({ movimentacoes: bag.mov, medicoes: bag.med });
    linhas.push(...linhasEvolucao(pneuId, bag.fogo, ciclos));
  }
  linhas.sort((a, b) => String(a.fogo).localeCompare(String(b.fogo), 'pt-BR')
    || String(a.ciclo || '').localeCompare(String(b.ciclo || '')));

  const omitidos = Math.max(0, linhas.length - limite);
  const visiveis = linhas.slice(0, limite);
  const kmMm = visiveis
    .filter((l) => l.rendimento != null && l.rendimento_unidade === 'km/mm')
    .map((l) => l.rendimento);
  const hMm = visiveis
    .filter((l) => l.rendimento != null && l.rendimento_unidade === 'h/mm')
    .map((l) => l.rendimento);

  return {
    linhas: visiveis,
    resumo: {
      ciclos: visiveis.length,
      omitidos,
      com_rendimento: kmMm.length + hMm.length,
      mediana_km_mm: mediana(kmMm),
      mediana_h_mm: mediana(hMm),
    },
  };
}
