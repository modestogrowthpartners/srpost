// Worker (chamado a cada 5 min pelo pg_cron): publica posts vencidos, acompanha containers,
// renova tokens e atualiza metricas.
import { db, must, one } from "./core.ts";
import * as ig from "./instagram.ts";

type Account = { id: string; client_id: string; external_id: string; status: string; token_issued_at: string | null; token_expires_at: string | null; updated_at: string };
type Summary = Record<string, number | string[]>;

const tokens = new Map<string, string>();
async function tokenFor(accountId: string): Promise<string> {
  if (tokens.has(accountId)) return tokens.get(accountId)!;
  const { data, error } = await db.rpc("ig_token_read", { p_account_id: accountId });
  if (error || !data) throw new Error("Token do Instagram indisponível.");
  tokens.set(accountId, data as string);
  return data as string;
}

async function accountOf(clientId: string): Promise<Account | null> {
  const { data } = await db.from("social_accounts")
    .select("id, client_id, external_id, status, token_issued_at, token_expires_at, updated_at")
    .eq("client_id", clientId).eq("platform", "instagram").eq("status", "connected").maybeSingle();
  return (data as Account) ?? null;
}

async function markExpired(accountId: string, reason: string) {
  await db.from("social_accounts").update({ status: "expired", last_error: reason.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", accountId);
}

async function failOrRetry(post: any, message: string) {
  const final = (post.attempts ?? 0) >= 3;
  await db.from("posts").update({
    status: final ? "failed" : "scheduled", container_id: null, container_created_at: null,
    last_error: message.slice(0, 500),
    scheduled_for: final ? post.scheduled_for : new Date(Date.now() + 10 * 60_000).toISOString(),
  }).eq("id", post.id);
}

async function handleError(post: any, account: Account | null, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ig.IgError && e.tokenInvalid && account) {
    await markExpired(account.id, msg);
    await db.from("posts").update({
      status: "scheduled", container_id: null, container_created_at: null,
      attempts: Math.max(0, (post.attempts ?? 1) - 1), last_error: "Reconecte o Instagram para publicar.",
    }).eq("id", post.id);
    return;
  }
  await failOrRetry(post, msg);
}

async function startContainers(sum: Summary) {
  // Posts que ficaram em processing sem container (execucao anterior interrompida) voltam para a fila.
  await db.from("posts").update({ status: "scheduled" }).eq("status", "processing").is("container_id", null);
  const claimed = (must(await db.rpc("worker_claim_due", { p_limit: 8 })) ?? []) as any[];
  for (const post of claimed) {
    const account = await accountOf(post.client_id);
    try {
      if (!account) throw new Error("Conta do Instagram não conectada.");
      const { data: c } = await db.from("creatives").select("kind, format, media_url, caption, hashtags, ai_generated").eq("id", post.creative_id).maybeSingle();
      if (!c) throw new Error("Criativo não encontrado.");
      const token = await tokenFor(account.id);
      const caption = [c.caption, c.hashtags].filter(Boolean).join("\n\n");
      const containerId = await ig.createContainer(account.external_id, token, {
        kind: c.kind, format: c.format, mediaUrl: c.media_url, caption, aiGenerated: c.ai_generated,
      });
      await db.from("posts").update({
        container_id: containerId, container_created_at: new Date().toISOString(),
        social_account_id: account.id, last_error: null,
      }).eq("id", post.id);
      sum.containers = (sum.containers as number) + 1;
    } catch (e) {
      (sum.errors as string[]).push(`container ${post.id}: ${e instanceof Error ? e.message : e}`);
      await handleError(post, account, e);
    }
  }
}

async function finishContainers(sum: Summary) {
  const { data: posts } = await db.from("posts").select("*").eq("status", "processing").not("container_id", "is", null).limit(20);
  for (const post of posts ?? []) {
    const account = await accountOf(post.client_id);
    try {
      if (!account) throw new Error("Conta do Instagram não conectada.");
      const token = await tokenFor(account.id);
      const st = await ig.containerStatus(post.container_id, token);
      if (st.code === "IN_PROGRESS") {
        const age = Date.now() - new Date(post.container_created_at ?? post.created_at).getTime();
        if (age > 30 * 60_000) await failOrRetry(post, "O Instagram demorou demais para processar a mídia.");
        continue;
      }
      if (st.code === "ERROR" || st.code === "EXPIRED") {
        await failOrRetry(post, `Instagram recusou a mídia: ${st.detail || st.code}`);
        continue;
      }
      let mediaId: string | null = null;
      if (st.code === "FINISHED") mediaId = await ig.publishContainer(account.external_id, token, post.container_id);
      let permalink: string | null = null;
      if (mediaId) {
        try { permalink = (await ig.mediaInfo(mediaId, token))?.permalink ?? null; } catch (_) { /* segue sem link */ }
      }
      await db.from("posts").update({
        status: "published", media_id: mediaId, permalink, published_at: new Date().toISOString(), last_error: null,
      }).eq("id", post.id);
      sum.published = (sum.published as number) + 1;
    } catch (e) {
      (sum.errors as string[]).push(`publish ${post.id}: ${e instanceof Error ? e.message : e}`);
      await handleError(post, account, e);
    }
  }
}

async function maintainAccounts(sum: Summary) {
  const now = Date.now();
  const { data: accounts } = await db.from("social_accounts")
    .select("id, client_id, external_id, status, token_issued_at, token_expires_at, updated_at")
    .eq("platform", "instagram").eq("status", "connected").limit(200);
  for (const a of (accounts ?? []) as Account[]) {
    try {
      const exp = a.token_expires_at ? new Date(a.token_expires_at).getTime() : 0;
      const issued = a.token_issued_at ? new Date(a.token_issued_at).getTime() : 0;
      if (exp && exp < now) { await markExpired(a.id, "Token expirado."); continue; }
      const token = await tokenFor(a.id);
      if (exp - now < 10 * 86_400_000 && now - issued > 24 * 3_600_000) {
        const r = await ig.refreshToken(token);
        must(await db.rpc("ig_token_store", { p_account_id: a.id, p_token: r.token }));
        tokens.set(a.id, r.token);
        await db.from("social_accounts").update({
          token_issued_at: new Date().toISOString(),
          token_expires_at: new Date(now + r.expiresIn * 1000).toISOString(),
        }).eq("id", a.id);
        sum.tokens_refreshed = (sum.tokens_refreshed as number) + 1;
      }
      if (now - new Date(a.updated_at).getTime() > 24 * 3_600_000) {
        const p = await ig.me(tokens.get(a.id) ?? token);
        await db.from("social_accounts").update({
          username: p.username ?? undefined, name: p.name ?? undefined,
          profile_picture_url: p.profile_picture_url ?? undefined,
          followers_count: typeof p.followers_count === "number" ? p.followers_count : undefined,
          updated_at: new Date().toISOString(),
        }).eq("id", a.id);
      }
    } catch (e) {
      (sum.errors as string[]).push(`account ${a.id}: ${e instanceof Error ? e.message : e}`);
      if (e instanceof ig.IgError && e.tokenInvalid) await markExpired(a.id, e.message);
    }
  }
}

async function syncMetrics(sum: Summary) {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data: posts } = await db.from("posts")
    .select("id, client_id, media_id, published_at, creatives ( format ), post_metrics ( fetched_at )")
    .eq("status", "published").eq("is_example", false).not("media_id", "is", null)
    .gte("published_at", since).order("published_at", { ascending: false }).limit(300);
  const now = Date.now();
  const due = (posts ?? []).filter((p: any) => {
    const fetched = one<any>(p.post_metrics)?.fetched_at;
    if (!fetched) return true;
    const age = now - new Date(p.published_at).getTime();
    const every = age < 3 * 86_400_000 ? 3_600_000 : age < 30 * 86_400_000 ? 12 * 3_600_000 : 7 * 86_400_000;
    return now - new Date(fetched).getTime() > every;
  }).slice(0, 15);
  for (const p of due as any[]) {
    const account = await accountOf(p.client_id);
    if (!account) continue;
    try {
      const m = await ig.mediaInsights(p.media_id, await tokenFor(account.id), one<any>(p.creatives)?.format ?? "feed");
      must(await db.from("post_metrics").upsert({
        post_id: p.id, views: m.views ?? null, reach: m.reach ?? null, likes: m.likes ?? null,
        comments: m.comments ?? null, saved: m.saved ?? null, shares: m.shares ?? null,
        total_interactions: m.total_interactions ?? null,
        avg_watch_time_ms: m.ig_reels_avg_watch_time ?? null, fetched_at: new Date().toISOString(),
      }));
      sum.metrics = (sum.metrics as number) + 1;
    } catch (e) {
      (sum.errors as string[]).push(`metrics ${p.id}: ${e instanceof Error ? e.message : e}`);
      if (e instanceof ig.IgError && e.tokenInvalid) await markExpired(account.id, e.message);
    }
  }
}

export async function runWorker(): Promise<Summary> {
  tokens.clear();
  const sum: Summary = { containers: 0, published: 0, metrics: 0, tokens_refreshed: 0, errors: [] };
  await maintainAccounts(sum);
  await startContainers(sum);
  await finishContainers(sum);
  await syncMetrics(sum);
  await db.from("settings").upsert({ key: "worker_last_run", value: JSON.stringify({ at: new Date().toISOString(), ...sum }) });
  return sum;
}
