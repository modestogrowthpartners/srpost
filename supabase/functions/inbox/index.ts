// Sr. Post: caixa de entrada (comentarios e mensagens diretas). Modulo separado da funcao "api".
// Rotas:
//   GET  /health
//   POST /tick                      rodada (pg_cron, x-worker-secret): busca comentarios novos e responde pelas regras
//   GET  /webhook  POST /webhook    webhook da Meta (comentarios e mensagens do Instagram)
//   /portal/*                       cliente (x-portal-token): lista, responde, resolve, oculta, configura regras
//   /admin/*                        time (x-admin-key): o mesmo, para qualquer cliente
// Sem IA: as regras estao em rules.ts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { autoReply, classify, initialStatus, type InboxSettings, normalizeSettings } from "./rules.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const GRAPH = `https://graph.facebook.com/${Deno.env.get("IG_API_VERSION") ?? "v27.0"}`;
const UP_BASE = "https://api.upload-post.com";
const upKey = () => Deno.env.get("UPLOAD_POST_API_KEY") ?? "";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type,x-portal-token,x-admin-key",
  "access-control-max-age": "86400",
};

class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getSetting(key: string) {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined) ?? null;
}
async function readJson(req: Request): Promise<Record<string, any>> {
  try { const b = await req.json(); if (b && typeof b === "object") return b; } catch (_) { /* abaixo */ }
  throw new HttpError(400, "invalid_json", "Corpo da requisição inválido.");
}

// ---------- Autenticacao (mesmas credenciais do portal e do painel) ----------
async function authPortal(req: Request): Promise<{ id: string; name: string }> {
  const token = req.headers.get("x-portal-token") ?? "";
  if (token.length < 20) throw new HttpError(401, "missing_token", "Link de acesso ausente.");
  const { data: link } = await db.from("portal_links").select("client_id, expires_at, revoked_at")
    .eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!link || link.revoked_at || (link.expires_at && new Date(link.expires_at) < new Date())) {
    throw new HttpError(401, "invalid_token", "Este link de acesso não é mais válido.");
  }
  const { data: c } = await db.from("clients").select("id, name").eq("id", link.client_id).maybeSingle();
  if (!c) throw new HttpError(401, "invalid_token", "Cliente não encontrado.");
  return c;
}
async function authAdmin(req: Request) {
  const key = req.headers.get("x-admin-key") ?? "";
  if (key.length < 20) throw new HttpError(401, "missing_key", "Chave de acesso ausente.");
  const { data } = await db.from("api_keys").select("role, revoked_at").eq("key_hash", await sha256Hex(key)).maybeSingle();
  if (!data || data.revoked_at || data.role !== "admin") throw new HttpError(401, "invalid_key", "Chave de acesso inválida.");
}

// ---------- Instagram (Graph API com Facebook Login) ----------
class IgError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}
async function ig(method: "GET" | "POST", path: string, params: Record<string, string>, token: string) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = method === "GET"
    ? await fetch(`${GRAPH}${path}?${qs}`)
    : await fetch(`${GRAPH}${path}`, { method: "POST", body: qs });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch (_) { /* nao JSON */ }
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    throw new IgError(String(e.error_user_msg || e.message || text.slice(0, 200) || `HTTP ${res.status}`), e.code);
  }
  return body;
}
async function tokenFor(accountId: string): Promise<string> {
  const { data, error } = await db.rpc("ig_token_read", { p_account_id: accountId });
  if (error || !data) throw new Error("Conta sem token salvo. Reconecte o Instagram.");
  return String(data);
}

