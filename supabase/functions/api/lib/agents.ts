// Motor dos agentes. Roda dentro do backend do Sr. Post, sem repositorio nem workflow por agente:
// o pg_cron chama /agents/tick a cada minuto e cada execucao (run) avanca uma etapa por vez:
//   planejar -> roteiro -> copy -> midia -> aprovacao -> publicar
// Cada etapa grava eventos reais em agent_events. A visao ao vivo e o chat de diagnostico leem esses eventos.
// Geracao de midia nunca espera dentro da chamada: inicia o job e consulta nos ciclos seguintes.
import { BUCKET, createCreatives, db, must, publicUrl, SUPABASE_URL } from "./core.ts";
import { AgentProfile, Copy, Formato, FORMATOS, GenConfigError, GenContext, MediaItem, MediaRequest, PlanItem, Script } from "./gentypes.ts";
import { mediaGeneratorFor, reviewCopy, textGeneratorFor } from "./generators.ts";

export const ENGINE_VERSION = "2026.11.1";
export const STEPS = ["planejar", "roteiro", "copy", "midia", "aprovacao", "publicar"] as const;
export type Step = typeof STEPS[number];
type Summary = Record<string, number | string | string[]>;

const LOCK_KEY = "agents_lock";
const LOCK_TTL_SECONDS = 170;
const TICK_BUDGET_MS = 75_000;   // nao comeca etapa nova depois disso; cada chamada externa tem o proprio limite
const MAX_ATTEMPTS = 3;
const MAX_REVISIONS = 3;
const RETRY_MINUTES = [2, 10, 30];
const MEDIA_TIMEOUT_MS = 6 * 3_600_000; // gerador externo que nao responde em 6 horas falha a etapa

// deno-lint-ignore no-explicit-any
type Row = any;

export const AGENT_FIELDS = "id, client_id, name, role_line, bio, tone, pillars, posts_per_week, post_times, platforms, status, context, audience, formats, voice, default_link, approval_mode, automation, text_provider, media_provider, story_default, ai_label, lead_hours, config_version, last_run_at, updated_at";

export function profileOf(agent: Row, client: Row): AgentProfile {
  const formats = ((agent.formats ?? []) as string[]).filter((f): f is Formato => (FORMATOS as string[]).includes(f));
  return {
    client_id: client.id, client_name: client.name, segment: client.segment ?? null, timezone: client.timezone || "America/Sao_Paulo", is_demo: client.is_demo === true,
    agent_name: agent.name, context: agent.context ?? agent.bio ?? "", audience: agent.audience ?? "", tone: agent.tone ?? "",
    pillars: agent.pillars ?? [], formats: formats.length ? formats : ["imagem"], platforms: agent.platforms?.length ? agent.platforms : ["instagram"],
    voice: agent.voice ?? {}, default_link: agent.default_link ?? null, ai_label: agent.ai_label !== false, story_default: agent.story_default === true,
  };
}

// ---------- Eventos ----------
export async function emit(run: { id: string | null; client_id: string }, step: string, status: string, message: string, detail: Record<string, unknown> | null = null, durationMs: number | null = null) {
  if (status === "falhou") console.error(JSON.stringify({ event: "agent_event", run_id: run.id, client_id: run.client_id, step, status, message, detail }));
  await db.from("agent_events").insert({ run_id: run.id, client_id: run.client_id, step, status, message: message.slice(0, 1000), detail, duration_ms: durationMs });
}

// ---------- Horarios ----------
function tzOffsetMs(tz: string, at: Date): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000;
}
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - tzOffsetMs(tz, new Date(guess)));
}
// Segunda-feira (data local) da semana que contem o instante.
function weekStart(tz: string, at: Date): { y: number; m: number; d: number } {
  const local = new Date(at.getTime() + tzOffsetMs(tz, at));
  const dow = (local.getUTCDay() + 6) % 7; // 0 = segunda
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow));
  return { y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() };
}

