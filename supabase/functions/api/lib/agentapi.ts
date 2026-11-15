// Central de agentes: rotas do painel do time (x-admin-key) para listar, criar, configurar e acompanhar os agentes.
import { db, getSetting, HttpError, igConfigured, isUuid, json, must, portalUrl, publicUrl, readJson, str } from "./core.ts";
import { agentPatch, createClientWithAgent, newPortalLink } from "./admin.ts";
import { AGENT_FIELDS, createRun, emit, ENGINE_VERSION, nextSlots, STEPS } from "./agents.ts";
import { generatorStatus } from "./generators.ts";
import { FORMATOS, Formato } from "./gentypes.ts";
import { uploadPostConfigured } from "./uploadpost.ts";

// deno-lint-ignore no-explicit-any
type Row = any;
const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as Row[];
const RUN_FIELDS = "id, client_id, agent_id, trigger, status, step, slot_at, format, revision, attempts, error, error_code, simulated, creative_id, next_step_at, started_at, updated_at, finished_at, tema:data->plan->>tema, titulo:data->copy->>titulo, midia_modo:data->media_job->>mode";
const ACTIVE = ["rodando", "aguardando_midia", "aguardando_aprovacao", "publicando"];

async function engineInfo() {
  const [agentsRun, workerRun] = await Promise.all([getSetting("agents_last_run"), getSetting("worker_last_run")]);
  return {
    version: ENGINE_VERSION, steps: STEPS, generators: generatorStatus(),
    instagram_configured: igConfigured(), tiktok_configured: uploadPostConfigured(),
    agents_last_run: agentsRun ? JSON.parse(agentsRun) : null, worker_last_run: workerRun ? JSON.parse(workerRun) : null,
    portal_url: await portalUrl(),
  };
}

// Simulacao so vale em cliente de demonstracao: nunca gera conteudo de mentira para uma conta real.
function guardProviders(patch: Record<string, unknown>, isDemo: boolean) {
  if (!isDemo && (patch.text_provider === "simulado" || patch.media_provider === "simulado")) {
    throw new HttpError(409, "not_demo", "Fornecedor simulado só pode ser usado em cliente de demonstração.");
  }
}

