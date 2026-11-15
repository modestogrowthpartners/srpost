// Rotas do portal do cliente (autenticadas pelo link magico). Tudo e filtrado pelo cliente dono do link.
import { authPortal, ClientRow, db, FUNCTIONS_BASE, getSetting, HttpError, igConfigured, isUuid, json, must, one, randomToken, readJson, str } from "./core.ts";
import { authorizeUrl } from "./instagram.ts";
import { uploadPostConfigured } from "./uploadpost.ts";
import { tiktokDisconnect, tiktokStart } from "./connect.ts";
import { creativeOptions, normalizeOptions, optionColumns } from "./options.ts";

const CREATIVE_FIELDS = "id, kind, format, media_url, thumb_url, media, title, caption, hashtags, link_url, platforms, location_id, location_name, audio_name, auto_music, opt_story, opt_caption, opt_location, suggested_at, created_at, revision_of";
const POST_FIELDS = `id, platform, status, scheduled_for, published_at, permalink, last_error, is_example,
        post_metrics ( views, reach, likes, comments, saved, shares, total_interactions, avg_watch_time_ms, fetched_at )`;

// Criativo como o portal recebe: com o estado de cada opcao (ligada, permitida, motivo).
// deno-lint-ignore no-explicit-any
function withOptions(c: any) {
  const { location_id, ...rest } = c;
  return { ...rest, has_location: Boolean(location_id), options: creativeOptions(c) };
}

export async function pacing() {
  const [gap, cap] = await Promise.all([getSetting("publish_min_gap_minutes"), getSetting("publish_daily_cap")]);
  return { min_gap_minutes: Math.max(0, Number(gap ?? 15) || 0), daily_cap: Math.max(1, Number(cap ?? 12) || 12) };
}

// Estado das contas do cliente por plataforma. "available" = a conexao ja esta liberada no Sr. Post.
async function accountsState(clientId: string) {
  const { data } = await db.from("social_accounts")
    .select("platform, username, name, profile_picture_url, account_type, followers_count, status, token_expires_at, connected_at, last_error, page_name, simulated, cooldown_until")
    .eq("client_id", clientId);
  const by = (p: string) => (data ?? []).find((a: any) => a.platform === p) ?? null;
  const state = (p: string, available: boolean) => {
    const acc = by(p);
    return { available: available || acc?.simulated === true, connected: acc?.status === "connected", account: acc };
  };
  return { instagram: state("instagram", igConfigured()), tiktok: state("tiktok", uploadPostConfigured()) };
}

async function bootstrap(client: ClientRow) {
  const [agentRes, queueRes, statusRes, postsRes, accounts, pace] = await Promise.all([
    db.from("agents").select("name, role_line, bio, tone, pillars, posts_per_week, post_times, platforms, status").eq("client_id", client.id).maybeSingle(),
    db.from("creatives").select(CREATIVE_FIELDS).eq("client_id", client.id).eq("status", "pending").is("story_of", null).order("suggested_at", { ascending: true, nullsFirst: false }).order("created_at").limit(100),
    db.from("creatives").select("status").eq("client_id", client.id).is("story_of", null).limit(5000),
    db.from("posts").select("status, platform").eq("client_id", client.id).limit(5000),
    accountsState(client.id),
    pacing(),
  ]);
  const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, adjust: 0, scheduled: 0, published: 0, failed: 0 };
  for (const r of must(statusRes) ?? []) if (r.status in counts) counts[r.status]++;
  for (const r of must(postsRes) ?? []) {
    if (r.status === "scheduled" || r.status === "processing") counts.scheduled++;
    else if (r.status === "published") counts.published++;
    else if (r.status === "failed") counts.failed++;
  }
  // Posts aprovados que estao parados porque a conta da rede nao esta conectada (ou a conexao expirou).
  const waiting: Record<string, number> = {};
  for (const r of must(postsRes) ?? []) if (r.status === "scheduled") waiting[r.platform] = (waiting[r.platform] ?? 0) + 1;
  for (const p of ["instagram", "tiktok"] as const) {
    (accounts[p] as Record<string, unknown>).waiting = accounts[p].connected ? 0 : (waiting[p] ?? 0);
  }
  return json({
    client: { name: client.name, segment: client.segment, timezone: client.timezone, is_demo: client.is_demo },
    agent: must(agentRes),
    accounts,
    instagram: accounts.instagram, // compatibilidade com a versao anterior do portal
    queue: (must(queueRes) ?? []).map(withOptions),
    counts,
    pacing: pace,
  });
}

