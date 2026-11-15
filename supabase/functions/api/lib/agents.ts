// Motor dos agentes. Roda dentro do backend do Sr. Post, sem repositorio nem workflow por agente:
// o pg_cron chama o agendador a cada minuto e cada execucao (run) avanca pelas etapas
//   planejar -> roteiro -> copy -> midia -> aprovacao -> publicar
// Cada etapa grava eventos reais em agent_events. A visao ao vivo e o chat de diagnostico leem esses eventos.
// Geracao de midia demorada nunca espera dentro da chamada: inicia o job e consulta nos ciclos seguintes.
import { BUCKET, createCreatives, db, must, publicUrl, SUPABASE_URL } from "./core.ts";
import { AgentProfile, Copy, Formato, FORMATOS, GenConfigError, GenContext, MediaGenerator, MediaItem, MediaRequest, PlanItem, Script, TextGenerator } from "./gentypes.ts";
import { mediaGeneratorFor, reviewCopy, textGeneratorFor } from "./generators.ts";
import { templateGenerator } from "./template.ts";
import { bankGenerator } from "./bank.ts";
import { existingThemes } from "./profile.ts";
import { dueSlots, tzOffsetMs, weekStart } from "./slots.ts";
export { nextSlots } from "./slots.ts";

export const ENGINE_VERSION = "2026.11.2";
export const STEPS = ["planejar", "roteiro", "copy", "midia", "aprovacao", "publicar"] as const;
export type Step = typeof STEPS[number];
type Summary = Record<string, number | string | string[]>;

const LOCK_KEY = "agents_lock";
const LOCK_TTL_SECONDS = 170;
const TICK_BUDGET_MS = 75_000;   // nao comeca etapa nova depois disso; cada chamada externa tem o proprio limite
const MAX_ATTEMPTS = 4;          // tentativas por etapa: a primeira e mais tres, em 2, 10 e 30 minutos
const RETRY_MINUTES = [2, 10, 30];
const LEASE_MINUTES = 5;         // reserva da etapa: se a funcao cair no meio, a execucao volta depois disso
const MAX_REVISIONS = 3;
const MEDIA_TIMEOUT_MS = 6 * 3_600_000; // gerador externo que nao responde em 6 horas falha a etapa
const OPEN = ["rodando", "aguardando_midia"];
export const ACTIVE = ["rodando", "aguardando_midia", "aguardando_aprovacao", "publicando"];

// deno-lint-ignore no-explicit-any
type Row = any;

export { AGENT_FIELDS } from "./agentcfg.ts";
import { AGENT_FIELDS } from "./agentcfg.ts";
const CLIENT_FIELDS = "id, name, segment, timezone, is_demo, status";

export function profileOf(agent: Row, client: Row): AgentProfile {
  const platforms: string[] = agent.platforms?.length ? agent.platforms : ["instagram"];
  // Story so existe no Instagram: um agente so de TikTok nao produz story.
  const formats = ((agent.formats ?? []) as string[]).filter((f): f is Formato => (FORMATOS as string[]).includes(f) && (f !== "story" || platforms.includes("instagram")));
  return {
    client_id: client.id, client_name: client.name, segment: client.segment ?? null, timezone: client.timezone || "America/Sao_Paulo", is_demo: client.is_demo === true,
    agent_name: agent.name, context: agent.context ?? agent.bio ?? "", audience: agent.audience ?? "", tone: agent.tone ?? "",
    pillars: agent.pillars ?? [], formats: formats.length ? formats : ["imagem"], platforms,
    voice: agent.voice ?? {}, default_link: agent.default_link ?? null, ai_label: agent.ai_label !== false, story_default: agent.story_default === true,
    brand: agent.brand ?? {},
  };
}

// ---------- Fornecedores ----------
function textGen(agent: Row, profile: AgentProfile): TextGenerator {
  return agent.text_provider === "banco" ? bankGenerator(profile) : textGeneratorFor(agent, profile);
}
// "template" e a arte montada pela propria plataforma. Ela nao produz video: no Reel, o time envia o video.
function mediaGen(provider: string, agent: Row, profile: AgentProfile, formato: Formato): MediaGenerator {
  if (provider === "template") return formato === "reel" ? mediaGeneratorFor({ ...agent, media_provider: "manual" }, profile) : templateGenerator;
  return mediaGeneratorFor({ ...agent, media_provider: provider }, profile);
}

// ---------- Eventos ----------
export async function emit(run: { id: string | null; client_id: string }, step: string, status: string, message: string, detail: Record<string, unknown> | null = null, durationMs: number | null = null) {
  if (status === "falhou") console.error(JSON.stringify({ event: "agent_event", run_id: run.id, client_id: run.client_id, step, status, message, detail }));
  const ms = durationMs == null ? null : Math.max(0, Math.min(2_000_000_000, Math.round(durationMs)));
  const { error } = await db.from("agent_events").insert({ run_id: run.id, client_id: run.client_id, step, status, message: message.slice(0, 1000), detail, duration_ms: ms });
  if (error) console.error(JSON.stringify({ event: "agent_event_insert_failed", run_id: run.id, error: error.message }));
}