// Horarios de uma semana: posts_per_week espalhados de forma regular entre os horarios do agente (seg a dom).
export function weekSlots(postTimes: string[], perWeek: number, tz: string, monday: { y: number; m: number; d: number }): Date[] {
  const times = [...new Set(postTimes.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
  if (!times.length) return [];
  const all: Date[] = [];
  for (let day = 0; day < 7; day++) {
    const base = new Date(Date.UTC(monday.y, monday.m - 1, monday.d + day));
    for (const t of times) all.push(zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), +t.slice(0, 2), +t.slice(3), tz));
  }
  const want = Math.max(1, Math.min(perWeek, all.length));
  if (want >= all.length) return all;
  const picked = new Set<number>();
  for (let k = 0; k < want; k++) picked.add(Math.floor((k * all.length) / want));
  return all.filter((_, i) => picked.has(i));
}

// Horarios que ja devem ter um post em producao: entre daqui a 10 minutos e daqui a lead_hours.
export function dueSlots(agent: Row, tz: string, now: Date): Date[] {
  const from = now.getTime() + 10 * 60_000, to = now.getTime() + (agent.lead_hours ?? 24) * 3_600_000;
  const weeks = [weekStart(tz, now), weekStart(tz, new Date(now.getTime() + 7 * 86_400_000))];
  const out: Date[] = [];
  for (const w of weeks) for (const s of weekSlots(agent.post_times ?? [], agent.posts_per_week ?? 3, tz, w)) if (s.getTime() > from && s.getTime() <= to) out.push(s);
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

// ---------- Criacao de execucoes ----------
// Formato e pilar seguem um rodizio simples pelo numero de execucoes anteriores do agente.
export async function createRun(agent: Row, client: Row, trigger: "agenda" | "manual", slotAt: Date | null, formato?: Formato): Promise<Row> {
  const profile = profileOf(agent, client);
  const { count } = await db.from("agent_runs").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).neq("status", "cancelado");
  const n = count ?? 0;
  const format = formato && profile.formats.includes(formato) ? formato : profile.formats[n % profile.formats.length];
  const pilar = profile.pillars.length ? profile.pillars[n % profile.pillars.length] : null;
  const simulated = agent.text_provider === "simulado" || agent.media_provider === "simulado";
  const run = must(await db.from("agent_runs").insert({
    client_id: client.id, agent_id: agent.id, trigger, slot_at: slotAt ? slotAt.toISOString() : null, format,
    data: { pilar, config_version: agent.config_version ?? 1 }, simulated,
  }).select("*").single()) as Row;
  await emit(run, "planejar", "info", trigger === "manual" ? "Execução iniciada pelo time." : `Execução criada para o horário ${slotAt!.toISOString()}.`, { trigger, formato: format, pilar });
  await db.from("agents").update({ last_run_at: new Date().toISOString() }).eq("id", agent.id);
  return run;
}

async function scheduleRuns(sum: Summary) {
  const { data: agents } = await db.from("agents").select(`${AGENT_FIELDS}, clients!inner ( id, name, segment, timezone, is_demo, status )`).eq("automation", "ligada");
  const now = new Date();
  for (const a of agents ?? []) {
    const client = Array.isArray(a.clients) ? a.clients[0] : a.clients;
    if (!client || client.status !== "active") continue;
    const slots = dueSlots(a, client.timezone || "America/Sao_Paulo", now);
    if (!slots.length) continue;
    const { data: have } = await db.from("agent_runs").select("slot_at").eq("agent_id", a.id).neq("status", "cancelado").in("slot_at", slots.map((s) => s.toISOString()));
    const taken = new Set((have ?? []).map((r: Row) => new Date(r.slot_at).getTime()));
    for (const s of slots) {
      if (taken.has(s.getTime())) continue;
      try { await createRun(a, client, "agenda", s); sum.created = (sum.created as number) + 1; }
      catch (e) { (sum.errors as string[]).push(`agendar ${a.id}: ${e instanceof Error ? e.message : e}`); }
    }
  }
}