// ---------- TikTok pelo Upload-Post ----------
async function up(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${UP_BASE}${path}`, {
    method,
    headers: { authorization: `Apikey ${upKey()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch (_) { /* nao JSON */ }
  if (!res.ok || data?.success === false) throw new Error(String(data?.message ?? data?.error ?? `HTTP ${res.status}`));
  return data;
}

// ---------- Regras por cliente ----------
async function settingsFor(clientId: string): Promise<InboxSettings & { auto_since: string }> {
  let { data } = await db.from("inbox_settings").select("*").eq("client_id", clientId).maybeSingle();
  if (!data) {
    const ins = await db.from("inbox_settings").insert({ client_id: clientId }).select("*").single();
    data = ins.data;
  }
  return { ...normalizeSettings(data), auto_since: data?.auto_since ?? new Date().toISOString() };
}

async function repliesToday(accountId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await db.from("inbox_items").select("id", { count: "exact", head: true })
    .eq("social_account_id", accountId).eq("replied_by", "auto").gte("replied_at", since);
  return count ?? 0;
}

type Incoming = {
  client_id: string; account: any; platform: "instagram" | "tiktok"; kind: "comment" | "dm";
  external_id: string; media_id?: string | null; media_permalink?: string | null; media_caption?: string | null;
  author_id?: string | null; author_name?: string | null; text: string; created_at_platform?: string | null;
};

// Grava o item (ignora repetidos) e devolve a linha nova, ou null se ja existia.
async function upsertItem(it: Incoming, s: InboxSettings & { auto_since: string }) {
  const { category, rule } = classify(it.text, s.keyword_rules);
  const fresh = !it.created_at_platform || new Date(it.created_at_platform) >= new Date(s.auto_since);
  const reply = it.kind === "comment" && fresh ? autoReply(category, s, rule) : null;
  const old = it.created_at_platform && Date.now() - new Date(it.created_at_platform).getTime() > 7 * 86400_000;
  const status = old ? "done" : initialStatus(category, Boolean(reply));
  const { data, error } = await db.from("inbox_items").insert({
    client_id: it.client_id, social_account_id: it.account?.id ?? null, platform: it.platform, kind: it.kind,
    external_id: it.external_id, media_id: it.media_id ?? null, media_permalink: it.media_permalink ?? null,
    media_caption: (it.media_caption ?? "").slice(0, 160) || null, author_id: it.author_id ?? null,
    author_name: it.author_name ?? null, text: it.text.slice(0, 2200), created_at_platform: it.created_at_platform ?? null,
    category, status,
  }).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") {
      // Ja registrado. Se a conta foi reconectada (linha nova), religa o item a ela.
      if (it.account?.id) {
        await db.from("inbox_items").update({ social_account_id: it.account.id })
          .eq("platform", it.platform).eq("external_id", it.external_id).is("social_account_id", null);
      }
      return null;
    }
    throw new Error(error.message);
  }
  return data ? { id: data.id as string, reply: old ? null : reply } : null;
}

async function sendReply(item: any, account: any, message: string) {
  if (item.platform === "instagram") {
    const token = await tokenFor(account.id);
    if (item.kind === "comment") return ig("POST", `/${item.external_id}/replies`, { message }, token);
    // Mensagem direta: so dentro da janela de 24 h depois da mensagem da pessoa. A VERIFICAR com conta real.
    const via = account.page_id ? `/${account.page_id}/messages` : `/me/messages`;
    return ig("POST", via, { recipient: JSON.stringify({ id: item.author_id }), message: JSON.stringify({ text: message }) }, token);
  }
  if (!upKey()) throw new Error("TikTok ainda não liberado: falta a chave do Upload-Post.");
  return up("POST", "/api/uploadposts/comments/create", {
    platform: "tiktok", user: account.provider_ref, post_id: item.media_id, comment_id: item.external_id, message,
  });
}

async function markReplied(id: string, text: string, by: "auto" | "portal" | "admin") {
  await db.from("inbox_items").update({
    status: by === "auto" ? "auto_replied" : "replied", reply_text: text, replied_at: new Date().toISOString(),
    replied_by: by, error: null, updated_at: new Date().toISOString(),
  }).eq("id", id);
}