// O cron dispara no segundo zero de cada minuto. Mira 5 s antes do ciclo desejado para a espera nao
// perder a rodada por segundos. Sem espera, a execucao fica pronta para o proprio ciclo em andamento.
const waitAt = (minutes: number) => minutes > 0
  ? new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutes * 60_000 - 5_000).toISOString()
  : new Date().toISOString();

// Grava a execucao so se ela ainda estiver em um dos estados esperados. Devolve a linha nova, ou null
// quando outra acao (cancelar, retomar, outro ciclo) mudou a execucao no meio do caminho.
export async function writeRun(run: Row, patch: Record<string, unknown>, expect: string[]): Promise<Row | null> {
  const rows = must(await db.from("agent_runs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", run.id).in("status", expect).select("*")) as Row[];
  return rows?.[0] ?? null;
}

async function finish(run: Row, status: "concluido" | "falhou" | "cancelado", error: string | null = null, code: string | null = null, extra: Record<string, unknown> = {}) {
  must(await db.from("agent_runs").update({ status, error, error_code: code, finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra }).eq("id", run.id));
}

// ---------- Criacao de execucoes ----------
// Formato e pilar seguem rodizio pelo numero de execucoes do agente. O pilar avanca a cada volta completa
// dos formatos, para todas as combinacoes aparecerem.
export async function createRun(agent: Row, client: Row, trigger: "agenda" | "manual", slotAt: Date | null, formato?: Formato): Promise<Row> {
  const profile = profileOf(agent, client);
  const { count } = await db.from("agent_runs").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).neq("status", "cancelado");
  const n = count ?? 0;
  const format = formato && profile.formats.includes(formato) ? formato : profile.formats[n % profile.formats.length];
  const pilar = profile.pillars.length ? profile.pillars[Math.floor(n / profile.formats.length) % profile.pillars.length] : null;
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
  const agents = must(await db.from("agents").select(`${AGENT_FIELDS}, clients!inner ( ${CLIENT_FIELDS} )`).eq("automation", "ligada")) ?? [];
  const now = new Date();
  for (const a of agents as Row[]) {
    // Um agente com configuracao invalida nao pode parar os outros.
    try {
      const client = Array.isArray(a.clients) ? a.clients[0] : a.clients;
      if (!client || client.status !== "active") continue;
      const tz = client.timezone || "America/Sao_Paulo";
      const slots = dueSlots(a, tz, now);
      if (!slots.length) continue;
      // Execucao cancelada tambem ocupa o horario: cancelar um post nao faz o agente gerar outro no lugar.
      const since = new Date(now.getTime() - 8 * 86_400_000).toISOString();
      // A excecao e a execucao cancelada por mudanca de horarios, que existe justamente para ser recriada.
      const recent = (must(await db.from("agent_runs").select("slot_at, status, error_code").eq("agent_id", a.id).eq("trigger", "agenda").gte("slot_at", since)) ?? []) as Row[];
      const taken = new Set(recent.filter((r) => !(r.status === "cancelado" && r.error_code === "horarios_alterados")).map((r) => new Date(r.slot_at).getTime()));
      // Teto da semana: mudar os horarios no meio da semana nao pode render mais posts que a frequencia.
      const weekKey = (d: Date) => { const w = weekStart(tz, d); return `${w.y}-${w.m}-${w.d}`; };
      const perWeek: Record<string, number> = {};
      for (const r of recent) if (r.status !== "cancelado") { const k = weekKey(new Date(r.slot_at)); perWeek[k] = (perWeek[k] ?? 0) + 1; }
      for (const s of slots) {
        const k = weekKey(s);
        if (taken.has(s.getTime()) || (perWeek[k] ?? 0) >= (a.posts_per_week ?? 3)) continue;
        await createRun(a, client, "agenda", s);
        perWeek[k] = (perWeek[k] ?? 0) + 1; taken.add(s.getTime());
        sum.created = (sum.created as number) + 1;
      }
    } catch (e) {
      (sum.errors as string[]).push(`agendar ${a.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ---------- Etapas ----------
async function context(run: Row): Promise<GenContext> {
  // Temas a evitar: o que o perfil ja tem (criativos e legendas publicadas) e o que as outras execucoes
  // deste agente ja planejaram e ainda nao viraram criativo.
  const [themes, others] = await Promise.all([
    existingThemes(run.client_id),
    db.from("agent_runs").select("tema:data->plan->>tema").eq("agent_id", run.agent_id).neq("id", run.id).neq("status", "cancelado").order("started_at", { ascending: false }).limit(15),
  ]);
  const planned = ((others.data ?? []) as Row[]).map((r) => r.tema).filter(Boolean);
  return {
    slot_at: run.slot_at, formato: run.format as Formato, pilar: run.data?.pilar ?? null,
    recentes: [...new Set([...planned, ...themes])].slice(0, 60), feedback: run.data?.feedback ?? null, revision: run.revision ?? 0, run_id: run.id,
  };
}

async function signature(profile: AgentProfile): Promise<string> {
  if (profile.brand?.assinatura) return profile.brand.assinatura;
  const { data } = await db.from("social_accounts").select("username, simulated").eq("client_id", profile.client_id).eq("platform", "instagram").maybeSingle();
  return data?.username && !data.simulated ? `@${data.username}` : profile.client_name;
}

function mediaRequest(formato: Formato, plan: PlanItem, script: Script, profile: AgentProfile, assinatura: string): MediaRequest {
  const vertical = formato === "reel" || formato === "story";
  const slides = (script.slides ?? []).filter((s) => s?.titulo);
  const texto = formato === "carrossel" ? slides.map((s) => s.titulo) : (script.beats ?? []).map((b) => b.tela).filter(Boolean);
  const lines = [
    `Formato: ${formato} (${vertical ? "9:16" : "4:5"})`, `Tema: ${plan.tema}`, `Ângulo: ${plan.angulo}`, `Abertura: ${script.hook}`,
    `Visual: ${script.conceito_visual}`,
    ...((script.beats ?? []).length ? ["Roteiro:", ...script.beats.map((b) => `  ${b.tempo}  fala: ${b.fala}  | tela: ${b.tela}`)] : []),
    ...(slides.length ? ["Texto da arte:", ...slides.map((s, i) => `  ${i + 1}. ${s.titulo}${s.texto ? ": " + s.texto.replace(/\n+/g, " / ") : ""}`)] : []),
  ];
  // Texto da arte: carrossel usa todos os slides; imagem e story usam o primeiro (ou a abertura, se o roteiro nao trouxe).
  const arte = formato === "carrossel" ? slides : [slides[0] ?? { titulo: script.hook, texto: plan.angulo }];
  const { assinatura: _a, ...brand } = profile.brand ?? {};
  return {
    formato, proporcao: vertical ? "9:16" : "4:5", prompt: script.conceito_visual, slides: formato === "carrossel" ? slides.map((s, i) => `Slide ${i + 1}: ${s.titulo}. ${s.texto}`) : [],
    texto_na_arte: texto, duracao_s: formato === "reel" ? script.duracao_s ?? 20 : null, briefing: lines.join("\n"),
    arte: { kicker: plan.pilar || profile.pillars[0] || "", slides: arte, cta: profile.voice?.cta ?? "", assinatura, brand },
  };
}

// Erro da etapa de midia em que o job do fornecedor morreu: a proxima tentativa precisa comecar um job novo.
class MediaJobError extends Error {}

// Midia de fornecedor externo vai para o nosso armazenamento: a URL do fornecedor pode expirar antes da publicacao.
async function storeMedia(clientId: string, item: MediaItem): Promise<MediaItem> {
  if (item.url.startsWith(`${SUPABASE_URL}/storage/`)) return item;
  let host = "";
  try { const u = new URL(item.url); if (u.protocol !== "https:") throw new Error(); host = u.hostname; } catch (_) { throw new Error("O gerador devolveu um endereço de mídia inválido."); }
  // So endereco publico: nunca busca em rede interna a pedido de um fornecedor.
  if (/^(localhost|.*\.local|.*\.internal|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(host)) throw new Error("O gerador devolveu um endereço de mídia não permitido.");
  const res = await fetch(item.url, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`Não foi possível baixar a mídia gerada (HTTP ${res.status}).`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0];
  const ext: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  if (!ext[type]) { await res.body?.cancel(); throw new Error(`O gerador devolveu um tipo de arquivo não aceito (${type || "desconhecido"}).`); }
  if (Number(res.headers.get("content-length") ?? 0) > 50 * 1024 * 1024) { await res.body?.cancel(); throw new Error("A mídia gerada passa de 50 MB."); }
  const blob = await res.blob();
  if (blob.size > 50 * 1024 * 1024) throw new Error("A mídia gerada passa de 50 MB.");
  const path = `${clientId}/${crypto.randomUUID()}-agente.${ext[type]}`;
  const { error } = await db.storage.from(BUCKET).upload(path, blob, { contentType: type });
  if (error) throw new Error(`Falha ao guardar a mídia: ${error.message}`);
  return { kind: item.kind, url: publicUrl(path), thumb: item.thumb };
}

function creativeItem(run: Row, profile: AgentProfile, revisionOf: string | null): Record<string, unknown> {
  const copy = run.data.copy as Copy, media = run.data.media as MediaItem[], formato = run.format as Formato;
  const base: Record<string, unknown> = {
    title: copy.titulo, caption: formato === "story" ? "" : copy.legenda, hashtags: formato === "story" ? "" : copy.hashtags,
    link: formato === "story" ? undefined : profile.default_link ?? undefined,
    platforms: profile.platforms, suggested_at: run.slot_at, ai_generated: profile.ai_label,
    options: { story: profile.story_default }, external_ref: `run:${run.id}:${run.revision ?? 0}`,
    revision_of: revisionOf ?? undefined,
  };
  if (formato === "carrossel" && media.length > 1) return { ...base, format: "feed", media: media.slice(0, 10).map((m) => ({ media_url: m.url, kind: m.kind, thumb_url: m.thumb ?? undefined })) };
  const m = media[0];
  if (formato === "reel" && m.kind !== "video") throw new Error("O formato Reel precisa de um vídeo, e a mídia recebida é uma imagem.");
  const format = formato === "reel" ? "reel" : formato === "story" ? "story" : m.kind === "video" ? "reel" : "feed";
  return { ...base, format, kind: m.kind, media_url: m.url, thumb_url: m.thumb ?? undefined };
}

// Quem decidiu por ultimo: o evento tem que dizer a verdade (cliente no portal ou time no painel).
async function decidedBy(creativeId: string): Promise<string> {
  const { data } = await db.from("decisions").select("via").eq("creative_id", creativeId).order("created_at", { ascending: false }).limit(1);
  return data?.[0]?.via === "admin" ? "pelo time, no painel" : "pelo cliente, no portal";
}

type StepResult = { step?: Step; status?: string; waitMinutes?: number; patch?: Record<string, unknown>; columns?: Record<string, unknown> };

// Executa a etapa atual de uma execucao. Devolve para onde ela vai.
async function runStep(run: Row, agent: Row, client: Row): Promise<StepResult> {
  const profile = profileOf(agent, client);
  const step = run.step as Step;
  const t0 = Date.now();
  if (step === "planejar" || step === "roteiro" || step === "copy") {
    const gen = textGen(agent, profile);
    const ctx = await context(run);
    await emit(run, step, "iniciou", { planejar: "Escolhendo o tema do post.", roteiro: "Escrevendo o roteiro e o texto da arte.", copy: "Escrevendo a legenda e as hashtags." }[step], { provider: gen.provider, formato: run.format, revisao: run.revision ?? 0 });
    if (step === "planejar") {
      const r = await gen.plan(profile, ctx);
      const { formato, ...plan } = r.value;
      const switched = formato && formato !== run.format && profile.formats.includes(formato);
      await emit(run, step, "ok", `Tema: ${plan.tema}${switched ? ` (formato da pauta: ${formato})` : ""}`, { plan, usage: r.usage }, Date.now() - t0);
      return { step: "roteiro", patch: { plan }, ...(switched ? { columns: { format: formato } } : {}) };
    }
    if (step === "roteiro") {
      const r = await gen.script(profile, run.data.plan, ctx);
      await emit(run, step, "ok", `Abertura: ${r.value.hook}`, { hooks: r.value.hooks, beats: (r.value.beats ?? []).length, slides: (r.value.slides ?? []).length, usage: r.usage }, Date.now() - t0);
      return { step: "copy", patch: { script: r.value } };
    }
    const r = await gen.copy(profile, run.data.plan, run.data.script, ctx);
    const reviewed = reviewCopy(r.value, profile);
    await emit(run, step, "ok", `Legenda pronta (${reviewed.legenda.length} caracteres).`, { titulo: reviewed.titulo, alertas: reviewed.alertas, usage: r.usage }, Date.now() - t0);
    return { step: "midia", patch: { copy: reviewed } };
  }

  if (step === "midia") {
    const ready = async (items: MediaItem[], message: string, since: number): Promise<StepResult> => {
      const stored: MediaItem[] = [];
      for (const it of items) stored.push(await storeMedia(run.client_id, it));
      if (!stored.length) throw new Error("Nenhuma mídia foi recebida.");
      await emit(run, step, "ok", message, { itens: stored.map((i) => ({ kind: i.kind, url: i.url })) }, Date.now() - since);
      return { step: "aprovacao", status: "rodando", patch: { media: stored, media_manual: null, media_prev: null } };
    };
    // Midia enviada pelo time vale em qualquer modo: substitui o gerador quando ele demora ou falha.
    if (Array.isArray(run.data.media_manual) && run.data.media_manual.length) {
      return ready(run.data.media_manual as MediaItem[], `Mídia enviada pelo time (${run.data.media_manual.length}).`, t0);
    }
    let job = run.data.media_job;
    if (!job) {
      const gen = mediaGen(agent.media_provider, agent, profile, run.format as Formato);
      const req = mediaRequest(run.format as Formato, run.data.plan, run.data.script, profile, await signature(profile));
      const started = await gen.start(req, profile);
      job = { provider: gen.provider, config: agent.media_provider, mode: gen.mode, ref: started.ref, started_at: new Date().toISOString() };
      const reuse = gen.mode === "manual" && Array.isArray(run.data.media_prev) && run.data.media_prev.length;
      const message = gen.mode === "manual"
        ? (reuse ? "O cliente pediu ajuste. Confirme a mídia da versão anterior ou envie outra pelo painel."
          : run.format === "reel" && agent.media_provider === "template" ? "Reel precisa de vídeo: aguardando o time enviar pelo painel." : "Aguardando o time enviar a mídia deste post.")
        : gen.mode === "inline" ? "Montando a arte por template." : `Pedido enviado ao gerador de mídia (${gen.provider}).`;
      await emit(run, step, gen.mode === "manual" ? "aguardando" : "iniciou", message, { provider: gen.provider, modo: gen.mode, briefing: req.briefing, nota: started.note });
      if (gen.mode !== "inline") return { status: "aguardando_midia", waitMinutes: gen.mode === "manual" ? 60 : 1, patch: { media_request: req, media_job: job } };
      // Arte por template fica pronta em segundos: consulta na mesma etapa.
      const res = await gen.poll(job.ref, profile);
      if (res.state !== "ready") throw new MediaJobError(res.state === "failed" ? `A arte por template falhou: ${res.error}` : "A arte por template não ficou pronta.");
      const done = await ready(res.items, `${res.items.length === 1 ? "Arte pronta" : res.items.length + " artes prontas"} (template).`, t0);
      return { ...done, patch: { ...done.patch, media_request: req, media_job: job } };
    }
    // Midia manual: o envio pelo painel acorda a execucao; ate la, so uma conferencia por hora.
    if (job.mode === "manual") return { status: "aguardando_midia", waitMinutes: 60 };
    // O job e consultado no fornecedor que o iniciou, mesmo que a configuracao do agente tenha mudado depois.
    const gen = mediaGen(job.config ?? job.provider, agent, profile, run.format as Formato);
    if (Date.now() - new Date(job.started_at).getTime() > MEDIA_TIMEOUT_MS) throw new MediaJobError("O gerador de mídia não respondeu em 6 horas.");
    const res = await gen.poll(job.ref, profile);
    if (res.state === "failed") throw new MediaJobError(`O gerador de mídia falhou: ${res.error}`);
    if (res.state === "pending") {
      const moved = "ref" in res && res.ref && res.ref !== job.ref;
      if (moved) await emit(run, step, "info", res.note ?? "O gerador passou para a etapa seguinte.", { provider: gen.provider });
      return { status: "aguardando_midia", waitMinutes: 1, ...(moved ? { patch: { media_job: { ...job, ref: res.ref } } } : {}) };
    }
    return ready(res.items, `${res.items.length === 1 ? "Mídia pronta" : res.items.length + " mídias prontas"} (${gen.provider}).`, new Date(job.started_at).getTime());
  }

  if (step === "aprovacao") {
    // A versao anterior so e citada se ainda existir: o time pode ter excluido o criativo.
    let prev: string | null = run.data.prev_creative_id ?? null;
    if (prev) {
      const { data } = await db.from("creatives").select("id").eq("id", prev).eq("client_id", run.client_id).maybeSingle();
      if (!data) prev = null;
    }
    const item = creativeItem(run, profile, prev);
    // A etapa pode repetir depois de uma falha de gravacao: procura antes o criativo desta versao.
    let { data: existing } = await db.from("creatives").select("id, status").eq("client_id", run.client_id).eq("external_ref", item.external_ref as string).maybeSingle();
    if (!existing) {
      const made = await createCreatives(run.client_id, [item], "api");
      existing = (made.created[0] as Row | undefined) ?? (await db.from("creatives").select("id, status").eq("client_id", run.client_id).eq("external_ref", item.external_ref as string).maybeSingle()).data;
    }
    if (!existing?.id) throw new Error("Não foi possível colocar o criativo na fila do cliente.");
    const creativeId = existing.id as string;
    if (agent.approval_mode === "automatica") {
      if (existing.status !== "approved") {
        const res = must(await db.rpc("portal_decide_opts", { p_client_id: run.client_id, p_creative_id: creativeId, p_action: "approve", p_comment: null, p_via: "admin", p_options: null })) as Row;
        if (!res?.ok && res?.error !== "already_decided") throw new Error(`A aprovação automática não foi registrada (${res?.error ?? "erro"}).`);
      }
      await emit(run, step, "ok", "Aprovado automaticamente (modo de aprovação do agente).", { creative_id: creativeId });
      return { step: "publicar", status: "publicando", waitMinutes: 1, patch: { posts_seen: {} }, columns: { creative_id: creativeId } };
    }
    if (existing.status === "pending") await emit(run, step, "aguardando", "Na fila de aprovação do cliente, no portal.", { creative_id: creativeId, revisao: run.revision ?? 0 });
    return { status: "aguardando_aprovacao", waitMinutes: 1, columns: { creative_id: creativeId } };
  }
  return {};
}

// Avanca cada execucao pronta. Etapas rapidas seguem em sequencia no mesmo ciclo (ate 4 por execucao),
// sempre respeitando o teto de tempo: nenhuma etapa nova comeca depois de TICK_BUDGET_MS.
async function advanceRuns(sum: Summary, startedAt: number) {
  const runs = (must(await db.from("agent_runs").select("id, agent_id").in("status", OPEN).lte("next_step_at", new Date().toISOString()).order("next_step_at").limit(12)) ?? []) as Row[];
  for (const first of runs) {
    if (Date.now() - startedAt > TICK_BUDGET_MS) { sum.deferred = (sum.deferred as number) + 1; continue; }
    let agent: Row = null, client: Row = null;
    try {
      agent = must(await db.from("agents").select(`${AGENT_FIELDS}, clients ( ${CLIENT_FIELDS} )`).eq("id", first.agent_id).maybeSingle());
      client = agent ? (Array.isArray(agent.clients) ? agent.clients[0] : agent.clients) : null;
    } catch (e) {
      // Falha de leitura nao e "agente removido": tenta de novo no proximo ciclo.
      (sum.errors as string[]).push(`ler agente ${first.agent_id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (let hop = 0; hop < 4 && Date.now() - startedAt <= TICK_BUDGET_MS; hop++) {
      // Reserva a etapa antes de executar: conta a tentativa e adia a proxima vez. Se a funcao cair no meio,
      // a execucao volta sozinha depois da reserva em vez de travar a fila. Tambem pega o estado mais recente
      // (cancelada, retomada ou com midia enviada desde a leitura).
      let run: Row;
      try {
        const cur = must(await db.from("agent_runs").select("*").eq("id", first.id).maybeSingle()) as Row;
        if (!cur || !OPEN.includes(cur.status)) break;
        if (!agent || !client) { await emit(cur, cur.step, "info", "Execução encerrada: o agente ou o cliente foi removido."); await finish(cur, "cancelado", "Agente ou cliente removido."); break; }
        if ((cur.attempts ?? 0) >= MAX_ATTEMPTS) {
          await emit(cur, cur.step, "falhou", "A etapa não terminou depois de várias tentativas (a execução foi interrompida no meio).", { tentativas: cur.attempts });
          await finish(cur, "falhou", "A etapa não terminou depois de várias tentativas.", "etapa_interrompida");
          break;
        }
        const leased = await writeRun(cur, { attempts: (cur.attempts ?? 0) + 1, next_step_at: new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString() }, [cur.status]);
        if (!leased) break;
        run = leased;
      } catch (e) {
        (sum.errors as string[]).push(`reservar ${first.id}: ${e instanceof Error ? e.message : e}`);
        break;
      }
      try {
        const r = await runStep(run, agent, client);
        const moved = Boolean(r.step && r.step !== run.step);
        const status = r.status ?? "rodando";
        const saved = await writeRun(run, {
          step: r.step ?? run.step, status, attempts: 0, error: null, error_code: null,
          next_step_at: waitAt(r.waitMinutes ?? 0), ...(r.columns ?? {}),
          ...(r.patch ? { data: { ...run.data, ...r.patch } } : {}),
        }, [run.status]);
        sum.steps = (sum.steps as number) + 1;
        // Cancelada durante a etapa: o criativo que acabou de entrar na fila sai junto.
        if (!saved) {
          if (r.columns?.creative_id) await db.from("creatives").delete().eq("id", r.columns.creative_id).eq("client_id", run.client_id).eq("status", "pending");
          break;
        }
        // So continua no mesmo ciclo quando a etapa terminou e a proxima nao precisa esperar ninguem.
        if (!moved || (r.waitMinutes ?? 0) > 0 || status !== "rodando") break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const config = e instanceof GenConfigError;
        const attempts = run.attempts ?? 1;
        const final = config || attempts >= MAX_ATTEMPTS;
        (sum.errors as string[]).push(`${run.step} ${run.id}: ${message}`);
        // Job de midia que morreu sai da execucao: a proxima tentativa (ou o Retomar do painel) comeca um novo.
        const data = e instanceof MediaJobError ? { ...run.data, media_job: null } : run.data;
        try {
          await emit(run, run.step, "falhou", message, { tentativa: attempts, definitivo: final, codigo: config ? (e as GenConfigError).code : null });
          if (final) await finish(run, "falhou", message.slice(0, 500), config ? (e as GenConfigError).code : "etapa_falhou", { attempts, data });
          else await writeRun(run, { error: message.slice(0, 500), data, next_step_at: waitAt(RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)]) }, [run.status]);
        } catch (e2) {
          (sum.errors as string[]).push(`registrar falha ${run.id}: ${e2 instanceof Error ? e2.message : e2}`);
        }
        break;
      }
    }
  }
}