// ---------- Etapas ----------
async function context(run: Row): Promise<GenContext> {
  const { data: last } = await db.from("creatives").select("title").eq("client_id", run.client_id).is("story_of", null).order("created_at", { ascending: false }).limit(12);
  return {
    slot_at: run.slot_at, formato: run.format as Formato, pilar: run.data?.pilar ?? null,
    recentes: (last ?? []).map((c: Row) => c.title).filter(Boolean), feedback: run.data?.feedback ?? null, revision: run.revision ?? 0,
  };
}

function mediaRequest(formato: Formato, plan: PlanItem, script: Script): MediaRequest {
  const vertical = formato === "reel" || formato === "story";
  const slides = formato === "carrossel" ? script.slides.map((s, i) => `Slide ${i + 1}: ${s.titulo}. ${s.texto}`) : [];
  const texto = formato === "carrossel" ? script.slides.map((s) => s.titulo) : script.beats.map((b) => b.tela).filter(Boolean);
  const lines = [
    `Formato: ${formato} (${vertical ? "9:16" : "4:5"})`, `Tema: ${plan.tema}`, `Ângulo: ${plan.angulo}`, `Abertura: ${script.hook}`,
    `Visual: ${script.conceito_visual}`,
    ...(script.beats.length ? ["Roteiro:", ...script.beats.map((b) => `  ${b.tempo}  fala: ${b.fala}  | tela: ${b.tela}`)] : []),
    ...(slides.length ? ["Slides:", ...slides.map((s) => `  ${s}`)] : []),
  ];
  return {
    formato, proporcao: vertical ? "9:16" : "4:5", prompt: script.conceito_visual, slides, texto_na_arte: texto,
    duracao_s: formato === "reel" ? script.duracao_s ?? 20 : null, briefing: lines.join("\n"),
  };
}

// Midia de fornecedor externo vai para o nosso armazenamento: a URL do fornecedor pode expirar antes da publicacao.
async function storeMedia(clientId: string, item: MediaItem): Promise<MediaItem> {
  if (item.url.startsWith(`${SUPABASE_URL}/storage/`)) return item;
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`Não foi possível baixar a mídia gerada (HTTP ${res.status}).`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0];
  const ext: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  if (!ext[type]) throw new Error(`O gerador devolveu um tipo de arquivo não aceito (${type || "desconhecido"}).`);
  const blob = await res.blob();
  if (blob.size > 50 * 1024 * 1024) throw new Error("A mídia gerada passa de 50 MB.");
  const path = `${clientId}/${crypto.randomUUID()}-agente.${ext[type]}`;
  const { error } = await db.storage.from(BUCKET).upload(path, blob, { contentType: type });
  if (error) throw new Error(`Falha ao guardar a mídia: ${error.message}`);
  return { kind: item.kind, url: publicUrl(path), thumb: item.thumb };
}

function creativeItem(run: Row, profile: AgentProfile): Record<string, unknown> {
  const copy = run.data.copy as Copy, media = run.data.media as MediaItem[], formato = run.format as Formato;
  const base: Record<string, unknown> = {
    title: copy.titulo, caption: formato === "story" ? "" : copy.legenda, hashtags: formato === "story" ? "" : copy.hashtags,
    link: formato === "story" ? undefined : profile.default_link ?? undefined,
    platforms: profile.platforms, suggested_at: run.slot_at, ai_generated: profile.ai_label,
    options: { story: profile.story_default }, external_ref: `run:${run.id}:${run.revision ?? 0}`,
    revision_of: run.data.prev_creative_id ?? undefined,
  };
  if (formato === "carrossel" && media.length > 1) return { ...base, format: "feed", media: media.slice(0, 10).map((m) => ({ media_url: m.url, kind: m.kind, thumb_url: m.thumb ?? undefined })) };
  const m = media[0];
  if (formato === "reel" && m.kind !== "video") throw new Error("O formato Reel precisa de um vídeo, e a mídia recebida é uma imagem.");
  const format = formato === "reel" ? "reel" : formato === "story" ? "story" : m.kind === "video" ? "reel" : "feed";
  return { ...base, format, kind: m.kind, media_url: m.url, thumb_url: m.thumb ?? undefined };
}

type StepResult = { step?: Step; status?: string; waitMinutes?: number; patch?: Record<string, unknown> };

