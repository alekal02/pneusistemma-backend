/**
 * Diagnóstico da frota — somente leitura.
 * Regras de cadastro, layout, sulco e dia de medição já existentes no sistema.
 */
import { colunaExiste } from '../schema-colunas.js';
import {
  labelDiaMedicao,
  medidoNestaSemana,
  normalizarDiaMedicao,
  semanaMedicaoBrasil,
} from '../dia-medicao.js';
import { especificacaoMedicao } from '../medicao-perfil.js';
import { veiculoCombinaTipo } from './indicadores-frota.js';
import {
  LAYOUTS_PNEU,
  labelPosicao,
  validarMontagem,
} from '../pneus-layouts.js';
import { ehPlaceholderFogo } from '../numero-fogo.js';

const CAMPOS_SULCO_QUATRO = ['sulco_externo', 'sulco_central', 'sulco_interno', 'sulco_auxiliar'];

export function escopoPermite(escopo, filialId) {
  if (escopo == null) return true;
  if (!Array.isArray(escopo)) return false;
  return escopo.map(Number).includes(Number(filialId));
}

export function rejeitarFilialForaDoEscopo(escopo, filialId) {
  if (filialId == null || filialId === '') return null;
  const id = Number(filialId);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, erro: 'Filial inválida' };
  if (!escopoPermite(escopo, id)) return { status: 403, erro: 'Filial fora do seu acesso' };
  return null;
}

export function posicoesDoLayout(layoutId) {
  const id = String(layoutId || '').trim();
  if (!id || id === 'personalizado' || !LAYOUTS_PNEU[id]) {
    return { disponivel: false, posicoes: [] };
  }
  return { disponivel: true, posicoes: [...LAYOUTS_PNEU[id].posicoes] };
}

function sulcoInformado(valor) {
  if (valor == null || valor === '') return false;
  const n = Number(valor);
  return Number.isFinite(n);
}