// ---------- Rodada: Instagram ----------
async function syncInstagram(account: any) {
  const s = await settingsFor(account.client_id);
  const token = await tokenFor(account.id);
  const stats = { fetched: 0, new_items: 0, auto_replies: 0 };
  const media = await ig("GET", `/${account.external_id}/media`, {
    fields: "id,caption,permalink,timestamp,comments_count", limit: "12",
  }, token);
  const { data: states } = await db.from("inbox_media_state").select("media_id, comments_count")
    .eq("social_account_id", account.id);
  const seen = new Map((states ?? []).map((r: any) => [r.media_id, r.comments_count]));
  let budget = Math.max(0, s.daily_cap - await repliesToday(account.id));
  const own = (account.username ?? "").toLowerCase();
  for (const m of media?.data ?? []) {
    const count = Number(m.comments_count ?? 0);
    if (!count || seen.get(m.id) === count) continue;
    const r = await ig("GET", `/${m.id}/comments`, { fields: "id,text,timestamp,username,from", limit: "50" }, token);
    for (const c of r?.data ?? []) {
      stats.fetched++;
      const author = c.username ?? c.from?.username ?? null;
      if (author && author.toLowerCase() === own) continue; // comentario da propria conta
      const row = await upsertItem({
        client_id: account.client_id, account, platform: "instagram", kind: "comment", external_id: String(c.id),
        media_id: m.id, media_permalink: m.permalink ?? null, media_caption: m.caption ?? null,
        author_id: c.from?.id ?? null, author_name: author, text: String(c.text ?? ""), created_at_platform: c.timestamp ?? null,
      }, s);
      if (!row) continue;
      stats.new_items++;
      if (row.reply && budget > 0 && stats.auto_replies < 8) {
        try {
          await ig("POST", `/${c.id}/replies`, { message: row.reply }, token);
          await markReplied(row.id, row.reply, "auto");
          stats.auto_replies++; budget--;
        } catch (e) {
          await db.from("inbox_items").update({ status: "error", error: (e as Error).message.slice(0, 300) }).eq("id", row.id);
        }
      } else if (row.reply) {
        // Sem cota hoje: fica para uma pessoa.
        await db.from("inbox_items").update({ status: "pending" }).eq("id", row.id);
      }
    }
    await db.from("inbox_media_state").upsert({
      social_account_id: account.id, media_id: m.id, comments_count: count, checked_at: new Date().toISOString(),
    });
  }
  return stats;
}

// ---------- Rodada: TikTok (Upload-Post) ----------
async function syncTiktok(account: any) {
  const stats = { fetched: 0, new_items: 0, auto_replies: 0 };
  if (!upKey() || !account.provider_ref) return stats;
  const s = await settingsFor(account.client_id);
  let budget = Math.max(0, s.daily_cap - await repliesToday(account.id));
  const { data: posts } = await db.from("posts").select("media_id, permalink, published_at")
    .eq("social_account_id", account.id).eq("status", "published").not("media_id", "is", null)
    .order("published_at", { ascending: false }).limit(8);
  for (const p of posts ?? []) {
    const r = await up("GET", `/api/uploadposts/comments?platform=tiktok&user=${encodeURIComponent(account.provider_ref)}&post_id=${encodeURIComponent(p.media_id)}&limit=50`);
    const list: any[] = r?.comments ?? r?.data ?? [];
    for (const c of list) {
      stats.fetched++;
      const id = String(c.id ?? c.comment_id ?? "");
      if (!id) continue;
      const row = await upsertItem({
        client_id: account.client_id, account, platform: "tiktok", kind: "comment", external_id: id,
        media_id: p.media_id, media_permalink: p.permalink ?? null,
        author_id: String(c.user?.id ?? c.author_id ?? "") || null,
        author_name: c.user?.username ?? c.username ?? c.author ?? null,
        text: String(c.text ?? c.message ?? ""),
        created_at_platform: c.create_time ? new Date(Number(c.create_time) * 1000).toISOString() : (c.timestamp ?? null),
      }, s);
      if (!row) continue;
      stats.new_items++;
      if (row.reply && budget > 0 && stats.auto_replies < 8) {
        try {
          await up("POST", "/api/uploadposts/comments/create", {
            platform: "tiktok", user: account.provider_ref, post_id: p.media_id, comment_id: id, message: row.reply,
          });
          await markReplied(row.id, row.reply, "auto");
          stats.auto_replies++; budget--;
        } catch (e) {
          await db.from("inbox_items").update({ status: "error", error: (e as Error).message.slice(0, 300) }).eq("id", row.id);
        }
      }
    }
  }
  return stats;
}