// ---------- Central: todos os agentes, com status, ultima execucao, proximos posts e erros ----------
async function central() {
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [clients, runs, upcoming, failedPosts, pending, engine] = await Promise.all([
    db.from("clients").select(`id, name, slug, segment, status, timezone, is_demo, created_at,
      agents ( ${AGENT_FIELDS} ),
      social_accounts ( platform, username, status, simulated, cooldown_until, last_error )`).order("created_at"),
    db.from("agent_runs").select(RUN_FIELDS).order("started_at", { ascending: false }).limit(400),
    db.from("posts").select("id, client_id, platform, status, scheduled_for, creatives!posts_creative_id_fkey ( title, format, story_of )")
      .in("status", ["scheduled", "processing"]).eq("is_example", false).order("scheduled_for").limit(400),
    db.from("posts").select("id, client_id, platform, last_error, last_error_code, scheduled_for, creatives!posts_creative_id_fkey ( title )")
      .eq("status", "failed").eq("is_example", false).gte("scheduled_for", week).limit(200),
    db.from("creatives").select("client_id").eq("status", "pending").is("story_of", null).limit(5000),
    engineInfo(),
  ]);
  const now = new Date();
  const pend: Record<string, number> = {};
  for (const c of must(pending) ?? []) pend[c.client_id] = (pend[c.client_id] ?? 0) + 1;
  const allRuns = (must(runs) ?? []) as Row[];
  const agents = (must(clients) ?? []).filter((c: Row) => list(c.agents).length).map((c: Row) => {
    const agent = list(c.agents)[0];
    const accounts = list(c.social_accounts);
    const mine = allRuns.filter((r) => r.client_id === c.id);
    const active = mine.filter((r) => ACTIVE.includes(r.status));
    const posts = (must(upcoming) ?? []).filter((p: Row) => p.client_id === c.id).slice(0, 4).map((p: Row) => {
      const cr = list(p.creatives)[0];
      return { id: p.id, platform: p.platform, status: p.status, scheduled_for: p.scheduled_for, title: cr?.title ?? null, story: Boolean(cr?.story_of) || cr?.format === "story" };
    });
    const errors = [
      ...mine.filter((r) => r.status === "falhou" && (r.finished_at ?? r.updated_at) >= week).map((r) => ({ kind: "execucao", at: r.finished_at ?? r.updated_at, step: r.step, message: r.error, code: r.error_code, run_id: r.id })),
      ...(must(failedPosts) ?? []).filter((p: Row) => p.client_id === c.id).map((p: Row) => ({ kind: "publicacao", at: p.scheduled_for, step: "publicar", message: p.last_error, code: p.last_error_code, post_id: p.id, title: list(p.creatives)[0]?.title ?? null })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
    // O que falta para o agente andar sozinho.
    const needs: string[] = [];
    for (const net of (agent.platforms ?? ["instagram"]) as string[]) {
      const acc = accounts.find((a) => a.platform === net);
      if (!acc) needs.push(`Conectar ${net === "tiktok" ? "TikTok" : "Instagram"}`);
      else if (acc.status !== "connected") needs.push(`Reconectar ${net === "tiktok" ? "TikTok" : "Instagram"}`);
    }
    const waitingMedia = active.filter((r) => r.status === "aguardando_midia" && r.midia_modo === "manual").length;
    if (waitingMedia) needs.push(waitingMedia === 1 ? "Enviar a mídia de 1 post" : `Enviar a mídia de ${waitingMedia} posts`);
    if (pend[c.id]) needs.push(pend[c.id] === 1 ? "Cliente aprovar 1 criativo" : `Cliente aprovar ${pend[c.id]} criativos`);
    if (!(agent.context ?? "").trim()) needs.push("Preencher o contexto da conta");
    return {
      client: { id: c.id, name: c.name, slug: c.slug, segment: c.segment, status: c.status, timezone: c.timezone, is_demo: c.is_demo },
      agent, accounts, queue_pending: pend[c.id] ?? 0,
      next_slots: agent.automation === "ligada" ? nextSlots(agent, c.timezone || "America/Sao_Paulo", now, 4) : [],
      upcoming_posts: posts, active_runs: active, last_run: mine[0] ?? null, errors, needs,
    };
  });
  return json({ now: now.toISOString(), engine, agents });
}

async function loadAgent(clientId: string) {
  const { data: c } = await db.from("clients").select(`id, name, slug, segment, status, timezone, is_demo, agents ( ${AGENT_FIELDS} )`).eq("id", clientId).maybeSingle();
  const agent = c ? list(c.agents)[0] : null;
  if (!c || !agent) throw new HttpError(404, "not_found", "Agente não encontrado.");
  return { client: c as Row, agent: agent as Row };
}

async function detail(clientId: string) {
  const { client, agent } = await loadAgent(clientId);
  const [runs, accounts, engine] = await Promise.all([
    db.from("agent_runs").select("*").eq("client_id", clientId).order("started_at", { ascending: false }).limit(30),
    db.from("social_accounts").select("platform, username, status, simulated, cooldown_until, last_error").eq("client_id", clientId),
    engineInfo(),
  ]);
  return json({
    client: { ...client, agents: undefined }, agent, accounts: must(accounts) ?? [], engine,
    next_slots: nextSlots(agent, client.timezone || "America/Sao_Paulo", new Date(), 6),
    runs: (must(runs) ?? []).map(runView),
  });
}

// Execucao como o painel mostra: sem os campos internos do job, com o briefing da midia quando o time precisa enviar.
function runView(r: Row) {
  const d = r.data ?? {};
  return {
    id: r.id, client_id: r.client_id, trigger: r.trigger, status: r.status, step: r.step, slot_at: r.slot_at, format: r.format, revision: r.revision,
    attempts: r.attempts, error: r.error, error_code: r.error_code, simulated: r.simulated, creative_id: r.creative_id,
    started_at: r.started_at, updated_at: r.updated_at, finished_at: r.finished_at, next_step_at: r.next_step_at,
    plan: d.plan ?? null, script: d.script ?? null, copy: d.copy ?? null, media: d.media ?? null, feedback: d.feedback ?? null, resultado: d.resultado ?? null,
    media_job: d.media_job ? { provider: d.media_job.provider, mode: d.media_job.mode, started_at: d.media_job.started_at } : null,
    briefing: d.media_request?.briefing ?? null,
  };
}

async function patchAgent(clientId: string, req: Request) {
  const { client, agent } = await loadAgent(clientId);
  const b = await readJson(req);
  const patch = agentPatch(b);
  guardProviders(patch, client.is_demo);
  if (!Object.keys(patch).length) throw new HttpError(400, "empty", "Nada para atualizar.");
  must(await db.from("agents").update({ ...patch, config_version: (agent.config_version ?? 1) + 1, updated_at: new Date().toISOString() }).eq("id", agent.id));
  await emit({ id: null, client_id: clientId }, "config", "info", `Configuração atualizada pelo time: ${Object.keys(patch).join(", ")}.`, { campos: Object.keys(patch), versao: (agent.config_version ?? 1) + 1 });
  return json({ ok: true, config_version: (agent.config_version ?? 1) + 1 });
}

// Atualiza varios agentes de uma vez (ou todos). Campos de identidade da conta ficam de fora: sao de cada agente.
const BULK_FIELDS = ["post_times", "posts_per_week", "platforms", "formats", "approval_mode", "automation", "text_provider", "media_provider", "lead_hours", "story_default", "ai_label", "tone"];
async function bulkPatch(req: Request) {
  const b = await readJson(req);
  const raw = (b.patch && typeof b.patch === "object" ? b.patch : {}) as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => !BULK_FIELDS.includes(k));
  if (extra.length) throw new HttpError(400, "bad_fields", `Estes campos não podem ser alterados em lote: ${extra.join(", ")}.`);
  const patch = agentPatch(raw);
  if (!Object.keys(patch).length) throw new HttpError(400, "empty", "Nada para atualizar.");
  let q = db.from("clients").select("id, name, is_demo, agents ( id, config_version )");
  if (b.client_ids !== "all") {
    const ids = Array.isArray(b.client_ids) ? b.client_ids.filter(isUuid) : [];
    if (!ids.length) throw new HttpError(400, "no_targets", "Escolha os agentes ou envie client_ids = \"all\".");
    q = q.in("id", ids);
  }
  const updated: string[] = [], skipped: { name: string; reason: string }[] = [];
  for (const c of must(await q) ?? []) {
    const agent = list(c.agents)[0];
    if (!agent) continue;
    try { guardProviders(patch, c.is_demo); } catch (e) { skipped.push({ name: c.name, reason: (e as Error).message }); continue; }
    must(await db.from("agents").update({ ...patch, config_version: (agent.config_version ?? 1) + 1, updated_at: new Date().toISOString() }).eq("id", agent.id));
    await emit({ id: null, client_id: c.id }, "config", "info", `Configuração atualizada em lote: ${Object.keys(patch).join(", ")}.`, { campos: Object.keys(patch) });
    updated.push(c.name);
  }
  return json({ ok: true, updated, skipped });
}

// Assistente "Novo agente": cria o cliente, o agente, o link do portal e ja deixa a automacao ligada.
async function createAgent(req: Request) {
  const b = await readJson(req);
  const cfg = (b.agent && typeof b.agent === "object" ? b.agent : {}) as Record<string, unknown>;
  const demo = b.is_demo === true;
  guardProviders(agentPatch(cfg), demo);
  if (str(cfg.context, 4000).length < 20) throw new HttpError(400, "context_required", "Descreva o contexto da conta (o que a marca faz e para quem) com pelo menos uma frase.");
  const client = await createClientWithAgent({ name: b.name, segment: b.segment, timezone: b.timezone, is_demo: demo, agent: { status: "ativo", automation: "ligada", ...cfg } });
  const url = await newPortalLink(client.id, str(b.link_label, 80) || "Link criado no assistente");
  await emit({ id: null, client_id: client.id }, "config", "info", "Agente criado pelo assistente do painel.", { automation: str(cfg.automation, 12) || "ligada" });
  // O mesmo link abre o portal direto na tela de conexao das contas.
  const connect = url.replace("#", "?aba=agente#");
  return json({ client, portal_url: url, connect_url: connect }, 201);
}

async function runNow(clientId: string, req: Request) {
  const { client, agent } = await loadAgent(clientId);
  const b = await readJson(req).catch(() => ({} as Record<string, unknown>));
  const formato = (FORMATOS as string[]).includes(str(b.formato, 12)) ? str(b.formato, 12) as Formato : undefined;
  const run = await createRun(agent, client, "manual", null, formato);
  return json({ ok: true, run_id: run.id }, 201);
}

async function loadRun(id: string) {
  const { data: run } = await db.from("agent_runs").select("*").eq("id", id).maybeSingle();
  if (!run) throw new HttpError(404, "not_found", "Execução não encontrada.");
  return run as Row;
}

async function runDetail(id: string) {
  const run = await loadRun(id);
  const events = must(await db.from("agent_events").select("id, step, status, message, detail, duration_ms, created_at").eq("run_id", id).order("id").limit(300));
  return json({ run: runView(run), events: events ?? [] });
}

async function cancelRun(id: string) {
  const run = await loadRun(id);
  if (!ACTIVE.includes(run.status)) throw new HttpError(409, "not_active", "Esta execução já terminou.");
  if (run.status === "publicando") throw new HttpError(409, "publishing", "O post já foi aprovado. Para tirar da fila, devolva o criativo na página do cliente.");
  must(await db.from("agent_runs").update({ status: "cancelado", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id));
  await emit(run, run.step, "info", "Execução cancelada pelo time.");
  return json({ ok: true });
}

async function retryRun(id: string) {
  const run = await loadRun(id);
  if (run.status !== "falhou" || run.step === "publicar") throw new HttpError(409, "not_retryable", run.step === "publicar" ? "A falha foi na publicação: use Tentar de novo no post." : "Só execuções com falha podem ser retomadas.");
  must(await db.from("agent_runs").update({ status: "rodando", attempts: 0, error: null, error_code: null, finished_at: null, next_step_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id));
  await emit(run, run.step, "info", "Execução retomada pelo time a partir da etapa que falhou.");
  return json({ ok: true });
}

// Midia enviada pelo time para uma execucao que espera midia manual.
async function runMedia(id: string, req: Request) {
  const run = await loadRun(id);
  if (run.step !== "midia" || !["aguardando_midia", "rodando"].includes(run.status)) throw new HttpError(409, "not_waiting", "Esta execução não está esperando mídia.");
  const b = await readJson(req);
  const raw = Array.isArray(b.items) ? b.items as Record<string, unknown>[] : [];
  if (!raw.length || raw.length > 10) throw new HttpError(400, "bad_items", "Envie de 1 a 10 mídias.");
  const items = raw.map((it, i) => {
    const path = str(it.media_path, 500);
    if (!path.startsWith(`${run.client_id}/`)) throw new HttpError(400, "bad_path", `Mídia ${i + 1}: o arquivo não pertence a este cliente.`);
    const kind = str(it.kind, 10) === "video" || /\.(mp4|mov)$/i.test(path) ? "video" : "image";
    const thumb = str(it.thumb_path, 500);
    return { kind, url: publicUrl(path), thumb: thumb && thumb.startsWith(`${run.client_id}/`) ? publicUrl(thumb) : null };
  });
  if (run.format === "reel" && items[0].kind !== "video") throw new HttpError(400, "need_video", "Este post é um Reel: envie um vídeo.");
  if (run.format !== "carrossel" && items.length > 1) throw new HttpError(400, "single_only", "Este formato leva uma mídia só.");
  must(await db.from("agent_runs").update({ data: { ...run.data, media_manual: items }, status: "aguardando_midia", next_step_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id));
  await emit(run, "midia", "info", `Mídia enviada pelo time (${items.length}).`, { itens: items.length });
  return json({ ok: true });
}

// Visao ao vivo: eventos reais depois do cursor e as execucoes em andamento. O painel consulta a cada poucos segundos.
async function live(url: URL) {
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const clientId = url.searchParams.get("client_id");
  let ev = db.from("agent_events").select("id, run_id, client_id, step, status, message, duration_ms, created_at");
  if (isUuid(clientId)) ev = ev.eq("client_id", clientId);
  const events = after
    ? must(await ev.gt("id", after).order("id").limit(300)) ?? []
    : (must(await ev.order("id", { ascending: false }).limit(120)) ?? []).reverse();
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  let rq = db.from("agent_runs").select(RUN_FIELDS).or(`status.in.(${ACTIVE.join(",")}),updated_at.gte."${since}"`).order("started_at", { ascending: false }).limit(200);
  if (isUuid(clientId)) rq = rq.eq("client_id", clientId);
  const runs = must(await rq) ?? [];
  const last = events.length ? (events[events.length - 1] as Row).id : after;
  const agentsRun = await getSetting("agents_last_run");
  return json({ now: new Date().toISOString(), cursor: last, events, runs, steps: STEPS, agents_last_run: agentsRun ? JSON.parse(agentsRun) : null });
}

// seg ja vem sem o prefixo /admin. Devolve null quando a rota nao e daqui.
export async function agentRoutes(req: Request, seg: string[]): Promise<Response | null> {
  const m = req.method, url = new URL(req.url);
  if (seg[0] === "agents") {
    if (m === "GET" && seg.length === 1) return central();
    if (m === "POST" && seg.length === 1) return createAgent(req);
    if (m === "GET" && seg[1] === "live") return live(url);
    if (m === "POST" && seg[1] === "bulk") return bulkPatch(req);
    if (isUuid(seg[1])) {
      if (m === "GET" && seg.length === 2) return detail(seg[1]);
      if (m === "PATCH" && seg.length === 2) return patchAgent(seg[1], req);
      if (m === "POST" && seg[2] === "run") return runNow(seg[1], req);
    }
  }
  if (seg[0] === "runs" && isUuid(seg[1])) {
    if (m === "GET" && seg.length === 2) return runDetail(seg[1]);
    if (m === "POST" && seg[2] === "cancel") return cancelRun(seg[1]);
    if (m === "POST" && seg[2] === "retry") return retryRun(seg[1]);
    if (m === "POST" && seg[2] === "media") return runMedia(seg[1], req);
  }
  return null;
}