async function library(client: ClientRow) {
  const [mainRes, storyRes] = await Promise.all([
    db.from("creatives")
      .select(`id, kind, format, media_url, thumb_url, media, title, caption, hashtags, link_url, platforms, location_name, opt_caption, opt_location, status, decision_comment, decided_at, suggested_at,
      posts!posts_creative_id_fkey ( ${POST_FIELDS} )`)
      .eq("client_id", client.id).is("story_of", null).in("status", ["approved", "rejected", "adjust"])
      .order("decided_at", { ascending: false }).limit(300),
    // Stories gerados pela opcao "subir tambem no story": entram como publicacao extra do criativo principal.
    db.from("creatives").select(`story_of, posts!posts_creative_id_fkey ( ${POST_FIELDS} )`)
      .eq("client_id", client.id).not("story_of", "is", null).limit(300),
  ]);
  const rows = must(mainRes) ?? [];
  const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as any[];
  const stories = new Map<string, any[]>();
  for (const s of must(storyRes) ?? []) stories.set(s.story_of, [...(stories.get(s.story_of) ?? []), ...list(s.posts)]);

  const totals = { published: 0, views: 0, reach: 0, interactions: 0, with_metrics: 0 };
  const items = rows.map((r: any) => {
    const own = list(r.posts).map((p) => ({ ...p, placement: r.format === "story" ? "story" : "main" }));
    const extra = (stories.get(r.id) ?? []).map((p) => ({ ...p, placement: "story" }));
    const posts = [...own, ...extra].map((p) => {
      const metrics = one<any>(p.post_metrics);
      if (p.status === "published") {
        totals.published++;
        if (metrics) {
          totals.with_metrics++;
          totals.views += metrics.views ?? 0;
          totals.reach += metrics.reach ?? 0;
          totals.interactions += metrics.total_interactions ?? 0;
        }
      }
      return { ...p, post_metrics: undefined, metrics };
    }).sort((a, b) => String(a.platform).localeCompare(String(b.platform)) || (a.placement === "story" ? 1 : 0) - (b.placement === "story" ? 1 : 0));
    const first = posts.find((p) => p.platform === "instagram") ?? posts[0] ?? null;
    const { posts: _p, ...creative } = r;
    // "post" e "metrics" ficam por compatibilidade com a versao anterior do portal.
    return { ...creative, posts, post: first ? { ...first, metrics: undefined } : null, metrics: first?.metrics ?? null };
  });
  return json({ items, totals });
}

const OPTION_FIELDS = "id, status, kind, format, platforms, caption, hashtags, link_url, location_id, location_name, auto_music, opt_story, opt_caption, opt_location";

async function pendingCreative(client: ClientRow, id: unknown) {
  if (!isUuid(id)) throw new HttpError(400, "bad_id", "Criativo inválido.");
  const { data } = await db.from("creatives").select(OPTION_FIELDS).eq("id", id).eq("client_id", client.id).is("story_of", null).maybeSingle();
  return data;
}

// Grava as opcoes escolhidas antes da aprovacao. O que a rede nao aceita continua desligado.
async function saveOptions(client: ClientRow, req: Request) {
  const body = await readJson(req);
  const c = await pendingCreative(client, body.creative_id);
  if (!c) throw new HttpError(404, "not_found", "Criativo não encontrado.");
  if (c.status !== "pending") throw new HttpError(409, "already_decided", "Este criativo já foi decidido.");
  const values = normalizeOptions(c, body.options);
  const rows = must(await db.from("creatives").update(optionColumns(values))
    .eq("id", c.id).eq("client_id", client.id).eq("status", "pending").select(OPTION_FIELDS)) as any[];
  if (!rows?.length) throw new HttpError(409, "already_decided", "Este criativo já foi decidido.");
  return json({ ok: true, options: creativeOptions(rows[0]) });
}

async function decide(client: ClientRow, req: Request) {
  const body = await readJson(req);
  if (!isUuid(body.creative_id)) throw new HttpError(400, "bad_id", "Criativo inválido.");
  const action = str(body.action, 10);
  if (!["approve", "reject", "adjust"].includes(action)) throw new HttpError(400, "bad_action", "Ação inválida.");
  let options: Record<string, boolean> | null = null;
  if (action === "approve" && body.options && typeof body.options === "object") {
    const c = await pendingCreative(client, body.creative_id);
    if (c) options = normalizeOptions(c, body.options);
  }
  const res = must(await db.rpc("portal_decide_opts", {
    p_client_id: client.id, p_creative_id: body.creative_id, p_action: action,
    p_comment: str(body.comment, 1000) || null, p_via: "portal", p_options: options,
  })) as any;
  if (!res?.ok) {
    const msg: Record<string, string> = {
      not_found: "Criativo não encontrado.",
      already_decided: "Este criativo já foi decidido.",
      comment_required: "Conte o que deve ser ajustado.",
    };
    throw new HttpError(409, res?.error ?? "conflict", msg[res?.error] ?? "Não foi possível registrar.");
  }
  return json(res);
}