async function tick() {
  const { data: accounts } = await db.from("social_accounts")
    .select("id, client_id, platform, external_id, username, page_id, provider, provider_ref, status")
    .eq("status", "connected");
  const out: any[] = [];
  for (const a of accounts ?? []) {
    const run = { social_account_id: a.id, fetched: 0, new_items: 0, auto_replies: 0, error: null as string | null };
    try {
      const st = a.platform === "instagram" ? await syncInstagram(a) : await syncTiktok(a);
      Object.assign(run, st);
    } catch (e) {
      run.error = (e as Error).message.slice(0, 400);
    }
    // So registra rodadas com novidade ou erro, para nao encher a tabela.
    if (run.new_items || run.error) await db.from("inbox_runs").insert(run);
    out.push({ account: a.username ?? a.id, platform: a.platform, ...run });
  }
  return { ok: true, accounts: out };
}

// ---------- Webhook da Meta ----------
async function verifySignature(req: Request, raw: string) {
  const secret = Deno.env.get("IG_APP_SECRET") ?? "";
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!secret || !sig.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === sig.slice(7);
}

async function webhook(req: Request) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const expected = await getSetting("inbox_verify_token");
    if (url.searchParams.get("hub.mode") === "subscribe" && expected && url.searchParams.get("hub.verify_token") === expected) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  const raw = await req.text();
  if (!(await verifySignature(req, raw))) return new Response("bad signature", { status: 401 });
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { return new Response("ok"); }
  for (const entry of body?.entry ?? []) {
    const igId = String(entry.id ?? "");
    const { data: account } = await db.from("social_accounts")
      .select("id, client_id, platform, external_id, username, page_id, provider, provider_ref, status")
      .eq("platform", "instagram").or(`external_id.eq.${igId},page_id.eq.${igId}`).maybeSingle();
    if (!account) continue;
    const s = await settingsFor(account.client_id);
    for (const ch of entry.changes ?? []) {
      if (ch.field !== "comments" || !ch.value?.id) continue;
      const v = ch.value;
      if ((v.from?.username ?? "").toLowerCase() === (account.username ?? "").toLowerCase()) continue;
      const row = await upsertItem({
        client_id: account.client_id, account, platform: "instagram", kind: "comment", external_id: String(v.id),
        media_id: v.media?.id ?? null, author_id: v.from?.id ?? null, author_name: v.from?.username ?? null,
        text: String(v.text ?? ""), created_at_platform: new Date().toISOString(),
      }, s);
      if (row?.reply && (await repliesToday(account.id)) < s.daily_cap) {
        try { await sendReply({ platform: "instagram", kind: "comment", external_id: String(v.id) }, account, row.reply); await markReplied(row.id, row.reply, "auto"); }
        catch (e) { await db.from("inbox_items").update({ status: "error", error: (e as Error).message.slice(0, 300) }).eq("id", row.id); }
      }
    }
    for (const m of entry.messaging ?? []) {
      if (!m.message || m.message.is_echo || !m.sender?.id) continue;
      await upsertItem({
        client_id: account.client_id, account, platform: "instagram", kind: "dm", external_id: String(m.message.mid ?? `${m.sender.id}-${m.timestamp}`),
        author_id: String(m.sender.id), text: String(m.message.text ?? (m.message.attachments ? "[anexo]" : "")),
        created_at_platform: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : new Date().toISOString(),
      }, s);
    }
  }
  return new Response("ok");
}