// ---------- Aprovacao e publicacao: o motor observa o que o cliente, o time e o publicador fizeram ----------
const NET: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok" };
const chunk = <T>(list: T[], size = 100) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// O cliente pediu ajuste: a versao antiga sai de cena e a execucao volta para o roteiro com o pedido.
async function handleAdjust(run: Row, c: Row) {
  const feedback = c.decision_comment ?? "";
  if ((run.revision ?? 0) + 1 > MAX_REVISIONS) {
    await emit(run, "aprovacao", "falhou", `O cliente pediu ajuste pela ${(run.revision ?? 0) + 1}ª vez. O agente parou para o time assumir.`, { pedido: feedback });
    await finish(run, "falhou", "Limite de versões atingido.", "limite_revisoes", { step: "aprovacao" });
    return;
  }
  // Marca a versao antiga como substituida ja: o cliente nao consegue mais desfazer e aprovar a versao velha
  // enquanto a nova esta sendo produzida.
  await db.from("creatives").update({ status: "replaced" }).eq("id", c.id).eq("client_id", run.client_id).eq("status", "adjust");
  await emit(run, "aprovacao", "info", `O cliente pediu ajuste: ${feedback}`, { pedido: feedback, revisao: (run.revision ?? 0) + 1 });
  const { media_job, media, media_manual: _mm, copy: _c, script: _s, posts_seen: _p, resultado: _r, ...keep } = run.data ?? {};
  // No modo manual a midia anterior fica como sugestao: o time confirma ou envia outra.
  const manual = media_job?.mode === "manual" && Array.isArray(media) && media.length;
  await writeRun(run, {
    step: "roteiro", status: "rodando", revision: (run.revision ?? 0) + 1, attempts: 0, error: null, error_code: null, finished_at: null,
    next_step_at: new Date().toISOString(), data: { ...keep, feedback, prev_creative_id: c.id, ...(manual ? { media_prev: media } : {}) },
  }, [run.status]);
}

