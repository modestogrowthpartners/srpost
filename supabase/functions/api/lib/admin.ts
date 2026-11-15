// Rotas do painel do time (x-admin-key) e de ingestao por API (x-api-key).
import {
  authKey, BUCKET, createCreatives, db, FUNCTIONS_BASE, getSetting, HttpError, igConfigured, isUuid, json, must, one,
  PLATFORMS, portalUrl, randomToken, readJson, sha256Hex, signedUpload, str,
} from "./core.ts";
import { IgError, publishingLimit, searchPlaces } from "./instagram.ts";
import { uploadPostConfigured } from "./uploadpost.ts";
import { composeCaption, creativeOptions, normalizeOptions, optionColumns } from "./options.ts";
import { friendlyError, pacing } from "./portal.ts";
import { agentPatch, createClientWithAgent, newPortalLink } from "./agentcfg.ts";

async function overview() {
  const [clients, creatives, posts, worker, igError, configId, ttError, pace] = await Promise.all([
    db.from("clients").select(`id, name, slug, segment, status, is_demo, created_at,
      agents ( name, status, posts_per_week, post_times, platforms ),
      social_accounts ( platform, username, status, followers_count, token_expires_at, last_error, simulated, cooldown_until )`).order("created_at"),
    db.from("creatives").select("client_id, status").is("story_of", null).limit(10000),
    db.from("posts").select("client_id, status").limit(10000),
    getSetting("worker_last_run"),
    getSetting("ig_last_oauth_error"),
    getSetting("ig_login_config_id"),
    getSetting("tiktok_last_connect_error"),
    pacing(),
  ]);
  const accountsOf = (c: any) => (Array.isArray(c.social_accounts) ? c.social_accounts : c.social_accounts ? [c.social_accounts] : []) as any[];
  const counts: Record<string, Record<string, number>> = {};
  const bump = (id: string, k: string) => { (counts[id] ??= {})[k] = (counts[id][k] ?? 0) + 1; };
  for (const c of must(creatives) ?? []) bump(c.client_id, c.status);
  for (const p of must(posts) ?? []) bump(p.client_id, `post_${p.status}`);
  return json({
    clients: (must(clients) ?? []).map((c: any) => ({
      ...c, agent: one(c.agents), accounts: accountsOf(c),
      instagram: accountsOf(c).find((a) => a.platform === "instagram") ?? null,
      agents: undefined, social_accounts: undefined,
      counts: counts[c.id] ?? {},
    })),
    config: {
      ig_configured: igConfigured(), portal_url: await portalUrl(),
      oauth_redirect_uri: `${FUNCTIONS_BASE}/instagram/callback`,
      deauthorize_url: `${FUNCTIONS_BASE}/instagram/deauthorize`,
      data_deletion_url: `${FUNCTIONS_BASE}/instagram/data-deletion`,
      ingest_base: `${FUNCTIONS_BASE}/ingest`,
      worker_last_run: worker ? JSON.parse(worker) : null,
      ig_login_config_id: Deno.env.get("IG_LOGIN_CONFIG_ID") ?? configId,
      ig_last_oauth_error: igError ? JSON.parse(igError) : null,
      tiktok_configured: uploadPostConfigured(), tiktok_provider: "uploadpost",
      tiktok_last_connect_error: ttError ? JSON.parse(ttError) : null,
      pacing: pace,
    },
  });
}

async function createClient(req: Request) {
  return json({ client: await createClientWithAgent(await readJson(req)) }, 201);
}

async function updateClient(id: string, req: Request) {
  const b = await readJson(req);
  const patch: Record<string, unknown> = {};
  if ("name" in b && str(b.name, 80).length >= 2) patch.name = str(b.name, 80);
  if ("segment" in b) patch.segment = str(b.segment, 80) || null;
  if (typeof b.status === "string" && ["active", "paused"].includes(b.status)) patch.status = b.status;
  if (Object.keys(patch).length) must(await db.from("clients").update(patch).eq("id", id));
  const ap = agentPatch(b.agent as Record<string, unknown>);
  // Simulacao so em cliente de demonstracao, por qualquer rota.
  if (ap.text_provider === "simulado" || ap.media_provider === "simulado") {
    const { data: cl } = await db.from("clients").select("is_demo").eq("id", id).maybeSingle();
    if (!cl?.is_demo) throw new HttpError(409, "not_demo", "Fornecedor simulado só pode ser usado em cliente de demonstração.");
  }
  if (Object.keys(ap).length) {
    must(await db.from("agents").upsert({ client_id: id, ...ap, updated_at: new Date().toISOString() }, { onConflict: "client_id" }));
  }
  return json({ ok: true });
}

