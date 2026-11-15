// Horarios do agente: contas de fuso e distribuicao da frequencia semanal entre os horarios configurados.
// Fica em arquivo proprio porque o motor, a central e o chat de diagnostico usam as mesmas regras.

// deno-lint-ignore no-explicit-any
type Row = any;

const formatters = new Map<string, Intl.DateTimeFormat>();
export function tzOffsetMs(tz: string, at: Date): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

// Converte data e hora locais do fuso em instante. Duas passadas: a primeira estimativa pode cair do outro
// lado de uma virada de horario de verao.
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - tzOffsetMs(tz, new Date(wall));
  return new Date(wall - tzOffsetMs(tz, new Date(first)));
}

// Segunda-feira (data local) da semana que contem o instante.
export function weekStart(tz: string, at: Date): { y: number; m: number; d: number } {
  const local = new Date(at.getTime() + tzOffsetMs(tz, at));
  const dow = (local.getUTCDay() + 6) % 7; // 0 = segunda
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow));
  return { y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() };
}

// Horarios de uma semana: posts_per_week espalhados de forma regular entre os horarios do agente (seg a dom).
export function weekSlots(postTimes: string[], perWeek: number, tz: string, monday: { y: number; m: number; d: number }): Date[] {
  const times = [...new Set((postTimes ?? []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
  const T = times.length;
  if (!T) return [];
  // Primeiro reparte os posts pelos dias da semana, depois reveza os horarios de um dia para o outro:
  // assim todos os horarios configurados sao usados (7 por semana com dois horarios alterna os dois).
  const want = Math.max(1, Math.min(perWeek || 1, 7 * T));
  const perDay = new Array(7).fill(0);
  for (let k = 0; k < want; k++) perDay[Math.floor((k * 7) / want)]++;
  const out = new Map<number, Date>();
  for (let day = 0; day < 7; day++) {
    const base = new Date(Date.UTC(monday.y, monday.m - 1, monday.d + day));
    for (let j = 0; j < perDay[day]; j++) {
      const t = times[(day + j) % T];
      const at = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), +t.slice(0, 2), +t.slice(3), tz);
      out.set(at.getTime(), at); // dois horarios locais podem cair no mesmo instante em virada de horario de verao
    }
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

// Horarios que ja devem ter um post em producao: entre daqui a 10 minutos e daqui a lead_hours.
export function dueSlots(agent: Row, tz: string, now: Date): Date[] {
  const from = now.getTime() + 10 * 60_000, to = now.getTime() + (agent.lead_hours ?? 24) * 3_600_000;
  const out: Date[] = [];
  for (let w = 0; w * 7 * 86_400_000 <= (agent.lead_hours ?? 24) * 3_600_000 + 7 * 86_400_000; w++) {
    for (const s of weekSlots(agent.post_times ?? [], agent.posts_per_week ?? 3, tz, weekStart(tz, new Date(now.getTime() + w * 7 * 86_400_000)))) {
      if (s.getTime() > from && s.getTime() <= to) out.push(s);
    }
  }
  return out;
}

// Proximos horarios do agente (para a central), mesmo os que ainda nao entraram em producao.
export function nextSlots(agent: Row, tz: string, now: Date, count = 5): string[] {
  const out: Date[] = [];
  for (let w = 0; w < 3 && out.length < count; w++) {
    for (const s of weekSlots(agent.post_times ?? [], agent.posts_per_week ?? 3, tz, weekStart(tz, new Date(now.getTime() + w * 7 * 86_400_000)))) {
      if (s.getTime() > now.getTime() && out.length < count) out.push(s);
    }
  }
  return out.map((d) => d.toISOString());
}