// Executa a etapa atual de uma execucao. Devolve para onde ela vai.
async function runStep(run: Row, agent: Row, client: Row): Promise<StepResult> {
  const profile = profileOf(agent, client);
  const step = run.step as Step;
  const t0 = Date.now();
  if (step === "planejar" || step === "roteiro" || step === "copy") {
    const gen = textGeneratorFor(agent, profile);
    const ctx = await context(run);
    await emit(run, step, "iniciou", { planejar: "Escolhendo o tema do post.", roteiro: "Escrevendo o roteiro e as opções de abertura.", copy: "Escrevendo a legenda e as hashtags." }[step], { provider: gen.provider, formato: run.format, revisao: run.revision ?? 0 });
    if (step === "planejar") {
      const r = await gen.plan(profile, ctx);
      await emit(run, step, "ok", `Tema: ${r.value.tema}`, { plan: r.value, usage: r.usage }, Date.now() - t0);
      return { step: "roteiro", patch: { plan: r.value } };
    }
    if (step === "roteiro") {
      const r = await gen.script(profile, run.data.plan, ctx);
      await emit(run, step, "ok", `Abertura: ${r.value.hook}`, { hooks: r.value.hooks, beats: r.value.beats.length, slides: r.value.slides.length, usage: r.usage }, Date.now() - t0);
      return { step: "copy", patch: { script: r.value } };
    }
    const r = await gen.copy(profile, run.data.plan, run.data.script, ctx);
    const reviewed = reviewCopy(r.value, profile);
    await emit(run, step, "ok", `Legenda pronta (${reviewed.legenda.length} caracteres).`, { titulo: reviewed.titulo, alertas: reviewed.alertas, usage: r.usage }, Date.now() - t0);
    return { step: "midia", patch: { copy: reviewed } };
  }

  if (step === "midia") {
    const gen = mediaGeneratorFor(agent, profile);
    // Em nova versao pedida pelo cliente, a midia anterior continua valendo quando quem produz e o time.
    if (!run.data.media_job) {
      const req = mediaRequest(run.format as Formato, run.data.plan, run.data.script);
      const job = await gen.start(req, profile);
      await emit(run, step, "iniciou", gen.mode === "manual" ? "Aguardando o time enviar a mídia deste post." : `Pedido enviado ao gerador de mídia (${gen.provider}).`, { provider: gen.provider, modo: gen.mode, briefing: req.briefing, nota: job.note });
      return { status: "aguardando_midia", waitMinutes: 1, patch: { media_request: req, media_job: { provider: gen.provider, mode: gen.mode, ref: job.ref, started_at: new Date().toISOString() } } };
    }
    const job = run.data.media_job;
    // Midia manual: o time envia pelo painel e o envio grava data.media_manual.
    const res = gen.mode === "manual"
      ? (Array.isArray(run.data.media_manual) && run.data.media_manual.length ? { state: "ready" as const, items: run.data.media_manual as MediaItem[] } : { state: "pending" as const, note: null })
      : await gen.poll(job.ref, profile);
    if (res.state === "pending") {
      if (gen.mode !== "manual" && Date.now() - new Date(job.started_at).getTime() > MEDIA_TIMEOUT_MS) throw new Error("O gerador de mídia não respondeu em 6 horas.");
      // O fornecedor pode trocar a referencia ao passar para a etapa seguinte (imagem pronta, video em geracao).
      const moved = "ref" in res && res.ref && res.ref !== job.ref;
      if (moved) await emit(run, step, "info", res.note ?? "O gerador passou para a etapa seguinte.", { provider: gen.provider });
      return { status: "aguardando_midia", waitMinutes: gen.mode === "manual" ? 2 : 1, ...(moved ? { patch: { media_job: { ...job, ref: res.ref } } } : {}) };
    }
    if (res.state === "failed") throw new Error(`O gerador de mídia falhou: ${res.error}`);
    const items: MediaItem[] = [];
    for (const it of res.items) items.push(await storeMedia(run.client_id, it));
    if (!items.length) throw new Error("O gerador não devolveu nenhuma mídia.");
    await emit(run, step, "ok", `${items.length === 1 ? "Mídia pronta" : items.length + " mídias prontas"} (${gen.provider}).`, { itens: items.map((i) => ({ kind: i.kind, url: i.url })) }, Date.now() - new Date(job.started_at).getTime());
    return { step: "aprovacao", status: "rodando", patch: { media: items } };
  }

  if (step === "aprovacao") {
    const item = creativeItem(run, profile);
    const made = await createCreatives(run.client_id, [item], "api");
    let creativeId = (made.created[0] as Row | undefined)?.id as string | undefined;
    if (!creativeId) {
      const { data } = await db.from("creatives").select("id").eq("client_id", run.client_id).eq("external_ref", item.external_ref as string).maybeSingle();
      creativeId = data?.id;
    }
    if (!creativeId) throw new Error("Não foi possível colocar o criativo na fila do cliente.");
    await db.from("agent_runs").update({ creative_id: creativeId }).eq("id", run.id);
    if (agent.approval_mode === "automatica") {
      const res = must(await db.rpc("portal_decide_opts", { p_client_id: run.client_id, p_creative_id: creativeId, p_action: "approve", p_comment: null, p_via: "admin", p_options: null })) as Row;
      if (!res?.ok) throw new Error(`A aprovação automática não foi registrada (${res?.error ?? "erro"}).`);
      await emit(run, step, "ok", "Aprovado automaticamente (modo do agente).", { creative_id: creativeId, scheduled_for: res.scheduled_for, platforms: res.platforms, story: res.story });
      await emit(run, "publicar", "aguardando", `Agendado para ${res.scheduled_for}.`, { scheduled_for: res.scheduled_for });
      return { step: "publicar", status: "publicando", waitMinutes: 1, patch: { posts_seen: {} } };
    }
    await emit(run, step, "aguardando", "Na fila de aprovação do cliente, no portal.", { creative_id: creativeId, revisao: run.revision ?? 0 });
    return { status: "aguardando_aprovacao", waitMinutes: 1 };
  }
  return {};
}