async function clientDetail(id: string) {
  const postFields = `id, platform, status, scheduled_for, published_at, permalink, attempts, last_error, last_error_code,
        post_metrics ( views, reach, likes, comments, saved, shares, total_interactions, fetched_at ),
        post_attempts ( attempt, phase, outcome, error, error_code, created_at )`;
  const [client, links, creatives, stories, keys] = await Promise.all([
    db.from("clients").select(`id, name, slug, segment, status, timezone, is_demo,
      agents ( name, role_line, bio, tone, pillars, posts_per_week, post_times, platforms, status ),
      social_accounts ( platform, provider, provider_ref, username, name, status, followers_count, account_type, token_expires_at, connected_at, last_error, page_name, simulated, cooldown_until, spam_strikes )`).eq("id", id).maybeSingle(),
    db.from("portal_links").select("id, label, created_at, expires_at, revoked_at, last_used_at").eq("client_id", id).order("created_at", { ascending: false }),
    db.from("creatives").select(`id, kind, format, media_url, thumb_url, media, title, caption, hashtags, link_url, platforms, location_id, location_name,
      audio_name, auto_music, opt_story, opt_caption, opt_location, ai_generated, suggested_at, status, decision_comment, decided_at, revision_of, source, external_ref, created_at,
      posts!posts_creative_id_fkey ( ${postFields} )`)
      .eq("client_id", id).is("story_of", null).order("created_at", { ascending: false }).limit(400),
    db.from("creatives").select(`story_of, posts!posts_creative_id_fkey ( ${postFields} )`).eq("client_id", id).not("story_of", "is", null).limit(400),
    db.from("api_keys").select("id, name, role, created_at, last_used_at, revoked_at").eq("client_id", id).order("created_at"),
  ]);
  const c = must(client) as any;
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as any[];
  const accounts = list(c.social_accounts);
  const extra = new Map<string, any[]>();
  for (const s of must(stories) ?? []) extra.set(s.story_of, [...(extra.get(s.story_of) ?? []), ...list(s.posts)]);
  return json({
    client: {
      ...c, agent: one(c.agents), accounts,
      instagram: accounts.find((a) => a.platform === "instagram") ?? null, agents: undefined, social_accounts: undefined,
    },
    links: must(links) ?? [],
    keys: must(keys) ?? [],
    creatives: (must(creatives) ?? []).map((r: any) => {
      const all = [
        ...list(r.posts).map((p) => ({ ...p, placement: r.format === "story" ? "story" : "main" })),
        ...(extra.get(r.id) ?? []).map((p) => ({ ...p, placement: "story" })),
      ];
      const posts = all.map((p) => ({
        ...p, post_metrics: undefined, post_attempts: undefined, metrics: one(p.post_metrics),
        history: [...((p.post_attempts ?? []) as any[])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      }))
        .sort((a, b) => String(a.platform).localeCompare(String(b.platform)) || (a.placement === "story" ? 1 : 0) - (b.placement === "story" ? 1 : 0));
      return { ...r, posts, options: creativeOptions(r) };
    }),
  });
}

// Remove um cliente de demonstracao (usado em testes e demonstracoes). Clientes reais nao sao apagados por aqui.
async function deleteClient(id: string) {
  const { data: c } = await db.from("clients").select("id, is_demo").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  if (!c.is_demo) throw new HttpError(409, "not_demo", "Só clientes de demonstração podem ser removidos pelo painel.");
  const { data: accs } = await db.from("social_accounts").select("id").eq("client_id", id);
  for (const a of accs ?? []) await db.rpc("ig_token_delete", { p_account_id: a.id });
  const { data: media } = await db.from("creatives").select("media_path, media").eq("client_id", id);
  const paths = (media ?? []).flatMap((m: any) => [m.media_path, ...((m.media ?? []) as any[]).map((x) => x?.path)])
    .filter((p: unknown): p is string => typeof p === "string" && p.startsWith(`${id}/`));
  must(await db.from("clients").delete().eq("id", id).eq("is_demo", true));
  if (paths.length) await db.storage.from(BUCKET).remove([...new Set(paths)]);
  return json({ ok: true });
}

// Conta simulada de um cliente de demonstracao: percorre o fluxo de publicacao sem chamar nenhuma rede.
async function simAccount(id: string, req: Request) {
  const b = await readJson(req);
  const platform = str(b.platform, 12) || "instagram";
  const mode = str(b.mode, 10) || "ok";
  if (!(PLATFORMS as readonly string[]).includes(platform)) throw new HttpError(400, "bad_platform", "Plataforma inválida.");
  if (!["ok", "falha", "spam", "remover"].includes(mode)) throw new HttpError(400, "bad_mode", "mode deve ser ok, falha, spam ou remover.");
  const { data: c } = await db.from("clients").select("id, is_demo").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  if (!c.is_demo) throw new HttpError(409, "not_demo", "Conta simulada só existe em cliente de demonstração.");
  const { data: cur } = await db.from("social_accounts").select("id, simulated").eq("client_id", id).eq("platform", platform).maybeSingle();
  if (cur && !cur.simulated) throw new HttpError(409, "real_account", "Este cliente já tem uma conta real conectada nesta rede.");
  if (mode === "remover") {
    if (cur) must(await db.from("social_accounts").delete().eq("id", cur.id).eq("simulated", true));
    return json({ ok: true });
  }
  const now = new Date().toISOString();
  const row = must(await db.from("social_accounts").upsert({
    client_id: id, platform, provider: platform === "tiktok" ? "uploadpost" : "meta", provider_ref: mode === "ok" ? null : mode,
    external_id: `sim_${id.slice(0, 8)}_${platform}`, username: "conta_simulada", name: "Conta simulada (demonstração)",
    simulated: true, status: "connected", last_error: null, cooldown_until: null, spam_strikes: 0, connected_at: now, updated_at: now,
  }, { onConflict: "client_id,platform" }).select("id").single()) as { id: string };
  await db.from("posts").update({ social_account_id: row.id }).eq("client_id", id).eq("platform", platform).in("status", ["scheduled", "failed"]);
  return json({ ok: true, mode });
}

// Uso do limite de publicacoes: o que a Meta informa para a conta e o ritmo proprio do Sr. Post.
async function publishingUsage(id: string) {
  const pace = await pacing();
  const out: Record<string, unknown> = { pacing: pace, networks: {} };
  const { data: accs } = await db.from("social_accounts").select("id, platform, provider, external_id, status, simulated, cooldown_until").eq("client_id", id);
  for (const a of accs ?? []) {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count } = await db.from("posts").select("id", { count: "exact", head: true })
      .eq("client_id", id).eq("platform", a.platform).eq("is_example", false).eq("status", "published").gte("published_at", since);
    const { data: next } = await db.rpc("account_next_allowed", { p_client_id: id, p_platform: a.platform });
    const info: Record<string, unknown> = { status: a.status, simulated: a.simulated, published_24h: count ?? 0, next_allowed_at: next, cooldown_until: a.cooldown_until, network_quota: null };
    if (a.platform === "instagram" && a.provider === "meta" && !a.simulated && a.status === "connected") {
      const { data: token } = await db.rpc("ig_token_read", { p_account_id: a.id });
      try { info.network_quota = token ? await publishingLimit(a.external_id, token as string) : null; }
      catch (e) { info.network_quota_error = e instanceof Error ? e.message : String(e); }
    }
    (out.networks as Record<string, unknown>)[a.platform] = info;
  }
  return json(out);
}