function dataIso(valor) {
  if (!valor) return null;
  const s = String(valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function fmtData(iso) {
  if (!iso) return 'sem medição';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fogoExibicao(valor) {
  return ehPlaceholderFogo(valor) ? null : String(valor).trim();
}

function cadastroIncompleto(flag) {
  return Number(flag ?? 1) !== 1;
}

function dentroDoPeriodo(iso, inicio, fim) {
  if (!iso) return false;
  if (inicio && iso < inicio) return false;
  if (fim && iso > fim) return false;
  return true;
}

function exigenciaSulco(tipo, layout) {
  const spec = especificacaoMedicao(tipo, layout);
  if (spec.sulco === 'quatro_pontos') {
    return {
      modo: 'quatro',
      campos: CAMPOS_SULCO_QUATRO,
      faltantes(medicao) {
        return CAMPOS_SULCO_QUATRO.filter((c) => !sulcoInformado(medicao?.[c]));
      },
    };
  }
  return {
    modo: 'um',
    campos: ['sulco_mm'],
    faltantes(medicao) {
      return sulcoInformado(medicao?.sulco_mm) ? [] : ['sulco_mm'];
    },
  };
}

export function situacaoMedicao({ dataMedicao, diaVeiculo, diaFilial, agora }) {
  const semana = semanaMedicaoBrasil(agora);
  const dia = normalizarDiaMedicao(diaVeiculo) || normalizarDiaMedicao(diaFilial);
  const medida = dataIso(dataMedicao);
  if (medida && medidoNestaSemana(medida, semana)) {
    return { situacao: 'em_dia', dia, semana, medida };
  }
  if (dia && semana.iso_dia > dia) return { situacao: 'atrasada', dia, semana, medida };
  if (dia && semana.iso_dia === dia) return { situacao: 'hoje', dia, semana, medida };
  return { situacao: 'no_prazo', dia, semana, medida };
}

function pendencia(base) {
  return {
    reprova: true,
    posicao: null,
    posicao_label: null,
    numero_fogo: null,
    data_medicao: null,
    ...base,
  };
}

function textoDia(dia) {
  return dia ? labelDiaMedicao(dia).toLowerCase() : 'não configurado';
}

export function diagnosticarVeiculo(veiculo, { agora } = {}) {
  const pneus = Array.isArray(veiculo.pneus) ? veiculo.pneus : [];
  const layout = posicoesDoLayout(veiculo.layout_pneus);
  const pendencias = [];
  const ocupadas = new Set();

  if (!layout.disponivel) {
    pendencias.push(pendencia({
      codigo: 'layout_indisponivel',
      severidade: 'atencao',
      reprova: false,
      descricao: 'Conferência de posições indisponível neste layout personalizado.',
      orientacao: 'O sistema não guardou a lista de posições deste layout. Não há como apontar posição vazia sem inventar o diagrama.',
    }));
  } else {
    for (const codigo of layout.posicoes) {
      const tem = pneus.some((p) => p.posicao === codigo);
      if (tem) {
        ocupadas.add(codigo);
        continue;
      }
      const estepe = codigo === 'ESTEPE';
      pendencias.push(pendencia({
        codigo: estepe ? 'estepe_vazio' : 'posicao_vazia',
        severidade: estepe ? 'atencao' : 'cadastral',
        reprova: !estepe,
        posicao: codigo,
        posicao_label: labelPosicao(codigo),
        descricao: estepe
          ? 'Estepe vazio.'
          : `Posição ${labelPosicao(codigo)} sem pneu montado.`,
        orientacao: estepe
          ? 'Aviso: o estepe deste layout está vazio. Isso não tira a conformidade da frota.'
          : `Monte ou cadastre um pneu em ${labelPosicao(codigo)}.`,
      }));
    }
  }

  for (const pneu of pneus) {
    const posLabel = pneu.posicao ? labelPosicao(pneu.posicao) : null;
    const medicao = {
      data_medicao: dataIso(pneu.data_medicao),
      sulco_externo: pneu.sulco_externo,
      sulco_central: pneu.sulco_central,
      sulco_interno: pneu.sulco_interno,
      sulco_auxiliar: pneu.sulco_auxiliar,
      sulco_mm: pneu.sulco_mm,
    };
    const situacao = situacaoMedicao({
      dataMedicao: medicao.data_medicao,
      diaVeiculo: veiculo.dia_medicao,
      diaFilial: veiculo.filial_dia,
      agora,
    });

    if (cadastroIncompleto(pneu.cadastro_completo)) {
      pendencias.push(pendencia({
        codigo: 'cadastro_pneu',
        severidade: 'cadastral',
        posicao: pneu.posicao || null,
        posicao_label: posLabel,
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        data_medicao: medicao.data_medicao,
        descricao: 'Cadastro do pneu montado incompleto.',
        orientacao: 'Conclua o cadastro deste pneu. O sistema exige o modelo para encerrar o pré-cadastro.',
      }));
    }

    if (ehPlaceholderFogo(pneu.numero_fogo)) {
      pendencias.push(pendencia({
        codigo: 'fogo_vazio',
        severidade: 'cadastral',
        posicao: pneu.posicao || null,
        posicao_label: posLabel,
        data_medicao: medicao.data_medicao,
        descricao: posLabel
          ? `Pneu em ${posLabel} sem marca de fogo.`
          : 'Pneu montado sem marca de fogo.',
        orientacao: 'Grave a marca de fogo deste pneu montado.',
      }));
    }

    if (!pneu.posicao) {
      pendencias.push(pendencia({
        codigo: 'sem_posicao',
        severidade: 'cadastral',
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        data_medicao: medicao.data_medicao,
        descricao: 'Pneu montado sem posição.',
        orientacao: 'Informe a posição do layout em que este pneu está montado.',
      }));
    } else if (layout.disponivel && !layout.posicoes.includes(pneu.posicao)) {
      pendencias.push(pendencia({
        codigo: 'posicao_fora_layout',
        severidade: 'cadastral',
        posicao: pneu.posicao,
        posicao_label: posLabel,
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        data_medicao: medicao.data_medicao,
        descricao: `${posLabel} não pertence ao layout deste veículo.`,
        orientacao: 'Ajuste a posição da montagem ou o layout do veículo. A posição atual não faz parte do diagrama cadastrado.',
      }));
    }

    if (pneu.filial_id != null && Number(pneu.filial_id) !== Number(veiculo.filial_id)) {
      pendencias.push(pendencia({
        codigo: 'filial_divergente',
        severidade: 'critica',
        posicao: pneu.posicao || null,
        posicao_label: posLabel,
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        data_medicao: medicao.data_medicao,
        descricao: 'Pneu montado vinculado a outra filial.',
        orientacao: 'Corrija o vínculo do pneu com a filial do veículo antes de cobrar a medição.',
      }));
    }

    if (pneu.posicao && pneu.condicao) {
      const montagem = validarMontagem({
        condicao: pneu.condicao,
        tipo_pneu: pneu.tipo_pneu,
        posicao: pneu.posicao,
      });
      for (const erro of montagem.erros) {
        pendencias.push(pendencia({
          codigo: 'montagem_incorreta',
          severidade: 'critica',
          posicao: pneu.posicao,
          posicao_label: posLabel,
          numero_fogo: fogoExibicao(pneu.numero_fogo),
          data_medicao: medicao.data_medicao,
          descricao: erro,
          orientacao: 'Remova o pneu recapado da posição direcional e monte em eixo de tração.',
        }));
      }
      for (const aviso of montagem.avisos) {
        pendencias.push(pendencia({
          codigo: 'montagem_aviso',
          severidade: 'atencao',
          reprova: false,
          posicao: pneu.posicao,
          posicao_label: posLabel,
          numero_fogo: fogoExibicao(pneu.numero_fogo),
          data_medicao: medicao.data_medicao,
          descricao: aviso,
          orientacao: 'Confira se o tipo do pneu nesta posição é intencional. O sistema não bloqueia esta montagem.',
        }));
      }
    }

    if (!medicao.data_medicao) {
      if (situacao.situacao === 'atrasada') {
        pendencias.push(pendencia({
          codigo: 'medicao_atrasada',
          severidade: 'critica',
          posicao: pneu.posicao || null,
          posicao_label: posLabel,
          numero_fogo: fogoExibicao(pneu.numero_fogo),
          descricao: `Sem medição. O dia previsto (${textoDia(situacao.dia)}) desta semana já passou.`,
          orientacao: 'Registre a medição nesta semana. O prazo do dia configurado já venceu.',
        }));
      } else {
        pendencias.push(pendencia({
          codigo: 'sem_medicao',
          severidade: 'atencao',
          posicao: pneu.posicao || null,
          posicao_label: posLabel,
          numero_fogo: fogoExibicao(pneu.numero_fogo),
          descricao: situacao.situacao === 'hoje'
            ? 'Sem medição. O dia previsto é hoje e ainda não está atrasado.'
            : 'Sem medição. O dia previsto desta semana ainda não venceu.',
          orientacao: situacao.situacao === 'hoje'
            ? 'Meça hoje. Isso ainda não conta como atraso.'
            : 'Agende a medição para o dia configurado. Ainda não está atrasada.',
        }));
      }
      continue;
    }

    if (situacao.situacao === 'atrasada') {
      pendencias.push(pendencia({
        codigo: 'medicao_atrasada',
        severidade: 'critica',
        posicao: pneu.posicao || null,
        posicao_label: posLabel,
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        data_medicao: medicao.data_medicao,
        descricao: `Medição atrasada. Última em ${fmtData(medicao.data_medicao)}; o dia previsto (${textoDia(situacao.dia)}) já passou.`,
        orientacao: 'Atualize a medição nesta semana. Medição prevista para hoje não entra nesta pendência.',
      }));
    }

    const sulco = exigenciaSulco(veiculo.tipo, veiculo.layout_pneus);
    const faltantes = sulco.faltantes(medicao);
    if (faltantes.length) {
      const quatro = sulco.modo === 'quatro';
      pendencias.push(pendencia({
        codigo: 'sulco_incompleto',
        severidade: 'atencao',
        posicao: pneu.posicao || null,
        posicao_label: posLabel,
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        data_medicao: medicao.data_medicao,
        descricao: quatro
          ? `Sulco incompleto em ${fmtData(medicao.data_medicao)}. Faltam ${faltantes.length} dos 4 pontos.`
          : `Sulco não informado na medição de ${fmtData(medicao.data_medicao)}.`,
        orientacao: quatro
          ? 'Complete os quatro pontos: externo, central, interno e auxiliar. Pressão e inspeção de danos não são exigidas.'
          : 'Informe o sulco único deste equipamento. Os quatro pontos de caminhão não se aplicam. Pressão e inspeção de danos não são exigidas.',
      }));
    }
  }

  const reprova = pendencias.some((p) => p.reprova);
  return {
    pendencias,
    conforme: !reprova,
    layout_disponivel: layout.disponivel,
  };
}

function combinaPlaca(placa, filtro) {
  const q = String(filtro || '').trim().toLowerCase();
  if (!q) return true;
  return String(placa || '').toLowerCase().includes(q);
}

function passaPeriodo(veiculo, inicio, fim) {
  if (!inicio && !fim) return true;
  const pneus = veiculo.pneus || [];
  if (!pneus.length) return true;
  if (pneus.some((p) => !dataIso(p.data_medicao))) return true;
  return pneus.some((p) => dentroDoPeriodo(dataIso(p.data_medicao), inicio, fim));
}

function faltasCadastroVeiculo(veiculo) {
  const faltas = [];
  if (!String(veiculo.marca || '').trim()) faltas.push('fabricante');
  if (!String(veiculo.modelo || '').trim()) faltas.push('modelo');
  if (!String(veiculo.layout_pneus || '').trim()) faltas.push('layout');
  return faltas;
}

function resumir(veiculos) {
  const analisados = veiculos.length;
  const conformes = veiculos.filter((v) => v.conforme).length;
  const comPendencia = analisados - conformes;
  const itens = veiculos.flatMap((v) => v.pendencias.filter((p) => p.reprova));
  return {
    veiculos_analisados: analisados,
    veiculos_conformes: conformes,
    veiculos_com_pendencia: comPendencia,
    pneus_sem_fogo: itens.filter((p) => p.codigo === 'fogo_vazio').length,
    pneus_sem_medicao: itens.filter((p) => p.codigo === 'sem_medicao' || (p.codigo === 'medicao_atrasada' && !p.data_medicao)).length,
    medicoes_atrasadas: itens.filter((p) => p.codigo === 'medicao_atrasada').length,
    posicoes_sem_pneu: itens.filter((p) => p.codigo === 'posicao_vazia').length,
    conformidade_pct: analisados ? Math.round((1000 * conformes) / analisados) / 10 : null,
  };
}

function porFilial(veiculos) {
  const map = new Map();
  for (const v of veiculos) {
    const key = String(v.filial_id);
    if (!map.has(key)) {
      map.set(key, {
        filial_id: v.filial_id,
        filial: v.filial_nome,
        codigo: v.filial_codigo,
        veiculos: [],
      });
    }
    map.get(key).veiculos.push(v);
  }
  return [...map.values()]
    .map((g) => ({
      filial_id: g.filial_id,
      filial: g.filial,
      codigo: g.codigo,
      ...resumir(g.veiculos),
    }))
    .sort((a, b) => String(a.filial).localeCompare(String(b.filial), 'pt-BR'));
}

export function avaliarFrota(veiculos, filtros = {}, { agora, escopo = null } = {}) {
  const inicio = dataIso(filtros.periodo_inicio);
  const fim = dataIso(filtros.periodo_fim);
  const pendenciaFiltro = String(filtros.pendencia || '').trim().toLowerCase();
  const noEscopo = (veiculos || []).filter((v) => escopoPermite(escopo, v.filial_id));
  const filiais = [];
  const vistas = new Set();
  for (const v of noEscopo) {
    const key = String(v.filial_id);
    if (vistas.has(key)) continue;
    vistas.add(key);
    filiais.push({ id: v.filial_id, nome: v.filial_nome, codigo: v.filial_codigo });
  }
  filiais.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  const base = noEscopo.filter((v) => (
    combinaPlaca(v.placa, filtros.placa)
    && veiculoCombinaTipo(v.tipo_codigo || v.tipo, filtros.tipo)
    && (filtros.filial_id == null || filtros.filial_id === '' || Number(v.filial_id) === Number(filtros.filial_id))
  ));

  const incompletosVeiculos = base
    .filter((v) => cadastroIncompleto(v.cadastro_completo))
    .map((v) => {
      const faltas = faltasCadastroVeiculo(v);
      return {
        id: v.id,
        placa: v.placa,
        filial_id: v.filial_id,
        filial: v.filial_nome,
        codigo: v.filial_codigo,
        tipo: v.tipo,
        faltas,
        descricao: faltas.length
          ? `Cadastro incompleto. Falta: ${faltas.join(', ')}.`
          : 'Cadastro marcado como incompleto.',
        orientacao: 'Conclua o cadastro do veículo. O sistema exige fabricante, modelo e layout.',
      };
    });

  const analisaveis = base.filter((v) => !cadastroIncompleto(v.cadastro_completo) && passaPeriodo(v, inicio, fim));
  const incompletosPneus = [];
  let diagnosticados = analisaveis.map((v) => {
    const diag = diagnosticarVeiculo(v, { agora });
    for (const pneu of v.pneus || []) {
      if (!cadastroIncompleto(pneu.cadastro_completo)) continue;
      incompletosPneus.push({
        pneu_id: pneu.id,
        placa: v.placa,
        filial_id: v.filial_id,
        filial: v.filial_nome,
        codigo: v.filial_codigo,
        posicao: pneu.posicao || null,
        posicao_label: pneu.posicao ? labelPosicao(pneu.posicao) : null,
        numero_fogo: fogoExibicao(pneu.numero_fogo),
        descricao: 'Cadastro do pneu incompleto.',
        orientacao: 'Conclua o cadastro do pneu informando o modelo.',
      });
    }
    const datas = (v.pneus || []).map((p) => dataIso(p.data_medicao)).filter(Boolean).sort();
    return {
      id: v.id,
      placa: v.placa,
      apelido: v.apelido || null,
      tipo: v.tipo,
      layout_pneus: v.layout_pneus,
      dia_medicao: normalizarDiaMedicao(v.dia_medicao) || normalizarDiaMedicao(v.filial_dia),
      dia_medicao_label: labelDiaMedicao(normalizarDiaMedicao(v.dia_medicao) || normalizarDiaMedicao(v.filial_dia)),
      filial_id: v.filial_id,
      filial: v.filial_nome,
      codigo: v.filial_codigo,
      ultima_medicao: datas.length ? datas[datas.length - 1] : null,
      layout_disponivel: diag.layout_disponivel,
      conforme: diag.conforme,
      pendencias: diag.pendencias,
    };
  });

  diagnosticados.sort((a, b) => (
    String(a.filial).localeCompare(String(b.filial), 'pt-BR')
    || String(a.placa).localeCompare(String(b.placa), 'pt-BR')
  ));

  const resumo = resumir(diagnosticados);
  const filiaisResumo = porFilial(diagnosticados);
  const visiveis = (pendenciaFiltro === 'critica' || pendenciaFiltro === 'atencao' || pendenciaFiltro === 'cadastral')
    ? diagnosticados.filter((v) => v.pendencias.some((p) => p.reprova && p.severidade === pendenciaFiltro))
    : diagnosticados;

  const semana = semanaMedicaoBrasil(agora);
  return {
    gerado_em: new Date().toISOString(),
    semana: {
      inicio: semana.inicio,
      fim: semana.fim,
      hoje: semana.hoje,
      dia_hoje_label: semana.dia_hoje_label,
    },
    filtros: {
      filial_id: filtros.filial_id ?? null,
      placa: filtros.placa || null,
      tipo: filtros.tipo || null,
      pendencia: pendenciaFiltro || null,
      periodo_inicio: inicio,
      periodo_fim: fim,
    },
    filiais,
    resumo: {
      ...resumo,
      cadastros_incompletos_veiculos: incompletosVeiculos.length,
      cadastros_incompletos_pneus: incompletosPneus.length,
    },
    por_filial: filiaisResumo,
    cadastros_incompletos: {
      veiculos: incompletosVeiculos,
      pneus: incompletosPneus,
    },
    veiculos: visiveis,
  };
}

function agruparLinhas(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row.veiculo_id);
    if (!map.has(id)) {
      map.set(id, {
        id: row.veiculo_id,
        placa: row.placa,
        apelido: row.apelido,
        tipo: row.tipo,
        tipo_codigo: row.tipo_codigo,
        layout_pneus: row.layout_pneus,
        dia_medicao: row.veiculo_dia,
        cadastro_completo: row.veiculo_cadastro,
        marca: row.veiculo_marca,
        modelo: row.veiculo_modelo,
        filial_id: row.filial_id,
        filial_nome: row.filial_nome,
        filial_codigo: row.filial_codigo,
        filial_dia: row.filial_dia,
        pneus: [],
      });
    }
    if (row.pneu_id == null) continue;
    map.get(id).pneus.push({
      id: row.pneu_id,
      posicao: row.posicao,
      numero_fogo: row.numero_fogo,
      filial_id: row.pneu_filial_id,
      cadastro_completo: row.pneu_cadastro,
      condicao: row.condicao,
      tipo_pneu: row.tipo_pneu,
      modelo: row.pneu_modelo,
      data_medicao: row.data_medicao,
      sulco_externo: row.sulco_externo,
      sulco_central: row.sulco_central,
      sulco_interno: row.sulco_interno,
      sulco_auxiliar: row.sulco_auxiliar,
      sulco_mm: row.sulco_mm,
    });
  }
  return [...map.values()];
}

export async function consultarDiagnosticoFrota(db, { escopo, filtros = {}, agora } = {}) {
  if (Array.isArray(escopo) && escopo.length === 0) {
    return avaliarFrota([], filtros, { agora, escopo });
  }
  const tem = async (tabela, coluna) => colunaExiste(db, tabela, coluna);
  const col = async (tabela, coluna, alias, tipo = 'double precision') => (
    await tem(tabela, coluna) ? `${alias}.${coluna}` : `NULL::${tipo}`
  );
  const diaFilial = await tem('filiais', 'dia_medicao') ? 'f.dia_medicao' : 'NULL::int';
  const diaVeiculo = await tem('veiculos', 'dia_medicao') ? 'v.dia_medicao' : 'NULL::int';
  const cadVeiculo = await tem('veiculos', 'cadastro_completo') ? 'v.cadastro_completo' : '1';
  const cadPneu = await tem('pneus', 'cadastro_completo') ? 'p.cadastro_completo' : '1';
  const tipoCodigo = await tem('veiculos', 'tipo_codigo') ? 'v.tipo_codigo' : 'NULL::text';
  const sulcoExterno = await col('medicoes', 'sulco_externo', 'm');
  const sulcoCentral = await col('medicoes', 'sulco_central', 'm');
  const sulcoInterno = await col('medicoes', 'sulco_interno', 'm');
  const sulcoAuxiliar = await col('medicoes', 'sulco_auxiliar', 'm');
  const sulcoMm = await col('medicoes', 'sulco_mm', 'm');

  const params = [];
  let where = 'v.ativo = 1';
  if (Array.isArray(escopo)) {
    const ids = escopo.map(Number).filter((n) => Number.isInteger(n));
    if (!ids.length) return avaliarFrota([], filtros, { agora, escopo });
    where += ` AND v.filial_id IN (${ids.map(() => '?').join(', ')})`;
    params.push(...ids);
  }

  const rows = await db.prepare(`
    SELECT
      f.id AS filial_id,
      f.nome AS filial_nome,
      f.codigo AS filial_codigo,
      ${diaFilial} AS filial_dia,
      v.id AS veiculo_id,
      v.placa,
      v.apelido,
      v.tipo,
      ${tipoCodigo} AS tipo_codigo,
      v.layout_pneus,
      ${diaVeiculo} AS veiculo_dia,
      ${cadVeiculo} AS veiculo_cadastro,
      v.marca AS veiculo_marca,
      v.modelo AS veiculo_modelo,
      p.id AS pneu_id,
      p.posicao,
      p.numero_fogo,
      p.filial_id AS pneu_filial_id,
      ${cadPneu} AS pneu_cadastro,
      p.condicao,
      p.tipo_pneu,
      p.modelo AS pneu_modelo,
      um.data_medicao,
      um.sulco_externo,
      um.sulco_central,
      um.sulco_interno,
      um.sulco_auxiliar,
      um.sulco_mm
    FROM veiculos v
    JOIN filiais f ON f.id = v.filial_id
    LEFT JOIN pneus p
      ON p.veiculo_id = v.id AND p.ativo = 1 AND p.status_pneu = 'montado'
    LEFT JOIN LATERAL (
      SELECT m.data_medicao, ${sulcoExterno} AS sulco_externo, ${sulcoCentral} AS sulco_central, ${sulcoInterno} AS sulco_interno, ${sulcoAuxiliar} AS sulco_auxiliar, ${sulcoMm} AS sulco_mm
      FROM medicoes m
      WHERE m.pneu_id = p.id
      ORDER BY m.data_medicao DESC, m.id DESC
      LIMIT 1
    ) um ON TRUE
    WHERE ${where}
    ORDER BY f.nome, v.placa, p.posicao
  `).all(...params);

  return avaliarFrota(agruparLinhas(rows), filtros, { agora, escopo });
}