async function finish(run: Row, status: "concluido" | "falhou" | "cancelado", error: string | null = null, code: string | null = null) {
  await db.from("agent_runs").update({ status, error, error_code: code, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", run.id);
}

// Avanca cada execucao pronta. Etapas rapidas seguem em sequencia no mesmo ciclo (ate 4 por execucao),
// sempre respeitando o teto de tempo: nenhuma etapa nova comeca depois de TICK_BUDGET_MS.
async function advanceRuns(sum: Summary, startedAt: number) {
  const { data: runs } = await db.from("agent_runs").select("*").in("status", ["rodando", "aguardando_midia"]).lte("next_step_at", new Date().toISOString()).order("next_step_at").limit(12);
  for (const first of runs ?? []) {
    if (Date.now() - startedAt > TICK_BUDGET_MS) { sum.deferred = (sum.deferred as number) + 1; continue; }
    const { data: agent } = await db.from("agents").select(`${AGENT_FIELDS}, clients ( id, name, segment, timezone, is_demo, status )`).eq("id", first.agent_id).maybeSingle();
    const client = agent ? (Array.isArray(agent.clients) ? agent.clients[0] : agent.clients) : null;
    if (!agent || !client) { await finish(first, "cancelado", "Agente ou cliente removido."); continue; }
    let run = first;
    for (let hop = 0; hop < 4 && Date.now() - startedAt <= TICK_BUDGET_MS; hop++) {
      try {
        const r = await runStep(run, agent, client);
        const moved = Boolean(r.step && r.step !== run.step);
        const next: Record<string, unknown> = {
          step: r.step ?? run.step, status: r.status ?? "rodando", attempts: moved ? 0 : run.attempts,
          error: null, error_code: null, updated_at: new Date().toISOString(),
          next_step_at: new Date(Date.now() + (r.waitMinutes ?? 0) * 60_000).toISOString(),
        };
        if (r.patch) next.data = { ...run.data, ...r.patch };
        await db.from("agent_runs").update(next).eq("id", run.id);
        sum.steps = (sum.steps as number) + 1;
        run = { ...run, ...next };
        // So continua no mesmo ciclo quando a etapa terminou e a proxima nao precisa esperar ninguem.
        if (!moved || (r.waitMinutes ?? 0) > 0 || next.status !== "rodando") break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const config = e instanceof GenConfigError;
        const attempts = (run.attempts ?? 0) + 1;
        const final = config || attempts >= MAX_ATTEMPTS;
        (sum.errors as string[]).push(`${run.step} ${run.id}: ${message}`);
        await emit(run, run.step, "falhou", message, { tentativa: attempts, definitivo: final, codigo: config ? (e as GenConfigError).code : null });
        if (final) await finish(run, "falhou", message.slice(0, 500), config ? (e as GenConfigError).code : "etapa_falhou");
        else {
          await db.from("agent_runs").update({
            attempts, error: message.slice(0, 500), updated_at: new Date().toISOString(),
            next_step_at: new Date(Date.now() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000).toISOString(),
          }).eq("id", run.id);
        }
        break;
      }
    }
  }
}

// ---------- Aprovacao e publicacao: o motor observa o que o cliente e o publicador fizeram ----------
const NET: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok" };

async function observeRuns(sum: Summary) {
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { data: waiting } = await db.from("agent_runs").select("*").in("status", ["aguardando_aprovacao", "publicando"]).not("creative_id", "is", null).limit(300);
  // Post que falhou e o cliente mandou tentar de novo: a execucao volta a ser acompanhada.
  const { data: failed } = await db.from("agent_runs").select("*").eq("status", "falhou").eq("step", "publicar").not("creative_id", "is", null).gte("finished_at", recent).limit(100);
  const runs = [...(waiting ?? []), ...(failed ?? [])] as Row[];
  if (!runs.length) return;
  const ids = runs.map((r) => r.creative_id);
  const [{ data: creatives }, { data: kids }] = await Promise.all([
    db.from("creatives").select("id, status, decision_comment, decided_at").in("id", ids),
    db.from("creatives").select("id, story_of").in("story_of", ids),
  ]);
  const kidOf = new Map<string, string>((kids ?? []).map((k: Row) => [k.id, k.story_of]));
  const { data: posts } = await db.from("posts").select("id, creative_id, platform, status, scheduled_for, published_at, permalink, last_error, last_error_code").in("creative_id", [...ids, ...kidOf.keys()]);
  const byCreative = new Map<string, Row>((creatives ?? []).map((c: Row) => [c.id, c]));
  for (const run of runs) {
    const c = byCreative.get(run.creative_id);
    if (!c) { await finish(run, "cancelado", "O criativo foi removido."); await emit(run, run.step, "info", "O criativo desta execução foi removido."); continue; }
    try {
      if (run.status === "aguardando_aprovacao") {
        if (c.status === "pending") continue;
        if (c.status === "approved") {
          await emit(run, "aprovacao", "ok", "Aprovado pelo cliente.", { decided_at: c.decided_at });
          await db.from("agent_runs").update({ step: "publicar", status: "publicando", data: { ...run.data, posts_seen: {} }, updated_at: new Date().toISOString() }).eq("id", run.id);
          run.status = "publicando"; run.step = "publicar"; run.data = { ...run.data, posts_seen: {} };
        } else if (c.status === "rejected") {
          await emit(run, "aprovacao", "ok", "Reprovado pelo cliente. O agente não publica este post.", { decisao: "reprovado" });
          await db.from("agent_runs").update({ data: { ...run.data, resultado: "reprovado" } }).eq("id", run.id);
          await finish(run, "concluido"); continue;
        } else if (c.status === "adjust") {
          const feedback = c.decision_comment ?? "";
          if ((run.revision ?? 0) + 1 > MAX_REVISIONS) {
            await emit(run, "aprovacao", "falhou", `O cliente pediu ajuste pela ${run.revision + 1}ª vez. O agente parou para o time assumir.`, { pedido: feedback });
            await finish(run, "falhou", "Limite de versões atingido.", "limite_revisoes"); continue;
          }
          await emit(run, "aprovacao", "info", `O cliente pediu ajuste: ${feedback}`, { pedido: feedback, revisao: (run.revision ?? 0) + 1 });
          // Nova versao: refaz roteiro e copy com o pedido do cliente. A midia e refeita pelo gerador; no modo manual o time decide.
          const { media_job: _j, media: _m, media_manual: _mm, copy: _c, script: _s, ...keep } = run.data;
          const manual = run.data.media_job?.mode === "manual";
          await db.from("agent_runs").update({
            step: "roteiro", status: "rodando", revision: (run.revision ?? 0) + 1, attempts: 0, next_step_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            data: { ...keep, feedback, prev_creative_id: run.creative_id, ...(manual && run.data.media ? { media_manual: run.data.media } : {}) },
          }).eq("id", run.id);
          continue;
        } else continue; // replaced: outra versao assumiu
      }
      // publicando (ou falhou na publicacao): compara o estado de cada post com o ultimo visto.
      const mine = (posts ?? []).filter((p: Row) => p.creative_id === run.creative_id || kidOf.get(p.creative_id) === run.creative_id);
      const seen: Record<string, string> = { ...(run.data.posts_seen ?? {}) };
      let changed = false;
      for (const p of mine) {
        if (seen[p.id] === p.status) continue;
        const where = `${NET[p.platform] ?? p.platform}${kidOf.has(p.creative_id) ? " (story)" : ""}`;
        if (p.status === "scheduled" && !seen[p.id]) await emit(run, "publicar", "aguardando", `${where}: agendado para ${p.scheduled_for}.`, { post_id: p.id, platform: p.platform, scheduled_for: p.scheduled_for });
        else if (p.status === "scheduled") await emit(run, "publicar", "aguardando", `${where}: voltou para a fila${p.last_error ? ` (${p.last_error})` : ""}.`, { post_id: p.id, platform: p.platform, scheduled_for: p.scheduled_for, erro: p.last_error, codigo: p.last_error_code });
        else if (p.status === "processing") await emit(run, "publicar", "iniciou", `${where}: enviando para a rede.`, { post_id: p.id, platform: p.platform });
        else if (p.status === "published") await emit(run, "publicar", "ok", `${where}: publicado.`, { post_id: p.id, platform: p.platform, permalink: p.permalink, published_at: p.published_at });
        else if (p.status === "failed") await emit(run, "publicar", "falhou", `${where}: a rede recusou. ${p.last_error ?? ""}`.trim(), { post_id: p.id, platform: p.platform, erro: p.last_error, codigo: p.last_error_code });
        seen[p.id] = p.status; changed = true;
      }
      if (!mine.length) continue;
      const open = mine.some((p: Row) => p.status === "scheduled" || p.status === "processing");
      const anyFailed = mine.some((p: Row) => p.status === "failed");
      const status = open ? "publicando" : anyFailed ? "falhou" : "concluido";
      if (changed || status !== run.status) {
        await db.from("agent_runs").update({
          data: { ...run.data, posts_seen: seen }, status, step: "publicar", updated_at: new Date().toISOString(),
          finished_at: open ? null : new Date().toISOString(),
          error: status === "falhou" ? "Uma ou mais redes recusaram o post." : null, error_code: status === "falhou" ? "publicacao_falhou" : null,
        }).eq("id", run.id);
        sum.observed = (sum.observed as number) + 1;
      }
    } catch (e) {
      (sum.errors as string[]).push(`observar ${run.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export async function runAgents(): Promise<Summary> {
  const { data: locked } = await db.rpc("try_lock", { p_key: LOCK_KEY, p_ttl_seconds: LOCK_TTL_SECONDS });
  if (!locked) return { skipped: "outra execução em andamento" };
  const sum: Summary = { created: 0, steps: 0, observed: 0, deferred: 0, errors: [] };
  const t0 = Date.now();
  try {
    await scheduleRuns(sum);
    await observeRuns(sum);
    await advanceRuns(sum, t0);
    await db.from("settings").upsert({ key: "agents_last_run", value: JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, version: ENGINE_VERSION, ...sum }) });
  } finally {
    await db.from("settings").delete().eq("key", LOCK_KEY);
  }
  return sum;
}
