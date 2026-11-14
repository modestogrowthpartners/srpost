// Cliente da Instagram API com Instagram Login (graph.instagram.com).
// Referencia: developers.facebook.com/docs/instagram-platform
const VERSION = Deno.env.get("IG_API_VERSION") ?? "v27.0";
const GRAPH = `https://graph.instagram.com/${VERSION}`;

export const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];

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
  if (!res.ok || body?.error || body?.error_type) {
    const e = body?.error ?? {};
    const msg = e.error_user_msg || e.message || body?.error_message || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new IgError(String(msg), res.status, e.code ?? body?.code, e.error_subcode);
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

export function authorizeUrl(appId: string, redirectUri: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: appId, redirect_uri: redirectUri, response_type: "code",
    scope: IG_SCOPES.join(","), state, force_reauth: "true",
  });
  return `https://www.instagram.com/oauth/authorize?${qs}`;
}

export async function exchangeCode(appId: string, secret: string, redirectUri: string, code: string) {
  const body = new URLSearchParams({
    client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: redirectUri, code,
  });
  const short = await parse(await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body }));
  const s = Array.isArray(short?.data) ? short.data[0] : short;
  if (!s?.access_token) throw new IgError("Resposta sem access_token.", 500);
  const qs = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: secret, access_token: s.access_token });
  const long = await parse(await fetch(`https://graph.instagram.com/access_token?${qs}`));
  const perms: string[] = Array.isArray(s.permissions) ? s.permissions : String(s.permissions ?? "").split(",").filter(Boolean);
  return { token: long.access_token as string, expiresIn: Number(long.expires_in ?? 5184000), permissions: perms };
}

export async function refreshToken(token: string) {
  const qs = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
  const r = await parse(await fetch(`https://graph.instagram.com/refresh_access_token?${qs}`));
  return { token: r.access_token as string, expiresIn: Number(r.expires_in ?? 5184000) };
}

export function me(token: string) {
  return get("/me", { fields: "user_id,username,name,account_type,profile_picture_url,followers_count" }, token);
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
