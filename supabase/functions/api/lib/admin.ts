// Rotas do painel do time (x-admin-key) e de ingestao por API (x-api-key).
import {
  authKey, BUCKET, createCreatives, db, FUNCTIONS_BASE, getSetting, HttpError, igConfigured, isUuid, json, must, one,
  portalUrl, randomToken, readJson, sha256Hex, signedUpload, str,
} from "./core.ts";

function slugify(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function agentPatch(a: Record<string, unknown> | undefined) {
  if (!a || typeof a !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["name", "role_line", "bio", "tone"]) if (k in a) out[k] = str(a[k], 600) || null;
  if ("name" in a && !out.name) out.name = "Agente Sr. Post";
  if (Array.isArray(a.pillars)) out.pillars = a.pillars.map((p) => str(p, 60)).filter(Boolean).slice(0, 8);
  if (Array.isArray(a.post_times)) {
    const times = a.post_times.map((t) => str(t, 5)).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    out.post_times = [...new Set(times)].sort().slice(0, 6);
  }
  if (typeof a.posts_per_week === "number") out.posts_per_week = Math.min(28, Math.max(1, Math.round(a.posts_per_week)));
  if (typeof a.status === "string" && ["ativo", "pausado", "configurando"].includes(a.status)) out.status = a.status;
  return out;
}

async function overview() {
  const [clients, creatives, posts, worker] = await Promise.all([
    db.from("clients").select(`id, name, slug, segment, status, is_demo, created_at,
      agents ( name, status, posts_per_week, post_times ),
      social_accounts ( username, status, followers_count, token_expires_at, last_error )`).order("created_at"),
    db.from("creatives").select("client_id, status").limit(10000),
    db.from("posts").select("client_id, status").limit(10000),
    getSetting("worker_last_run"),
  ]);
  const counts: Record<string, Record<string, number>> = {};
  const bump = (id: string, k: string) => { (counts[id] ??= {})[k] = (counts[id][k] ?? 0) + 1; };
  for (const c of must(creatives) ?? []) bump(c.client_id, c.status);
  for (const p of must(posts) ?? []) bump(p.client_id, `post_${p.status}`);
  return json({
    clients: (must(clients) ?? []).map((c: any) => ({
      ...c, agent: one(c.agents), instagram: one(c.social_accounts), agents: undefined, social_accounts: undefined,
      counts: counts[c.id] ?? {},
    })),
    config: {
      ig_configured: igConfigured(), portal_url: await portalUrl(),
      oauth_redirect_uri: `${FUNCTIONS_BASE}/instagram/callback`,
      deauthorize_url: `${FUNCTIONS_BASE}/instagram/deauthorize`,
      data_deletion_url: `${FUNCTIONS_BASE}/instagram/data-deletion`,
      ingest_base: `${FUNCTIONS_BASE}/ingest`,
      worker_last_run: worker ? JSON.parse(worker) : null,
    },
  });
}

async function createClient(req: Request) {
  const b = await readJson(req);
  const name = str(b.name, 80);
  if (name.length < 2) throw new HttpError(400, "bad_name", "Informe o nome do cliente.");
  let slug = slugify(str(b.slug, 60) || name);
  if (slug.length < 2) slug = `cliente-${Date.now().toString(36)}`;
  const { data: dup } = await db.from("clients").select("id").eq("slug", slug).maybeSingle();
  if (dup) slug = `${slug.slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`;
  const client = must(await db.from("clients").insert({
    name, slug, segment: str(b.segment, 80) || null, timezone: str(b.timezone, 60) || "America/Sao_Paulo",
  }).select("id, name, slug").single()) as { id: string };
  must(await db.from("agents").insert({ client_id: client.id, ...agentPatch(b.agent as Record<string, unknown>) }));
  return json({ client }, 201);
}

async function updateClient(id: string, req: Request) {
  const b = await readJson(req);
  const patch: Record<string, unknown> = {};
  if ("name" in b && str(b.name, 80).length >= 2) patch.name = str(b.name, 80);
  if ("segment" in b) patch.segment = str(b.segment, 80) || null;
  if (typeof b.status === "string" && ["active", "paused"].includes(b.status)) patch.status = b.status;
  if (Object.keys(patch).length) must(await db.from("clients").update(patch).eq("id", id));
  const ap = agentPatch(b.agent as Record<string, unknown>);
  if (Object.keys(ap).length) {
    must(await db.from("agents").upsert({ client_id: id, ...ap, updated_at: new Date().toISOString() }, { onConflict: "client_id" }));
  }
  return json({ ok: true });
}

async function clientDetail(id: string) {
  const [client, links, creatives] = await Promise.all([
    db.from("clients").select(`id, name, slug, segment, status, timezone, is_demo,
      agents ( name, role_line, bio, tone, pillars, posts_per_week, post_times, platforms, status ),
      social_accounts ( username, name, status, followers_count, account_type, token_expires_at, connected_at, last_error )`).eq("id", id).maybeSingle(),
    db.from("portal_links").select("id, label, created_at, expires_at, revoked_at, last_used_at").eq("client_id", id).order("created_at", { ascending: false }),
    db.from("creatives").select(`id, kind, format, media_url, thumb_url, title, caption, hashtags, ai_generated, suggested_at,
      status, decision_comment, decided_at, revision_of, source, created_at,
      posts ( id, status, scheduled_for, published_at, permalink, attempts, last_error,
        post_metrics ( views, reach, likes, comments, saved, shares, total_interactions, fetched_at ) )`)
      .eq("client_id", id).order("created_at", { ascending: false }).limit(400),
  ]);
  const c = must(client) as any;
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  return json({
    client: { ...c, agent: one(c.agents), instagram: one(c.social_accounts), agents: undefined, social_accounts: undefined },
    links: must(links) ?? [],
    creatives: (must(creatives) ?? []).map((r: any) => {
      const post = one<any>(r.posts);
      return { ...r, posts: undefined, post: post ? { ...post, post_metrics: undefined } : null, metrics: post ? one(post.post_metrics) : null };
    }),
  });
}

async function createLink(id: string, req: Request) {
  const b = await readJson(req);
  const { data: c } = await db.from("clients").select("id").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  const token = randomToken(32);
  const days = typeof b.expires_days === "number" && b.expires_days > 0 ? Math.min(730, b.expires_days) : null;
  must(await db.from("portal_links").insert({
    client_id: id, token_hash: await sha256Hex(token), label: str(b.label, 80) || null,
    expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  }));
  return json({ url: `${await portalUrl()}#${token}` }, 201);
}

async function deleteCreative(id: string) {
  const { data: c } = await db.from("creatives").select("id, media_path, thumb_url, posts ( status )").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Criativo não encontrado.");
  const st = one<any>((c as any).posts)?.status;
  if (st === "processing" || st === "published") {
    throw new HttpError(409, "has_post", "Este criativo já foi publicado ou está em publicação.");
  }
  must(await db.from("creatives").delete().eq("id", id));
  if (c.media_path) await db.storage.from(BUCKET).remove([c.media_path]);
  return json({ ok: true });
}

async function updateCreative(id: string, req: Request) {
  const b = await readJson(req);
  const patch: Record<string, unknown> = {};
  if ("caption" in b) patch.caption = str(b.caption, 2200);
  if ("hashtags" in b) patch.hashtags = str(b.hashtags, 600);
  if ("title" in b) patch.title = str(b.title, 120) || null;
  if ("suggested_at" in b) {
    const d = b.suggested_at ? new Date(String(b.suggested_at)) : null;
    if (d && isNaN(d.getTime())) throw new HttpError(400, "bad_date", "Data inválida.");
    patch.suggested_at = d ? d.toISOString() : null;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "empty", "Nada para atualizar.");
  const rows = must(await db.from("creatives").update(patch).eq("id", id).eq("status", "pending").select("id")) as unknown[];
  if (!rows?.length) throw new HttpError(409, "not_pending", "Só é possível editar criativos que ainda estão na fila.");
  return json({ ok: true });
}

async function reopenCreative(id: string) {
  const { data: c } = await db.from("creatives").select("client_id").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Criativo não encontrado.");
  const res = must(await db.rpc("portal_undo", { p_client_id: c.client_id, p_creative_id: id, p_via: "admin" })) as any;
  if (!res?.ok) throw new HttpError(409, res?.error ?? "conflict", "Não foi possível devolver para a fila.");
  return json({ ok: true });
}

async function retryPost(id: string) {
  const rows = must(await db.from("posts").update({
    status: "scheduled", attempts: 0, last_error: null, container_id: null, container_created_at: null,
    scheduled_for: new Date().toISOString(),
  }).eq("id", id).eq("status", "failed").select("id")) as unknown[];
  if (!rows?.length) throw new HttpError(409, "not_failed", "Só posts com falha podem ser reenviados.");
  return json({ ok: true });
}

async function createKey(req: Request) {
  const b = await readJson(req);
  const role = str(b.role, 10);
  if (!["admin", "ingest"].includes(role)) throw new HttpError(400, "bad_role", "role deve ser admin ou ingest.");
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, "bad_name", "Dê um nome para a chave.");
  const key = `srp_${role === "admin" ? "adm" : "ing"}_${randomToken(30)}`;
  must(await db.from("api_keys").insert({ name, role, key_hash: await sha256Hex(key) }));
  return json({ key }, 201);
}