async function undo(client: ClientRow, req: Request) {
  const body = await readJson(req);
  if (!isUuid(body.creative_id)) throw new HttpError(400, "bad_id", "Criativo inválido.");
  const res = must(await db.rpc("portal_undo", { p_client_id: client.id, p_creative_id: body.creative_id, p_via: "portal" })) as any;
  if (!res?.ok) {
    const msg: Record<string, string> = {
      already_publishing: "Este post já está sendo publicado e não pode mais voltar para a fila.",
      nothing_to_undo: "Não há decisão para desfazer.",
      not_found: "Criativo não encontrado.",
    };
    throw new HttpError(409, res?.error ?? "conflict", msg[res?.error] ?? "Não foi possível desfazer.");
  }
  const creative = must(await db.from("creatives").select(CREATIVE_FIELDS).eq("id", body.creative_id).eq("client_id", client.id).maybeSingle());
  return json({ ok: true, creative: creative ? withOptions(creative) : null });
}

// ---------- Andamento ----------
// Motivo em linguagem do cliente; a mensagem original da rede vai em "detail".
export function friendlyError(code: string | null, raw: string | null): { message: string; detail: string | null } | null {
  if (!code && !raw) return null;
  const c = code ?? "";
  const has = (...parts: string[]) => parts.some((p) => c === p || c.startsWith(p + "/") || c.endsWith("/" + p));
  if (has("190", "102") || ["reconectar", "sem_conta", "token_ausente"].includes(c) || c.startsWith("uploadpost/") && /reauth|reconnect|not connected/i.test(raw ?? "")) {
    return { message: "A conexão com a conta caiu. Reconecte para o post sair.", detail: raw };
  }
  if (has("2207051", "368")) return { message: "A rede segurou a publicação por suspeita de excesso de atividade. O Sr. Post pausou a conta por um tempo antes de tentar de novo.", detail: raw };
  if (has("2207042") || c === "9" || c === "limite_da_rede") return { message: "A conta atingiu o limite de publicações da rede nas últimas 24 horas.", detail: raw };
  if (has("2207050") || c === "25") return { message: "O Instagram restringiu esta conta. O dono precisa resolver no aplicativo do Instagram.", detail: raw };
  if (c === "network") return { message: "Falha de comunicação com a rede.", detail: raw };
  if (["timeout", "recusado", "simulado"].includes(c)) return { message: raw ?? "A rede não aceitou este post.", detail: null };
  return { message: "A rede não aceitou este post.", detail: raw };
}

const ceilMinute = (ms: number) => Math.ceil(ms / 60_000) * 60_000;

async function progress(client: ClientRow) {
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const [postsRes, accounts, pace] = await Promise.all([
    db.from("posts").select(`id, creative_id, platform, status, scheduled_for, published_at, permalink, attempts, last_error, last_error_code, created_at,
      creatives!posts_creative_id_fkey ( id, title, caption, kind, format, media_url, thumb_url, story_of )`)
      .eq("client_id", client.id).eq("is_example", false)
      .or(`status.in.(scheduled,processing,failed),published_at.gte."${since}"`)
      .order("scheduled_for").order("created_at").limit(300),
    accountsState(client.id),
    pacing(),
  ]);
  const rows = (must(postsRes) ?? []).map((p: any) => ({ ...p, creative: one<any>(p.creatives) })).filter((p: any) => p.creative);
  const now = Date.now();
  // Primeiro horario em que cada conta pode publicar: pausa pedida pela rede, intervalo minimo e teto diario.
  const base: Record<string, number> = {};
  for (const net of ["instagram", "tiktok"] as const) {
    if (!accounts[net].connected || !rows.some((p: any) => p.platform === net && p.status === "scheduled")) continue;
    const { data } = await db.rpc("account_next_allowed", { p_client_id: client.id, p_platform: net });
    base[net] = data ? new Date(data as string).getTime() : now;
  }
  const cursor: Record<string, number> = { ...base };
  const isStory = (p: any) => Boolean(p.creative.story_of) || p.creative.format === "story";
  const queued = rows.filter((p: any) => p.status === "scheduled")
    .sort((a: any, b: any) => a.platform.localeCompare(b.platform) || a.scheduled_for.localeCompare(b.scheduled_for)
      || Number(Boolean(a.creative.story_of)) - Number(Boolean(b.creative.story_of)) || a.created_at.localeCompare(b.created_at));
  const eta = new Map<string, { eta: string | null; wait: string | null }>();
  for (const p of queued) {
    const acc = accounts[p.platform as "instagram" | "tiktok"];
    if (!acc?.connected) { eta.set(p.id, { eta: null, wait: "conta" }); continue; }
    const due = new Date(p.scheduled_for).getTime();
    const free = cursor[p.platform] ?? now;
    const at = ceilMinute(Math.max(due, free, now));
    // O intervalo conta a partir da publicacao, que acontece ate um ciclo depois do envio: soma 1 minuto na previsao.
    cursor[p.platform] = at + (pace.min_gap_minutes + 1) * 60_000;
    const cool = acc.account?.cooldown_until ? new Date(acc.account.cooldown_until).getTime() : 0;
    // Motivo da espera: pausa pedida pela rede, teto de publicacoes em 24 horas ou intervalo minimo entre posts.
    const capHit = (base[p.platform] ?? now) - now > (pace.min_gap_minutes + 1) * 60_000 && cool <= now;
    const wait = at - Math.max(due, now) < 90_000 ? null : cool > now && at >= cool ? "pausa" : capHit ? "teto" : "intervalo";
    eta.set(p.id, { eta: new Date(at).toISOString(), wait });
  }
  const STATE: Record<string, string> = { scheduled: "na_fila", processing: "enviando", published: "publicado", failed: "falhou" };
  const items = rows.filter((p: any) => STATE[p.status]).map((p: any) => {
    const e = eta.get(p.id);
    return {
      id: p.id, creative_id: p.creative.story_of ?? p.creative.id,
      title: p.creative.title || (p.creative.caption || "").slice(0, 60) || "Sem título",
      kind: p.creative.kind, format: p.creative.format, thumb: p.creative.thumb_url || (p.creative.kind === "video" ? null : p.creative.media_url),
      media_url: p.creative.media_url,
      platform: p.platform, placement: isStory(p) ? "story" : "main",
      state: STATE[p.status], scheduled_for: p.scheduled_for, eta: e?.eta ?? null, wait: e?.wait ?? null,
      published_at: p.published_at, permalink: p.permalink, attempts: p.attempts,
      error: p.status === "published" ? null : friendlyError(p.last_error_code, p.last_error),
      can_retry: p.status === "failed",
    };
  });
  return json({ now: new Date(now).toISOString(), items, pacing: pace, accounts });
}

