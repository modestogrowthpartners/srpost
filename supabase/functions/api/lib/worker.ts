// Worker (chamado a cada 5 min pelo pg_cron): publica posts vencidos pelo adaptador de cada conta,
// acompanha os jobs, cuida das conexoes e atualiza metricas. Cada tentativa fica registrada em post_attempts.
import { db, must, one } from "./core.ts";
import * as ig from "./instagram.ts";
import * as up from "./uploadpost.ts";
import { AccountRow, adapterFor, classifyError, CreativeRow, Failure, PublishJob, ReconnectError } from "./publishers.ts";

type Summary = Record<string, number | string[]>;
const ACCOUNT_FIELDS = "id, client_id, platform, provider, provider_ref, external_id, status, token_issued_at, token_expires_at, updated_at";
const CREATIVE_FIELDS = "kind, format, media_url, media, title, caption, hashtags, ai_generated, location_id, audio_name, auto_music";
const TICK_MS = 5 * 60_000;
const VALIDATE_EVERY_MS = 6 * 3_600_000;

const tokens = new Map<string, string>();
async function tokenFor(accountId: string): Promise<string> {
  if (tokens.has(accountId)) return tokens.get(accountId)!;
  const { data, error } = await db.rpc("ig_token_read", { p_account_id: accountId });
  if (error || !data) throw new ReconnectError("Token da conta indisponível.", "token_ausente");
  tokens.set(accountId, data as string);
  return data as string;
}

async function accountOf(clientId: string, platform: string): Promise<AccountRow | null> {
  const { data } = await db.from("social_accounts").select(ACCOUNT_FIELDS)
    .eq("client_id", clientId).eq("platform", platform).eq("status", "connected").maybeSingle();
  return (data as AccountRow) ?? null;
}

async function jobFor(post: any, account: AccountRow): Promise<PublishJob> {
  const { data: c } = await db.from("creatives").select(CREATIVE_FIELDS).eq("id", post.creative_id).maybeSingle();
  if (!c) throw new Error("Criativo não encontrado.");
  const adapter = adapterFor(account);
  return { creative: c as CreativeRow, account, token: adapter.needsToken ? await tokenFor(account.id) : null };
}

