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
  pageId: string; pageName: string | null; pageToken: string | null;
};

// Contas profissionais do Instagram ligadas as Paginas que a pessoa liberou no login.
export async function listInstagramAccounts(token: string): Promise<IgAccount[]> {
  const r = await get("/me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url,followers_count}",
    limit: "100",
  }, token);
  const out: IgAccount[] = [];
  for (const p of r?.data ?? []) {
    const ig = p.instagram_business_account;
    if (!ig?.id) continue;
    out.push({
      igId: String(ig.id), username: ig.username ?? null, name: ig.name ?? null, picture: ig.profile_picture_url ?? null,
      followers: typeof ig.followers_count === "number" ? ig.followers_count : null,
      pageId: String(p.id), pageName: p.name ?? null, pageToken: p.access_token ?? null,
    });
  }
  return out;
}

export function profile(igUserId: string, token: string) {
  return get(`/${igUserId}`, { fields: "username,name,profile_picture_url,followers_count" }, token);
}

export type PublishInput = {
  kind: "video" | "image"; format: "reel" | "feed" | "story";
  mediaUrl: string; caption: string; aiGenerated: boolean;
};

export async function createContainer(igUserId: string, token: string, p: PublishInput): Promise<string> {
  const params: Record<string, string> = {};
  if (p.format === "story") {
    params.media_type = "STORIES";
    params[p.kind === "video" ? "video_url" : "image_url"] = p.mediaUrl;
  } else if (p.kind === "video") {
    params.media_type = "REELS";
    params.video_url = p.mediaUrl;
    params.share_to_feed = "true";
    params.caption = p.caption;
  } else {
    params.image_url = p.mediaUrl;
    params.caption = p.caption;
  }
  if (p.aiGenerated) params.is_ai_generated = "true";
  const r = await post(`/${igUserId}/media`, params, token);
  return String(r.id);
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