export async function adminRoutes(req: Request, path: string): Promise<Response> {
  const me = await authKey(req, ["admin"]);
  const m = req.method;
  const seg = path.split("/").filter(Boolean);

  if (m === "GET" && path === "/overview") return overview();
  if (m === "POST" && path === "/clients") return createClient(req);
  if (seg[0] === "clients" && isUuid(seg[1])) {
    if (m === "GET" && seg.length === 2) return clientDetail(seg[1]);
    if (m === "PATCH" && seg.length === 2) return updateClient(seg[1], req);
    if (m === "POST" && seg[2] === "links") return createLink(seg[1], req);
  }
  if (m === "POST" && seg[0] === "links" && isUuid(seg[1]) && seg[2] === "revoke") {
    must(await db.from("portal_links").update({ revoked_at: new Date().toISOString() }).eq("id", seg[1]));
    return json({ ok: true });
  }
  if (m === "POST" && path === "/upload-url") {
    const b = await readJson(req);
    if (!isUuid(b.client_id)) throw new HttpError(400, "bad_client", "client_id inválido.");
    return json(await signedUpload(b.client_id, str(b.filename, 200), str(b.content_type, 60)));
  }
  if (m === "POST" && path === "/creatives") {
    const b = await readJson(req);
    if (!isUuid(b.client_id)) throw new HttpError(400, "bad_client", "client_id inválido.");
    return json(await createCreatives(b.client_id, b.items, "upload"), 201);
  }
  if (seg[0] === "creatives" && isUuid(seg[1])) {
    if (m === "PATCH" && seg.length === 2) return updateCreative(seg[1], req);
    if (m === "DELETE" && seg.length === 2) return deleteCreative(seg[1]);
    if (m === "POST" && seg[2] === "reopen") return reopenCreative(seg[1]);
  }
  if (m === "POST" && seg[0] === "posts" && isUuid(seg[1]) && seg[2] === "retry") return retryPost(seg[1]);
  if (m === "GET" && path === "/keys") {
    return json({ keys: must(await db.from("api_keys").select("id, name, role, created_at, last_used_at, revoked_at").order("created_at")), current: me.id });
  }
  if (m === "POST" && path === "/keys") return createKey(req);
  if (m === "POST" && seg[0] === "keys" && isUuid(seg[1]) && seg[2] === "revoke") {
    if (seg[1] === me.id) throw new HttpError(409, "self_revoke", "Você não pode revogar a chave que está usando.");
    must(await db.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", seg[1]));
    return json({ ok: true });
  }
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}

// Ingestao por API: o n8n ou o agente gerador envia criativos direto para a fila do cliente.
export async function ingestRoutes(req: Request, path: string): Promise<Response> {
  await authKey(req, ["ingest", "admin"]);
  if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
  const b = await readJson(req);
  const slug = str(b.client_slug, 60);
  const { data: client } = await db.from("clients").select("id").eq("slug", slug).maybeSingle();
  if (!client) throw new HttpError(404, "client_not_found", `Cliente "${slug}" não encontrado.`);
  if (path === "/upload-url") return json(await signedUpload(client.id, str(b.filename, 200), str(b.content_type, 60)));
  if (path === "/creatives") return json(await createCreatives(client.id, b.items, "api"), 201);
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}