async function updateSettings(req: Request) {
  const b = await readJson(req);
  const rows: { key: string; value: string }[] = [];
  if ("publish_min_gap_minutes" in b) {
    const v = Number(b.publish_min_gap_minutes);
    if (!Number.isInteger(v) || v < 0 || v > 1440) throw new HttpError(400, "bad_gap", "O intervalo entre posts deve ficar entre 0 e 1.440 minutos.");
    rows.push({ key: "publish_min_gap_minutes", value: String(v) });
  }
  if ("publish_daily_cap" in b) {
    const v = Number(b.publish_daily_cap);
    if (!Number.isInteger(v) || v < 1 || v > 50) throw new HttpError(400, "bad_cap", "O teto diário deve ficar entre 1 e 50 publicações por conta.");
    rows.push({ key: "publish_daily_cap", value: String(v) });
  }
  if (!rows.length) throw new HttpError(400, "empty", "Nada para atualizar.");
  must(await db.from("settings").upsert(rows));
  return json({ ok: true, pacing: await pacing() });
}

async function createLink(id: string, req: Request) {
  const b = await readJson(req);
  const { data: c } = await db.from("clients").select("id").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  const days = typeof b.expires_days === "number" && b.expires_days > 0 ? Math.min(730, b.expires_days) : null;
  return json({ url: await newPortalLink(id, str(b.label, 80) || null, days) }, 201);
}

