// Instagram API com Facebook Login for Business (graph.facebook.com).
// O cliente entra pelo Facebook, concede acesso a Pagina vinculada ao Instagram profissional e
// usamos o token da Pagina para publicar e ler metricas.
// Referencia: developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
const VERSION = Deno.env.get("IG_API_VERSION") ?? "v27.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;

// Permissoes que a configuracao de login (config_id) precisa conceder.
export const REQUIRED_PERMISSIONS = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"];
export const OPTIONAL_PERMISSIONS = ["instagram_manage_insights"];

export class IgError extends Error {
  constructor(message: string, public status: number, public code?: number, public subcode?: number) {
    super(message);
  }
  get tokenInvalid() { return this.code === 190; }
}

async function parse(res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch (_) { /* resposta nao JSON */ }
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    const msg = e.error_user_msg || e.message || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new IgError(String(msg), res.status, e.code, e.error_subcode);
  }
  return body;
}

async function get(path: string, params: Record<string, string>, token: string) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  return parse(await fetch(`${GRAPH}${path}?${qs}`));
}

async function post(path: string, params: Record<string, string>, token: string) {
  const body = new URLSearchParams({ ...params, access_token: token });
  return parse(await fetch(`${GRAPH}${path}`, { method: "POST", body }));
}

