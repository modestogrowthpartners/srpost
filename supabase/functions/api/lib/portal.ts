// Rotas do portal do cliente (autenticadas pelo link magico).
import { authPortal, ClientRow, db, FUNCTIONS_BASE, getSetting, HttpError, igConfigured, isUuid, json, must, one, randomToken, readJson, str } from "./core.ts";
import { authorizeUrl } from "./instagram.ts";
import { uploadPostConfigured } from "./uploadpost.ts";
import { tiktokDisconnect, tiktokStart } from "./connect.ts";

const CREATIVE_FIELDS = "id, kind, format, media_url, thumb_url, media, title, caption, hashtags, platforms, location_name, audio_name, auto_music, suggested_at, created_at, revision_of";

// Estado das contas do cliente por plataforma. "available" = a conexao ja esta liberada no Sr. Post.
async function accountsState(clientId: string) {
  const { data } = await db.from("social_accounts")
    .select("platform, username, name, profile_picture_url, account_type, followers_count, status, token_expires_at, connected_at, last_error, page_name")
    .eq("client_id", clientId);
  const by = (p: string) => (data ?? []).find((a: any) => a.platform === p) ?? null;
  const state = (p: string, available: boolean) => {
    const acc = by(p);
    return { available, connected: acc?.status === "connected", account: acc };
  };
  return { instagram: state("instagram", igConfigured()), tiktok: state("tiktok", uploadPostConfigured()) };
}

async function bootstrap(client: ClientRow) {
  const [agentRes, queueRes, statusRes, postsRes, accounts] = await Promise.all([
    db.from("agents").select("name, role_line, bio, tone, pillars, posts_per_week, post_times, platforms, status").eq("client_id", client.id).maybeSingle(),
    db.from("creatives").select(CREATIVE_FIELDS).eq("client_id", client.id).eq("status", "pending").order("suggested_at", { ascending: true, nullsFirst: false }).order("created_at").limit(100),
    db.from("creatives").select("status").eq("client_id", client.id).limit(5000),
    db.from("posts").select("status").eq("client_id", client.id).limit(5000),
    accountsState(client.id),
  ]);
  const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, adjust: 0, scheduled: 0, published: 0, failed: 0 };
  for (const r of must(statusRes) ?? []) if (r.status in counts) counts[r.status]++;
  for (const r of must(postsRes) ?? []) {
    if (r.status === "scheduled" || r.status === "processing") counts.scheduled++;
    else if (r.status === "published") counts.published++;
    else if (r.status === "failed") counts.failed++;
  }
  return json({
    client: { name: client.name, segment: client.segment, timezone: client.timezone, is_demo: client.is_demo },
    agent: must(agentRes),
    accounts,
    instagram: accounts.instagram, // compatibilidade com a versao anterior do portal
    queue: must(queueRes) ?? [],
    counts,
  });
}

async function library(client: ClientRow) {
  const rows = must(await db.from("creatives")
    .select(`id, kind, format, media_url, thumb_url, media, title, caption, hashtags, platforms, location_name, status, decision_comment, decided_at, suggested_at,
      posts ( id, platform, status, scheduled_for, published_at, permalink, last_error, is_example,
        post_metrics ( views, reach, likes, comments, saved, shares, total_interactions, avg_watch_time_ms, fetched_at ) )`)
    .eq("client_id", client.id).in("status", ["approved", "rejected", "adjust"])
    .order("decided_at", { ascending: false }).limit(300)) ?? [];

  const totals = { published: 0, views: 0, reach: 0, interactions: 0, with_metrics: 0 };
  const items = rows.map((r: any) => {
    const list = (Array.isArray(r.posts) ? r.posts : r.posts ? [r.posts] : []) as any[];
    const posts = list.map((p) => {
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
    }).sort((a, b) => String(a.platform).localeCompare(String(b.platform)));
    const first = posts.find((p) => p.platform === "instagram") ?? posts[0] ?? null;
    const { posts: _p, ...creative } = r;
    // "post" e "metrics" ficam por compatibilidade com a versao anterior do portal.
    return { ...creative, posts, post: first ? { ...first, metrics: undefined } : null, metrics: first?.metrics ?? null };
  });
  return json({ items, totals });
}

async function decide(client: ClientRow, req: Request) {
  const body = await readJson(req);
  if (!isUuid(body.creative_id)) throw new HttpError(400, "bad_id", "Criativo inválido.");
  const action = str(body.action, 10);
  if (!["approve", "reject", "adjust"].includes(action)) throw new HttpError(400, "bad_action", "Ação inválida.");
  const res = must(await db.rpc("portal_decide", {
    p_client_id: client.id, p_creative_id: body.creative_id, p_action: action,
    p_comment: str(body.comment, 1000) || null, p_via: "portal",
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
  const creative = must(await db.from("creatives").select(CREATIVE_FIELDS).eq("id", body.creative_id).maybeSingle());
  return json({ ok: true, creative });
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
    must(await db.from("social_accounts").delete().eq("id", acc.id));
  }
  return json({ ok: true });
}

export async function portalRoutes(req: Request, path: string): Promise<Response> {
  const client = await authPortal(req);
  const m = req.method;
  if (m === "GET" && path === "/bootstrap") return bootstrap(client);
  if (m === "GET" && path === "/library") return library(client);
  if (m === "POST" && path === "/decide") return decide(client, req);
  if (m === "POST" && path === "/undo") return undo(client, req);
  if (m === "POST" && (path === "/instagram/start" || path === "/connect/instagram/start")) return instagramStart(client);
  if (m === "POST" && (path === "/instagram/disconnect" || path === "/connect/instagram/disconnect")) return instagramDisconnect(client);
  if (m === "POST" && path === "/connect/tiktok/start") return tiktokStart(client);
  if (m === "POST" && path === "/connect/tiktok/disconnect") return tiktokDisconnect(client);
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}