async function deleteCreative(id: string) {
  const { data: c } = await db.from("creatives").select("id, media_path, media, posts!posts_creative_id_fkey ( status )").eq("id", id).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Criativo não encontrado.");
  const own = (Array.isArray((c as any).posts) ? (c as any).posts : (c as any).posts ? [(c as any).posts] : []) as any[];
  // O story gerado na aprovacao some junto com o criativo: tambem nao pode estar publicado ou em publicacao.
  const { data: kids } = await db.from("creatives").select("posts!posts_creative_id_fkey ( status )").eq("story_of", id);
  const posts = [...own, ...(kids ?? []).flatMap((k: any) => (Array.isArray(k.posts) ? k.posts : k.posts ? [k.posts] : []))] as any[];
  if (posts.some((p) => p.status === "processing" || p.status === "published")) {
    throw new HttpError(409, "has_post", "Este criativo já foi publicado ou está em publicação.");
  }
  must(await db.from("creatives").delete().eq("id", id));
  const paths = [c.media_path, ...((c.media ?? []) as any[]).map((m) => m?.path)].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (paths.length) await db.storage.from(BUCKET).remove([...new Set(paths)]);
  return json({ ok: true });
}

// Busca locais (Paginas com endereco) para preencher o location_id. Usa o token da Pagina do cliente e,
// se a Meta recusar, o token do app. Sem os recursos de busca liberados no app, o ID e informado manualmente.
async function searchLocations(clientId: string, q: string) {
  if (q.length < 3) throw new HttpError(400, "short_query", "Digite ao menos 3 letras.");
  const attempts: string[] = [];
  const { data: acc } = await db.from("social_accounts").select("id").eq("client_id", clientId).eq("platform", "instagram").eq("status", "connected").maybeSingle();
  if (acc) {
    const { data: token } = await db.rpc("ig_token_read", { p_account_id: acc.id });
    if (token) attempts.push(token as string);
  }
  const appId = Deno.env.get("IG_APP_ID"), secret = Deno.env.get("IG_APP_SECRET");
  if (appId && secret) attempts.push(`${appId}|${secret}`);
  let last = "Conecte o Instagram do cliente para buscar locais.";
  for (const token of attempts) {
    try { return json({ places: await searchPlaces(q, token) }); }
    catch (e) { last = e instanceof IgError ? e.message : "Falha na busca."; }
  }
  throw new HttpError(502, "search_unavailable", `A Meta não liberou a busca de locais para este app: ${last} Informe o ID da Página do local manualmente.`);
}