export function authorizeUrl(appId: string, configId: string, redirectUri: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: appId, redirect_uri: redirectUri, config_id: configId,
    response_type: "code", override_default_response_type: "true", state,
  });
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${qs}`;
}

// Troca o code por um token e tenta estende-lo. `durable` indica que os tokens de Pagina derivados nao expiram:
// vale para token de usuario de longa duracao e para token de usuario de sistema (que ja nasce sem validade).
export async function exchangeCode(appId: string, secret: string, redirectUri: string, code: string) {
  const qs = new URLSearchParams({ client_id: appId, client_secret: secret, redirect_uri: redirectUri, code });
  const first = await parse(await fetch(`${GRAPH}/oauth/access_token?${qs}`));
  if (!first?.access_token) throw new IgError("Resposta sem access_token.", 500);
  let token = String(first.access_token);
  let expiresIn: number | null = typeof first.expires_in === "number" ? first.expires_in : null;
  let durable = expiresIn === null;
  try {
    const r = await extendToken(appId, secret, token);
    token = r.token; expiresIn = r.expiresIn; durable = true;
  } catch (_) { /* token de usuario de sistema nao passa por esta troca */ }
  return { token, expiresIn, durable };
}

export async function extendToken(appId: string, secret: string, token: string) {
  const qs = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: token });
  const r = await parse(await fetch(`${GRAPH}/oauth/access_token?${qs}`));
  if (!r?.access_token) throw new IgError("Resposta sem access_token.", 500);
  return { token: String(r.access_token), expiresIn: typeof r.expires_in === "number" ? r.expires_in as number : null };
}

// Permissoes concedidas; null quando o tipo de token nao permite consultar.
export async function grantedPermissions(token: string): Promise<string[] | null> {
  try {
    const r = await get("/me/permissions", {}, token);
    return (r?.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
  } catch (_) { return null; }
}

export async function fbUserId(token: string): Promise<string | null> {
  try { return String((await get("/me", { fields: "id" }, token)).id); } catch (_) { return null; }
}

export type IgAccount = {
  igId: string; username: string | null; name: string | null; picture: string | null; followers: number | null;
  pageId: string | null; pageName: string | null; pageToken: string | null;
};

const IG_FIELDS = "id,username,name,profile_picture_url,followers_count";

function fromIgNode(ig: any, page?: any): IgAccount {
  return {
    igId: String(ig.id), username: ig.username ?? null, name: ig.name ?? null, picture: ig.profile_picture_url ?? null,
    followers: typeof ig.followers_count === "number" ? ig.followers_count : null,
    pageId: page?.id ? String(page.id) : null, pageName: page?.name ?? null, pageToken: page?.access_token ?? null,
  };
}

// Contas profissionais do Instagram que a pessoa ou a empresa liberou no login. Tenta, nesta ordem:
//   1. me/accounts                       token de usuario: Paginas com Instagram vinculado
//   2. me/assigned_pages                 token de usuario de sistema: Paginas atribuidas
//   3. me/assigned_instagram_accounts    token de usuario de sistema: contas do Instagram atribuidas, com ou sem Pagina
//   4. <portfolio>/instagram_business_accounts   contas do portfolio empresarial do cliente
// `trace` registra o que cada consulta devolveu, para diagnostico no painel.
export async function listInstagramAccounts(token: string): Promise<{ accounts: IgAccount[]; trace: string }> {
  const found = new Map<string, IgAccount>();
  const trace: string[] = [];
  const add = (a: IgAccount) => {
    const cur = found.get(a.igId);
    if (!cur || (!cur.pageToken && a.pageToken)) found.set(a.igId, { ...cur, ...a, username: a.username ?? cur?.username ?? null });
  };
  const step = async (label: string, fn: () => Promise<number>) => {
    try { trace.push(`${label}: ${await fn()}`); }
    catch (e) { trace.push(`${label}: erro (${e instanceof Error ? e.message.slice(0, 90) : e})`); }
  };
  const pageFields = `id,name,access_token,instagram_business_account{${IG_FIELDS}}`;
  const pages = (edge: string) => async () => {
    const r = await get(edge, { fields: pageFields, limit: "100" }, token);
    let n = 0;
    for (const p of r?.data ?? []) if (p.instagram_business_account?.id) { add(fromIgNode(p.instagram_business_account, p)); n++; }
    return n;
  };
  const igEdge = (edge: string) => async () => {
    let r: any;
    try { r = await get(edge, { fields: IG_FIELDS, limit: "100" }, token); }
    catch (_) { r = await get(edge, { fields: "id,username", limit: "100" }, token); }
    let n = 0;
    for (const ig of r?.data ?? []) if (ig?.id) { add(fromIgNode(ig)); n++; }
    return n;
  };
  await step("me/accounts", pages("/me/accounts"));
  await step("me/assigned_pages", pages("/me/assigned_pages"));
  await step("me/assigned_instagram_accounts", igEdge("/me/assigned_instagram_accounts"));
  if (!found.size) {
    await step("portfolio/instagram_business_accounts", async () => {
      const me = await get("/me", { fields: "client_business_id" }, token);
      if (!me?.client_business_id) return 0;
      return igEdge(`/${me.client_business_id}/instagram_business_accounts`)();
    });
  }
  return { accounts: [...found.values()], trace: trace.join("; ") };
}

export function profile(igUserId: string, token: string) {
  return get(`/${igUserId}`, { fields: "username,name,profile_picture_url,followers_count" }, token);
}

export type MediaItem = { kind: "video" | "image"; url: string };
export type PublishInput = {
  kind: "video" | "image" | "carousel"; format: "reel" | "feed" | "story";
  mediaUrl: string; items: MediaItem[]; caption: string; aiGenerated: boolean;
  locationId?: string | null; audioName?: string | null;
};

export async function createContainer(igUserId: string, token: string, p: PublishInput): Promise<string> {
  if (p.kind === "carousel") return createCarousel(igUserId, token, p);
  const params: Record<string, string> = {};
  if (p.format === "story") {
    params.media_type = "STORIES";
    params[p.kind === "video" ? "video_url" : "image_url"] = p.mediaUrl;
  } else if (p.kind === "video") {
    params.media_type = "REELS";
    params.video_url = p.mediaUrl;
    params.share_to_feed = "true";
    params.caption = p.caption;
    // A API so renomeia o audio original do Reel; nao seleciona musica da biblioteca do Instagram.
    if (p.audioName) params.audio_name = p.audioName;
  } else {
    params.image_url = p.mediaUrl;
    params.caption = p.caption;
  }
  if (p.locationId && p.format !== "story") params.location_id = p.locationId;
  if (p.aiGenerated) params.is_ai_generated = "true";
  const r = await post(`/${igUserId}/media`, params, token);
  return String(r.id);
}

// Carrossel: um container por item (is_carousel_item) e depois o container pai com a lista de filhos.
async function createCarousel(igUserId: string, token: string, p: PublishInput): Promise<string> {
  const ids: string[] = [];
  for (const it of p.items) {
    const params: Record<string, string> = { is_carousel_item: "true" };
    if (it.kind === "video") { params.media_type = "VIDEO"; params.video_url = it.url; } else params.image_url = it.url;
    ids.push(String((await post(`/${igUserId}/media`, params, token)).id));
  }
  // Videos sao processados de forma assincrona: espera os itens de video ficarem prontos antes de montar o pai.
  const deadline = Date.now() + 45_000;
  for (const [i, id] of ids.entries()) {
    if (p.items[i].kind !== "video") continue;
    for (;;) {
      const st = await containerStatus(id, token);
      if (st.code === "FINISHED") break;
      if (st.code === "ERROR" || st.code === "EXPIRED") throw new IgError(`Item ${i + 1} do carrossel foi recusado: ${st.detail || st.code}`, 400);
      if (Date.now() > deadline) throw new IgError("Os vídeos do carrossel ainda estão em processamento. Nova tentativa em instantes.", 503);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const params: Record<string, string> = { media_type: "CAROUSEL", children: ids.join(","), caption: p.caption };
  if (p.locationId) params.location_id = p.locationId;
  const r = await post(`/${igUserId}/media`, params, token);
  return String(r.id);
}

// Busca Paginas com dados de local para usar como location_id. Depende do tipo de token e dos recursos do app.
export async function searchPlaces(q: string, token: string) {
  const r = await get("/pages/search", { q, fields: "id,name,location,link" }, token);
  return (r?.data ?? []).filter((p: any) => p.location).slice(0, 15).map((p: any) => ({
    id: String(p.id), name: String(p.name ?? ""),
    address: [p.location?.street, p.location?.city, p.location?.state].filter(Boolean).join(", "),
  }));
}

export async function containerStatus(containerId: string, token: string): Promise<{ code: string; detail: string }> {
  const r = await get(`/${containerId}`, { fields: "status_code,status" }, token);
  return { code: String(r.status_code ?? ""), detail: String(r.status ?? "") };
}

export async function publishContainer(igUserId: string, token: string, containerId: string): Promise<string> {
  const r = await post(`/${igUserId}/media_publish`, { creation_id: containerId }, token);
  return String(r.id);
}

export async function mediaInfo(mediaId: string, token: string) {
  return get(`/${mediaId}`, { fields: "permalink,media_product_type,timestamp" }, token);
}

const METRICS: Record<string, string[]> = {
  reel: ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions", "ig_reels_avg_watch_time"],
  feed: ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"],
  story: ["views", "reach", "shares", "total_interactions"],
};

export async function mediaInsights(mediaId: string, token: string, format: string) {
  const wanted = METRICS[format] ?? METRICS.feed;
  let r: any;
  try {
    r = await get(`/${mediaId}/insights`, { metric: wanted.join(",") }, token);
  } catch (e) {
    if (e instanceof IgError && e.tokenInvalid) throw e;
    r = await get(`/${mediaId}/insights`, { metric: "reach,total_interactions" }, token);
  }
  const out: Record<string, number> = {};
  for (const m of r?.data ?? []) {
    const v = m?.total_value?.value ?? m?.values?.[0]?.value;
    if (typeof v === "number") out[m.name] = v;
  }
  return out;
}

// signed_request da Meta (desautorizacao e exclusao de dados): "<assinatura>.<payload>" em base64url.
export async function parseSignedRequest(signed: string, secret: string): Promise<Record<string, unknown> | null> {
  const [sig, payload] = signed.split(".");
  if (!sig || !payload) return null;
  const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, b64(sig), new TextEncoder().encode(payload));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64(payload))); } catch (_) { return null; }
}