// ---------- Rotas do portal e do painel ----------
const ITEM_FIELDS = "id, client_id, platform, kind, media_permalink, media_caption, author_name, text, created_at_platform, category, status, reply_text, replied_at, replied_by, error";

async function listItems(clientId: string | null, status: string) {
  let q = db.from("inbox_items").select(`${ITEM_FIELDS}, clients(name)`).order("created_at_platform", { ascending: false, nullsFirst: false }).limit(200);
  if (clientId) q = q.eq("client_id", clientId);
  if (status === "pending") q = q.in("status", ["pending", "error"]);
  else if (status && status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new HttpError(500, "db_error", error.message);
  return data ?? [];
}

async function summary(clientId: string | null) {
  const base = () => { const q = db.from("inbox_items").select("id", { count: "exact", head: true }); return clientId ? q.eq("client_id", clientId) : q; };
  const [{ count: pending }, { count: auto }] = await Promise.all([
    base().in("status", ["pending", "error"]),
    base().eq("status", "auto_replied").gte("replied_at", new Date(Date.now() - 7 * 86400_000).toISOString()),
  ]);
  let accountsQ = db.from("social_accounts").select("id, client_id, platform, username, scopes, status");
  if (clientId) accountsQ = accountsQ.eq("client_id", clientId);
  const { data: accounts } = await accountsQ;
  const ids = (accounts ?? []).map((a: any) => a.id);
  const { data: runs } = ids.length
    ? await db.from("inbox_runs").select("social_account_id, started_at, new_items, auto_replies, error").in("social_account_id", ids).order("started_at", { ascending: false }).limit(10)
    : { data: [] };
  const canComment = (a: any) => a.platform !== "instagram" || (a.scopes ?? []).includes("instagram_manage_comments");
  return {
    pending: pending ?? 0, auto_replied_7d: auto ?? 0,
    accounts: (accounts ?? []).map((a: any) => ({
      platform: a.platform, username: a.username, status: a.status, comments_ready: canComment(a) && (a.platform !== "tiktok" || Boolean(upKey())),
      missing: a.platform === "instagram" && !canComment(a) ? "Reconecte o Instagram para liberar a permissão de comentários." : (a.platform === "tiktok" && !upKey() ? "TikTok em liberação." : null),
    })),
    last_runs: runs ?? [],
  };
}

async function itemFor(id: string, clientId: string | null) {
  if (!isUuid(id)) throw new HttpError(400, "bad_id", "Item inválido.");
  let q = db.from("inbox_items").select("*").eq("id", id);
  if (clientId) q = q.eq("client_id", clientId);
  const { data } = await q.maybeSingle();
  if (!data) throw new HttpError(404, "not_found", "Comentário não encontrado.");
  return data;
}

async function act(req: Request, action: string, clientId: string | null, by: "portal" | "admin") {
  const body = await readJson(req);
  const item = await itemFor(str(body.id, 40), clientId);
  let { data: account } = item.social_account_id
    ? await db.from("social_accounts").select("*").eq("id", item.social_account_id).maybeSingle()
    : { data: null };
  if (!account) {
    // A conta pode ter sido reconectada: usa a conta atual do mesmo cliente e rede.
    ({ data: account } = await db.from("social_accounts").select("*").eq("client_id", item.client_id)
      .eq("platform", item.platform).eq("status", "connected").limit(1).maybeSingle());
    if (account) await db.from("inbox_items").update({ social_account_id: account.id }).eq("id", item.id);
  }
  if (action === "reply") {
    const text = str(body.text, 1000);
    if (!text) throw new HttpError(400, "empty", "Escreva a resposta.");
    if (!account) throw new HttpError(409, "no_account", "A conta deste comentário foi desconectada.");
    try { await sendReply(item, account, text); }
    catch (e) {
      await db.from("inbox_items").update({ status: "error", error: (e as Error).message.slice(0, 300) }).eq("id", item.id);
      throw new HttpError(502, "send_failed", `A rede recusou a resposta: ${(e as Error).message.slice(0, 200)}`);
    }
    await markReplied(item.id, text, by);
  } else if (action === "resolve") {
    await db.from("inbox_items").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", item.id);
  } else if (action === "reopen") {
    await db.from("inbox_items").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", item.id);
  } else if (action === "hide") {
    if (item.platform !== "instagram" || item.kind !== "comment") throw new HttpError(400, "unsupported", "Ocultar só vale para comentário do Instagram.");
    if (!account) throw new HttpError(409, "no_account", "A conta deste comentário foi desconectada.");
    try { await ig("POST", `/${item.external_id}`, { hide: "true" }, await tokenFor(account.id)); }
    catch (e) { throw new HttpError(502, "hide_failed", `A rede recusou: ${(e as Error).message.slice(0, 200)}`); }
    await db.from("inbox_items").update({ status: "hidden", updated_at: new Date().toISOString() }).eq("id", item.id);
  } else throw new HttpError(404, "not_found", "Ação desconhecida.");
  return json({ ok: true });
}

async function settingsRoute(req: Request, clientId: string) {
  if (req.method === "GET") {
    const s = await settingsFor(clientId);
    return json({ settings: s, verify_token: null });
  }
  const b = await readJson(req);
  const s = normalizeSettings({ ...(await settingsFor(clientId)), ...b });
  const { error } = await db.from("inbox_settings").update({ ...s, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  if (error) throw new HttpError(500, "db_error", error.message);
  return json({ ok: true, settings: s });
}

async function portalRoutes(req: Request, sub: string) {
  const client = await authPortal(req);
  if (sub === "/items" && req.method === "GET") {
    const status = new URL(req.url).searchParams.get("status") ?? "pending";
    return json({ client: client.name, items: await listItems(client.id, status), summary: await summary(client.id) });
  }
  if (sub === "/settings") return settingsRoute(req, client.id);
  const m = sub.match(/^\/(reply|resolve|reopen|hide)$/);
  if (m && req.method === "POST") return act(req, m[1], client.id, "portal");
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}

async function adminRoutes(req: Request, sub: string) {
  await authAdmin(req);
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client_id");
  if (sub === "/items" && req.method === "GET") {
    const cid = isUuid(clientId) ? clientId : null;
    const { data: clients } = await db.from("clients").select("id, name").order("name");
    return json({
      clients: clients ?? [], items: await listItems(cid, url.searchParams.get("status") ?? "pending"), summary: await summary(cid),
      webhook: { url: `${SUPABASE_URL}/functions/v1/inbox/webhook`, verify_token: await getSetting("inbox_verify_token") },
    });
  }
  if (sub === "/settings") {
    if (!isUuid(clientId)) throw new HttpError(400, "bad_client", "Escolha um cliente.");
    return settingsRoute(req, clientId);
  }
  if (sub === "/tick" && req.method === "POST") return json(await tick());
  const m = sub.match(/^\/(reply|resolve|reopen|hide)$/);
  if (m && req.method === "POST") return act(req, m[1], null, "admin");
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/inbox(?=\/|$)/, "") || "/";
  try {
    if (path === "/health") return json({ ok: true, tiktok: Boolean(upKey()) });
    if (path === "/webhook") return await webhook(req);
    if (path === "/tick" && req.method === "POST") {
      const expected = await getSetting("worker_secret");
      if (!expected || req.headers.get("x-worker-secret") !== expected) throw new HttpError(401, "forbidden", "Sem permissão.");
      return json(await tick());
    }
    if (path.startsWith("/portal/")) return await portalRoutes(req, path.slice(7));
    if (path.startsWith("/admin/")) return await adminRoutes(req, path.slice(6));
    throw new HttpError(404, "not_found", "Rota não encontrada.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error("inbox unhandled", path, e);
    return json({ error: "internal", message: "Erro interno. Tente de novo em instantes." }, 500);
  }
});