async function updateCreative(id: string, req: Request) {
  const b = await readJson(req);
  const { data: cur } = await db.from("creatives")
    .select("id, status, kind, format, platforms, caption, hashtags, link_url, location_id, location_name, auto_music, opt_story, opt_caption, opt_location")
    .eq("id", id).is("story_of", null).maybeSingle();
  if (!cur) throw new HttpError(404, "not_found", "Criativo não encontrado.");
  if (cur.status !== "pending") throw new HttpError(409, "not_pending", "Só é possível editar criativos que ainda estão na fila.");
  const patch: Record<string, unknown> = {};
  if ("caption" in b) patch.caption = str(b.caption, 2200);
  if ("hashtags" in b) patch.hashtags = str(b.hashtags, 600);
  if ("title" in b) patch.title = str(b.title, 120) || null;
  if ("link" in b || "link_url" in b) {
    const link = str(b.link ?? b.link_url, 500);
    if (link && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(link)) throw new HttpError(400, "bad_link", "Link inválido (use um endereço completo, com https://).");
    patch.link_url = link || null;
  }
  if ("location_id" in b) {
    const loc = str(b.location_id, 40);
    if (loc && !/^\d+$/.test(loc)) throw new HttpError(400, "bad_location", "location_id deve ser o ID numérico da Página do local.");
    patch.location_id = loc || null;
    patch.location_name = loc ? (str(b.location_name, 120) || null) : null;
  }
  if ("suggested_at" in b) {
    const d = b.suggested_at ? new Date(String(b.suggested_at)) : null;
    if (d && isNaN(d.getTime())) throw new HttpError(400, "bad_date", "Data inválida.");
    patch.suggested_at = d ? d.toISOString() : null;
  }
  const next = { ...cur, ...patch };
  if (composeCaption(next as any).length > 2200) throw new HttpError(400, "caption_too_long", "Legenda + link + hashtags passam de 2.200 caracteres.");
  if (b.options && typeof b.options === "object") Object.assign(patch, optionColumns(normalizeOptions(next as any, b.options)));
  if (!Object.keys(patch).length) throw new HttpError(400, "empty", "Nada para atualizar.");
  const rows = must(await db.from("creatives").update(patch).eq("id", id).eq("status", "pending").select("id")) as unknown[];
  if (!rows?.length) throw new HttpError(409, "not_pending", "Só é possível editar criativos que ainda estão na fila.");
  return json({ ok: true, options: creativeOptions({ ...next, ...patch } as any) });
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
    status: "scheduled", attempts: 0, last_error: null, last_error_code: null, container_id: null, container_created_at: null,
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
  // Chave por cliente: so envia criativos para a fila daquele cliente.
  let clientId: string | null = null;
  if (b.client_id) {
    if (role !== "ingest" || !isUuid(b.client_id)) throw new HttpError(400, "bad_client", "Só chaves de ingestão podem ser presas a um cliente.");
    const { data: c } = await db.from("clients").select("id").eq("id", b.client_id).maybeSingle();
    if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
    clientId = c.id;
  }
  const key = `srp_${role === "admin" ? "adm" : clientId ? "cli" : "ing"}_${randomToken(30)}`;
  must(await db.from("api_keys").insert({ name, role, key_hash: await sha256Hex(key), client_id: clientId }));
  return json({ key, client_id: clientId }, 201);
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
    if (m === "DELETE" && seg.length === 2) return deleteClient(seg[1]);
    if (m === "POST" && seg[2] === "sim-account") return simAccount(seg[1], req);
    if (m === "GET" && seg[2] === "publishing") return publishingUsage(seg[1]);
    if (m === "POST" && seg[2] === "links") return createLink(seg[1], req);
    if (m === "GET" && seg[2] === "places") return searchLocations(seg[1], str(new URL(req.url).searchParams.get("q"), 80));
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
  if (m === "PATCH" && path === "/settings") return updateSettings(req);
  if (m === "GET" && path === "/keys") {
    return json({ keys: must(await db.from("api_keys").select("id, name, role, client_id, created_at, last_used_at, revoked_at").order("created_at")), current: me.id });
  }
  if (m === "POST" && path === "/keys") return createKey(req);
  if (m === "POST" && seg[0] === "keys" && isUuid(seg[1]) && seg[2] === "revoke") {
    if (seg[1] === me.id) throw new HttpError(409, "self_revoke", "Você não pode revogar a chave que está usando.");
    must(await db.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", seg[1]));
    return json({ ok: true });
  }
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}

// Ingestao por API: o agente de IA (ou o n8n) envia criativo, legenda, link e opcoes direto para a fila do cliente.
// Com chave por cliente (x-api-key), o cliente vem da propria chave; com chave geral, vem de client_slug.
export async function ingestRoutes(req: Request, path: string): Promise<Response> {
  const key = await authKey(req, ["ingest", "admin"]);
  const url = new URL(req.url);
  const b = req.method === "POST" ? await readJson(req) : {} as Record<string, unknown>;
  const slug = str(b.client_slug ?? url.searchParams.get("client_slug"), 60);
  let client: { id: string; slug: string; name: string } | null = null;
  if (key.client_id) {
    client = (await db.from("clients").select("id, slug, name").eq("id", key.client_id).maybeSingle()).data;
    if (!client) throw new HttpError(404, "client_not_found", "O cliente desta chave não existe mais.");
    if (slug && slug !== client.slug) throw new HttpError(403, "wrong_client", "Esta chave só envia criativos para o cliente dela.");
  } else {
    if (!slug) throw new HttpError(400, "client_required", "Informe client_slug ou use uma chave do cliente.");
    client = (await db.from("clients").select("id, slug, name").eq("slug", slug).maybeSingle()).data;
    if (!client) throw new HttpError(404, "client_not_found", `Cliente "${slug}" não encontrado.`);
  }
  const m = req.method;
  if (m === "POST" && path === "/upload-url") return json(await signedUpload(client.id, str(b.filename, 200), str(b.content_type, 60)));
  if (m === "POST" && path === "/creatives") {
    const res = await createCreatives(client.id, b.items, "api");
    return json({ client: client.slug, ...res }, 201);
  }
  // Situacao dos criativos enviados: decisao do cliente, pedido de ajuste e andamento de cada publicacao.
  if (m === "GET" && path === "/creatives") {
    const fields = `id, external_ref, kind, format, title, status, decision_comment, decided_at, suggested_at, link_url, opt_story, opt_caption, auto_music, opt_location, created_at,
      posts!posts_creative_id_fkey ( platform, status, scheduled_for, published_at, permalink, last_error, last_error_code )`;
    let q = db.from("creatives").select(fields).eq("client_id", client.id).is("story_of", null).order("created_at", { ascending: false }).limit(100);
    const ref = str(url.searchParams.get("external_ref"), 200), status = str(url.searchParams.get("status"), 12);
    if (ref) q = q.eq("external_ref", ref);
    if (status) q = q.eq("status", status);
    const rows = must(await q) ?? [];
    const { data: kids } = await db.from("creatives").select(`story_of, posts!posts_creative_id_fkey ( platform, status, scheduled_for, published_at, permalink, last_error, last_error_code )`)
      .eq("client_id", client.id).not("story_of", "is", null).in("story_of", rows.map((r: any) => r.id).slice(0, 100));
    const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as any[];
    const post = (p: any, placement: string) => ({
      platform: p.platform, placement, status: p.status, scheduled_for: p.scheduled_for, published_at: p.published_at, permalink: p.permalink,
      error: p.status === "published" ? null : friendlyError(p.last_error_code, p.last_error),
    });
    return json({
      client: client.slug,
      items: rows.map((r: any) => ({
        id: r.id, external_ref: r.external_ref, kind: r.kind, format: r.format, title: r.title, status: r.status,
        adjust_request: r.status === "adjust" ? r.decision_comment : null, decided_at: r.decided_at, suggested_at: r.suggested_at, link: r.link_url,
        options: { story: r.opt_story, caption: r.opt_caption, music: r.auto_music, location: r.opt_location },
        posts: [
          ...list(r.posts).map((p) => post(p, r.format === "story" ? "story" : "main")),
          ...(kids ?? []).filter((k: any) => k.story_of === r.id).flatMap((k: any) => list(k.posts).map((p) => post(p, "story"))),
        ],
      })),
    });
  }
  // Quem sou eu: confere a chave e mostra para onde os criativos vao.
  if (m === "GET" && path === "/me") {
    const [{ data: agent }, { data: accs }] = await Promise.all([
      db.from("agents").select("name, platforms, post_times, posts_per_week").eq("client_id", client.id).maybeSingle(),
      db.from("social_accounts").select("platform, username, status, simulated").eq("client_id", client.id),
    ]);
    return json({ client: { slug: client.slug, name: client.name }, key_scope: key.client_id ? "cliente" : "geral", agent, accounts: accs ?? [], pacing: await pacing() });
  }
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}
