/** Dia da medição: 1 = segunda … 7 = domingo (ISO). */

export const DIAS_SEMANA = [
  { id: 1, label: 'Segunda' },
  { id: 2, label: 'Terça' },
  { id: 3, label: 'Quarta' },
  { id: 4, label: 'Quinta' },
  { id: 5, label: 'Sexta' },
  { id: 6, label: 'Sábado' },
  { id: 7, label: 'Domingo' },
];

export function normalizarDiaMedicao(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 7) return null;
  return n;
}

export function labelDiaMedicao(valor) {
  const n = normalizarDiaMedicao(valor);
  return DIAS_SEMANA.find((d) => d.id === n)?.label || '';
}

export function dataISOBrasil(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
}

export function isoDiaBrasil(agora = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
  }).format(agora);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[wd] || 1;
}

export function semanaMedicaoBrasil(agora = new Date()) {
  const hoje = dataISOBrasil(agora);
  const isoDia = isoDiaBrasil(agora);
  const [y, m, d] = hoje.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const monday = utc - (isoDia - 1) * 86_400_000;
  const sunday = monday + 6 * 86_400_000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    hoje,
    iso_dia: isoDia,
    dia_hoje_label: labelDiaMedicao(isoDia),
    inicio: iso(monday),
    fim: iso(sunday),
  };
}

export function medidoNestaSemana(ultimaMedicao, semana) {
  if (!ultimaMedicao) return false;
  const d = String(ultimaMedicao).slice(0, 10);
  return Boolean(semana?.inicio && d >= semana.inicio && d <= semana.fim);
}