// Tentar de novo: o post com falha volta para a fila e sai no proximo horario permitido da conta.
async function retry(client: ClientRow, req: Request) {
  const body = await readJson(req);
  if (!isUuid(body.post_id)) throw new HttpError(400, "bad_id", "Post inválido.");
  const rows = must(await db.from("posts").update({
    status: "scheduled", attempts: 0, last_error: null, last_error_code: null, container_id: null, container_created_at: null,
    scheduled_for: new Date().toISOString(),
  }).eq("id", body.post_id).eq("client_id", client.id).eq("status", "failed").eq("is_example", false).select("id")) as unknown[];
  if (!rows?.length) throw new HttpError(409, "not_failed", "Só posts com falha podem ser reenviados.");
  return json({ ok: true });
}

async function instagramStart(client: ClientRow) {
  const appId = Deno.env.get("IG_APP_ID");
  const configId = Deno.env.get("IG_LOGIN_CONFIG_ID") ?? await getSetting("ig_login_config_id");
  if (!igConfigured() || !appId || !configId) {
    throw new HttpError(503, "ig_not_configured", "A conexão com o Instagram ainda está sendo liberada pelo Sr. Post.");
  }
  const state = randomToken(32);
  must(await db.from("oauth_states").insert({ state, client_id: client.id }));
  await db.from("oauth_states").delete().lt("expires_at", new Date().toISOString());
  return json({ authorize_url: authorizeUrl(appId, configId, `${FUNCTIONS_BASE}/instagram/callback`, state) });
}

async function instagramDisconnect(client: ClientRow) {
  const { data: acc } = await db.from("social_accounts").select("id").eq("client_id", client.id).eq("platform", "instagram").maybeSingle();
  if (acc) {
    await db.rpc("ig_token_delete", { p_account_id: acc.id });
    must(await db.from("social_accounts").delete().eq("id", acc.id).eq("client_id", client.id));
  }
  return json({ ok: true });
}

export async function portalRoutes(req: Request, path: string): Promise<Response> {
  const client = await authPortal(req);
  const m = req.method;
  if (m === "GET" && path === "/bootstrap") return bootstrap(client);
  if (m === "GET" && path === "/library") return library(client);
  if (m === "GET" && path === "/progress") return progress(client);
  if (m === "POST" && path === "/options") return saveOptions(client, req);
  if (m === "POST" && path === "/decide") return decide(client, req);
  if (m === "POST" && path === "/undo") return undo(client, req);
  if (m === "POST" && path === "/retry") return retry(client, req);
  if (m === "POST" && (path === "/instagram/start" || path === "/connect/instagram/start")) return instagramStart(client);
  if (m === "POST" && (path === "/instagram/disconnect" || path === "/connect/instagram/disconnect")) return instagramDisconnect(client);
  if (m === "POST" && path === "/connect/tiktok/start") return tiktokStart(client);
  if (m === "POST" && path === "/connect/tiktok/disconnect") return tiktokDisconnect(client);
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}