async function observeRuns(sum: Summary) {
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const [waiting, failed, rejected] = await Promise.all([
    db.from("agent_runs").select("*").in("status", ["aguardando_aprovacao", "publicando"]).limit(400),
    // Post que falhou e o cliente mandou tentar de novo: a execucao volta a ser acompanhada.
    db.from("agent_runs").select("*").eq("status", "falhou").eq("step", "publicar").gte("finished_at", recent).limit(100),
    // Reprovacao desfeita: o criativo pode voltar para a fila ou ser aprovado depois.
    db.from("agent_runs").select("*").eq("status", "concluido").eq("data->>resultado", "reprovado").gte("finished_at", recent).limit(100),
  ]);
  const runs = [...(must(waiting) ?? []), ...(must(failed) ?? []), ...(must(rejected) ?? [])] as Row[];
  if (!runs.length) return;
  const ids = [...new Set(runs.map((r) => r.creative_id).filter(Boolean))] as string[];
  // Qualquer falha de leitura interrompe a observacao deste ciclo sem escrever nada: erro de consulta
  // nunca pode ser lido como "criativo removido".
  const creatives: Row[] = [], kids: Row[] = [], posts: Row[] = [];
  for (const part of chunk(ids)) {
    creatives.push(...(must(await db.from("creatives").select("id, status, decision_comment, decided_at").in("id", part)) ?? []));
    kids.push(...(must(await db.from("creatives").select("id, story_of").in("story_of", part)) ?? []));
  }
  const kidOf = new Map<string, string>(kids.map((k) => [k.id, k.story_of]));
  for (const part of chunk([...ids, ...kidOf.keys()])) {
    posts.push(...(must(await db.from("posts").select("id, creative_id, platform, status, scheduled_for, published_at, permalink, last_error, last_error_code").in("creative_id", part)) ?? []));
  }
  const byCreative = new Map<string, Row>(creatives.map((c) => [c.id, c]));
  for (const run of runs) {
    try {
      const c = run.creative_id ? byCreative.get(run.creative_id) : null;
      const closed = run.status === "falhou" || run.status === "concluido";
      if (!c) {
        // O criativo foi excluido pelo time (a chave estrangeira zera creative_id) ou nao existe mais.
        if (!closed) { await emit(run, run.step, "info", "O criativo desta execução foi removido pelo time."); await finish(run, "cancelado", "O criativo foi removido."); }
        continue;
      }
      // Reprovacao desfeita.
      if (run.status === "concluido") {
        if (c.status !== "pending" && c.status !== "approved") continue;
        await emit(run, "aprovacao", "info", "A reprovação foi desfeita. A execução voltou a ser acompanhada.");
        const { resultado: _r, ...data } = run.data ?? {};
        const back = await writeRun(run, { status: "aguardando_aprovacao", step: "aprovacao", finished_at: null, data }, ["concluido"]);
        if (!back) continue;
        run.status = "aguardando_aprovacao"; run.step = "aprovacao"; run.data = data;
      }
      // Aprovacao desfeita depois de aprovada (pelo cliente no portal ou pelo time no painel).
      if ((run.status === "publicando" || run.status === "falhou") && c.status === "pending") {
        await emit(run, "aprovacao", "aguardando", "A aprovação foi desfeita. O criativo voltou para a fila do cliente.");
        await writeRun(run, { status: "aguardando_aprovacao", step: "aprovacao", finished_at: null, error: null, error_code: null, data: { ...run.data, posts_seen: {} } }, [run.status]);
        continue;
      }
      if (c.status === "adjust") { await handleAdjust(run, c); continue; }
      if (c.status === "rejected") {
        if (run.status === "falhou") continue;
        await emit(run, "aprovacao", "ok", `Reprovado ${await decidedBy(c.id)}. O agente não publica este post.`, { decisao: "reprovado" });
        await finish(run, "concluido", null, null, { step: "aprovacao", data: { ...run.data, resultado: "reprovado" } });
        continue;
      }
      if (c.status === "replaced") {
        if (!closed) { await emit(run, "aprovacao", "info", "O criativo foi substituído por outra versão enviada pelo time."); await finish(run, "concluido", null, null, { data: { ...run.data, resultado: "substituido" } }); }
        continue;
      }
      if (run.status === "aguardando_aprovacao") {
        if (c.status !== "approved") continue;
        await emit(run, "aprovacao", "ok", `Aprovado ${await decidedBy(c.id)}.`, { decided_at: c.decided_at });
        const next = await writeRun(run, { step: "publicar", status: "publicando", data: { ...run.data, posts_seen: {} } }, ["aguardando_aprovacao"]);
        if (!next) continue;
        run.status = "publicando"; run.step = "publicar"; run.data = next.data;
      }
      // publicando (ou falhou na publicacao): compara o estado de cada post com o ultimo visto.
      const mine = posts.filter((p) => p.creative_id === run.creative_id || kidOf.get(p.creative_id) === run.creative_id);
      if (!mine.length) continue;
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
      const open = mine.some((p) => p.status === "scheduled" || p.status === "processing");
      const anyFailed = mine.some((p) => p.status === "failed");
      const status = open ? "publicando" : anyFailed ? "falhou" : "concluido";
      if (changed || status !== run.status) {
        must(await db.from("agent_runs").update({
          data: { ...run.data, posts_seen: seen }, status, step: "publicar", updated_at: new Date().toISOString(),
          finished_at: open ? null : new Date().toISOString(),
          error: status === "falhou" ? "Uma ou mais redes recusaram o post." : null, error_code: status === "falhou" ? "publicacao_falhou" : null,
        }).eq("id", run.id).eq("status", run.status));
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
  // Cada fase tem o proprio tratamento: uma falha ao agendar nao impede de observar nem de avancar.
  const phase = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      (sum.errors as string[]).push(`${name}: ${message}`);
      console.error(JSON.stringify({ event: "agents_phase_failed", phase: name, error: message }));
    }
  };
  try {
    await phase("agendar", () => scheduleRuns(sum));
    await phase("observar", () => observeRuns(sum));
    await phase("avancar", () => advanceRuns(sum, t0));
    await db.from("settings").upsert({ key: "agents_last_run", value: JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, version: ENGINE_VERSION, ...sum }) });
  } finally {
    await db.from("settings").delete().eq("key", LOCK_KEY);
  }
  return sum;
}

// Usado pela central quando horarios ou frequencia mudam: as execucoes da agenda que ainda nao chegaram
// a fila do cliente sao canceladas, e o agendador recria para os horarios novos.
export async function cancelPlanned(agentId: string, clientId: string): Promise<number> {
  const rows = must(await db.from("agent_runs").update({ status: "cancelado", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: "Horários do agente alterados.", error_code: "horarios_alterados" })
    .eq("agent_id", agentId).eq("trigger", "agenda").in("status", OPEN).gt("slot_at", new Date().toISOString()).select("id")) as Row[];
  if (rows?.length) await emit({ id: null, client_id: clientId }, "config", "info", `Horários alterados: ${rows.length} execução(ões) da agenda canceladas para o agendador recriar nos horários novos.`);
  return rows?.length ?? 0;
}

// Fuso valido: um fuso invalido faria as contas de horario falharem para o agente.
export const validTimezone = (tz: string) => { try { tzOffsetMs(tz, new Date()); return true; } catch (_) { return false; } };