// A conta deixa de publicar ate o cliente reconectar pelo portal. Os posts agendados ficam preservados.
async function markExpired(account: { id: string; platform: string }, reason: string) {
  console.error(JSON.stringify({ event: "account_expired", account_id: account.id, platform: account.platform, reason }));
  await db.from("social_accounts").update({ status: "expired", last_error: reason.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", account.id);
}

// O cron roda nos minutos multiplos de 5. Mira 20 s antes do ciclo desejado para a nova tentativa
// nao perder a rodada por segundos e so sair no ciclo seguinte.
function retryAt(ticks: number): string {
  return new Date(Math.floor(Date.now() / TICK_MS) * TICK_MS + ticks * TICK_MS - 20_000).toISOString();
}

// Historico: uma linha por tentativa, com o erro como a rede devolveu. Falhas tambem vao para o log da funcao.
async function logAttempt(post: any, phase: "start" | "publish", outcome: "ok" | "retry" | "failed" | "reconnect", f?: Failure) {
  if (f) {
    console.error(JSON.stringify({
      event: "publish_attempt", post_id: post.id, platform: post.platform, attempt: post.attempts ?? 0,
      phase, outcome, code: f.code, error: f.message, detail: f.detail,
    }));
  }
  await db.from("post_attempts").insert({
    post_id: post.id, attempt: post.attempts ?? 0, phase, outcome,
    error: f ? f.message.slice(0, 1000) : null, error_code: f?.code ?? null, detail: f?.detail ?? null,
  });
}

async function handleFailure(post: any, account: AccountRow | null, phase: "start" | "publish", f: Failure, sum: Summary) {
  (sum.errors as string[]).push(`${phase} ${post.platform} ${post.id} [${f.code ?? "sem codigo"}]: ${f.message}`);
  if (f.kind === "reconnect") {
    // Sem conta conectada (por exemplo, a conexao caiu em outro post do mesmo ciclo) nao ha o que marcar.
    if (account) await markExpired(account, f.message);
    // Volta para a fila sem gastar tentativa: sai assim que o cliente reconectar.
    await db.from("posts").update({
      status: "scheduled", container_id: null, container_created_at: null,
      attempts: Math.max(0, (post.attempts ?? 1) - 1), last_error: "Reconecte a conta para publicar.",
    }).eq("id", post.id);
    await logAttempt(post, phase, "reconnect", f);
    return;
  }
  const final = f.kind !== "retry" || (post.attempts ?? 0) >= f.maxAttempts;
  await db.from("posts").update({
    status: final ? "failed" : "scheduled", container_id: null, container_created_at: null,
    last_error: f.message.slice(0, 500),
    scheduled_for: final ? post.scheduled_for : retryAt(f.ticks),
  }).eq("id", post.id);
  await logAttempt(post, phase, final ? "failed" : "retry", f);
}

const plainFailure = (code: string, message: string): Failure => ({ kind: "retry", ticks: 2, maxAttempts: 3, code, message, detail: {} });

async function startJobs(sum: Summary) {
  // Posts que ficaram em processing sem job (execucao anterior interrompida) voltam para a fila.
  await db.from("posts").update({ status: "scheduled" }).eq("status", "processing").is("container_id", null);
  const claimed = (must(await db.rpc("worker_claim_due", { p_limit: 8 })) ?? []) as any[];
  for (const post of claimed) {
    const account = await accountOf(post.client_id, post.platform);
    try {
      if (!account) throw new ReconnectError("Conta não conectada.", "sem_conta");
      const job = await jobFor(post, account);
      const ref = await adapterFor(account).start(job);
      await db.from("posts").update({
        container_id: ref, container_created_at: new Date().toISOString(), social_account_id: account.id,
      }).eq("id", post.id);
      sum.started = (sum.started as number) + 1;
    } catch (e) {
      await handleFailure(post, account, "start", classifyError(e), sum);
    }
  }
}

async function finishJobs(sum: Summary) {
  const { data: posts } = await db.from("posts").select("*").eq("status", "processing").not("container_id", "is", null).limit(20);
  for (const post of posts ?? []) {
    const account = await accountOf(post.client_id, post.platform);
    try {
      if (!account) throw new ReconnectError("Conta não conectada.", "sem_conta");
      const adapter = adapterFor(account);
      const res = await adapter.poll(await jobFor(post, account), post.container_id);
      if (res.state === "pending") {
        const age = Date.now() - new Date(post.container_created_at ?? post.created_at).getTime();
        if (age > adapter.timeoutMs) await handleFailure(post, account, "publish", plainFailure("timeout", "A rede demorou demais para processar a mídia."), sum);
        continue;
      }
      if (res.state === "failed") { await handleFailure(post, account, "publish", plainFailure("recusado", res.error), sum); continue; }
      await db.from("posts").update({
        status: "published", media_id: res.mediaId, permalink: res.permalink, published_at: new Date().toISOString(),
      }).eq("id", post.id);
      await logAttempt(post, "publish", "ok");
      sum.published = (sum.published as number) + 1;
    } catch (e) {
      await handleFailure(post, account, "publish", classifyError(e), sum);
    }
  }
}

async function maintainAccounts(sum: Summary) {
  const now = Date.now();
  const { data: accounts } = await db.from("social_accounts").select(ACCOUNT_FIELDS).eq("status", "connected").limit(300);
  for (const a of (accounts ?? []) as AccountRow[]) {
    // A cada 6 horas confere se a conexao continua valida, para avisar o cliente antes do proximo post.
    const stale = now - new Date(a.updated_at).getTime() > VALIDATE_EVERY_MS;
    try {
      if (a.provider === "uploadpost") {
        if (!stale || !a.provider_ref) continue;
        const acc = await up.connectedAccount(a.provider_ref, a.platform);
        if (!acc || acc.reauthRequired) { await markExpired(a, "A conexão com o TikTok precisa ser refeita."); continue; }
        await db.from("social_accounts").update({
          username: acc.handle ?? undefined, name: acc.displayName ?? undefined,
          profile_picture_url: acc.image ?? undefined, updated_at: new Date().toISOString(),
        }).eq("id", a.id);
        continue;
      }
      const exp = a.token_expires_at ? new Date(a.token_expires_at).getTime() : 0; // 0 = token sem validade
      const issued = a.token_issued_at ? new Date(a.token_issued_at).getTime() : 0;
      if (exp && exp < now) { await markExpired(a, "Token expirado."); continue; }
      let token = await tokenFor(a.id);
      const appId = Deno.env.get("IG_APP_ID"), secret = Deno.env.get("IG_APP_SECRET");
      if (exp && appId && secret && exp - now < 10 * 86_400_000 && now - issued > 24 * 3_600_000) {
        const r = await ig.extendToken(appId, secret, token);
        must(await db.rpc("ig_token_store", { p_account_id: a.id, p_token: r.token }));
        tokens.set(a.id, r.token); token = r.token;
        await db.from("social_accounts").update({
          token_issued_at: new Date().toISOString(),
          token_expires_at: r.expiresIn ? new Date(now + r.expiresIn * 1000).toISOString() : null,
        }).eq("id", a.id);
        sum.tokens_refreshed = (sum.tokens_refreshed as number) + 1;
      }
      if (stale) {
        const p = await ig.profile(a.external_id, token);
        await db.from("social_accounts").update({
          username: p.username ?? undefined, name: p.name ?? undefined,
          profile_picture_url: p.profile_picture_url ?? undefined,
          followers_count: typeof p.followers_count === "number" ? p.followers_count : undefined,
          updated_at: new Date().toISOString(),
        }).eq("id", a.id);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      (sum.errors as string[]).push(`account ${a.platform} ${a.id}: ${msg}`);
      if (e instanceof ReconnectError || (e instanceof ig.IgError && e.tokenInvalid)) await markExpired(a, msg);
      else console.error(JSON.stringify({ event: "account_check_failed", account_id: a.id, platform: a.platform, error: msg }));
    }
  }
}

async function syncMetrics(sum: Summary) {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data: posts } = await db.from("posts")
    .select("id, client_id, creative_id, platform, media_id, container_id, published_at, post_metrics ( fetched_at )")
    .eq("status", "published").eq("is_example", false)
    .gte("published_at", since).order("published_at", { ascending: false }).limit(300);
  const now = Date.now();
  const due = (posts ?? []).filter((p: any) => {
    if (!p.media_id && !p.container_id) return false;
    const fetched = one<any>(p.post_metrics)?.fetched_at;
    if (!fetched) return true;
    const age = now - new Date(p.published_at).getTime();
    const every = age < 3 * 86_400_000 ? 3_600_000 : age < 30 * 86_400_000 ? 12 * 3_600_000 : 7 * 86_400_000;
    return now - new Date(fetched).getTime() > every;
  }).slice(0, 15);
  for (const p of due as any[]) {
    const account = await accountOf(p.client_id, p.platform);
    if (!account) continue;
    try {
      const m = await adapterFor(account).metrics(await jobFor(p, account), { media_id: p.media_id, ref: p.container_id });
      if (!m) continue;
      must(await db.from("post_metrics").upsert({
        post_id: p.id, views: m.views ?? null, reach: m.reach ?? null, likes: m.likes ?? null,
        comments: m.comments ?? null, saved: m.saved ?? null, shares: m.shares ?? null,
        total_interactions: m.total_interactions ?? null, avg_watch_time_ms: m.avg_watch_time_ms ?? null,
        fetched_at: new Date().toISOString(),
      }));
      sum.metrics = (sum.metrics as number) + 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      (sum.errors as string[]).push(`metrics ${p.platform} ${p.id}: ${msg}`);
      console.error(JSON.stringify({ event: "metrics_failed", post_id: p.id, platform: p.platform, error: msg }));
      if (e instanceof ReconnectError) await markExpired(account, msg);
    }
  }
}

export async function runWorker(): Promise<Summary> {
  tokens.clear();
  const sum: Summary = { started: 0, published: 0, metrics: 0, tokens_refreshed: 0, errors: [] };
  await maintainAccounts(sum);
  await startJobs(sum);
  await finishJobs(sum);
  await syncMetrics(sum);
  await db.from("settings").upsert({ key: "worker_last_run", value: JSON.stringify({ at: new Date().toISOString(), ...sum }) });
  return sum;
}
