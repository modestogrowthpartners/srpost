// Cliente do Upload-Post (provedor de publicacao). Usado para o TikTok, que so publica em publico
// por API quando o app passou pela auditoria do TikTok: o provedor ja e auditado.
// Referencia: docs.upload-post.com
const BASE = "https://api.upload-post.com";
const apiKey = () => Deno.env.get("UPLOAD_POST_API_KEY") ?? "";

export const uploadPostConfigured = () => apiKey().length > 10;

export class UploadPostError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function call(method: string, path: string, body?: Record<string, unknown> | FormData) {
  const headers: Record<string, string> = { authorization: `Apikey ${apiKey()}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch (_) { /* resposta nao JSON */ }
  if (!res.ok || data?.success === false) {
    throw new UploadPostError(String(data?.message ?? data?.error ?? text.slice(0, 300) ?? `HTTP ${res.status}`), res.status, data?.code ?? data?.error_code);
  }
  return data;
}

// Um perfil por cliente do Sr. Post. O nome e estavel e nao expoe dados do cliente.
export const profileName = (clientId: string) => `srp_${clientId.replace(/-/g, "")}`;

export async function ensureProfile(username: string, displayName: string) {
  try {
    await call("POST", "/api/uploadposts/users", { username, display_name: displayName.slice(0, 100) });
  } catch (e) {
    if (e instanceof UploadPostError && e.status === 409) return; // ja existe
    throw e;
  }
}

export async function startConnect(platform: string, profile: string, redirectUrl: string): Promise<string> {
  const r = await call("POST", `/api/uploadposts/oauth/${platform}/start`, { profile, redirect_url: redirectUrl });
  if (!r?.authorize_url) throw new UploadPostError("Resposta sem authorize_url.", 500);
  return String(r.authorize_url);
}

export type ProviderAccount = { handle: string | null; displayName: string | null; image: string | null; reauthRequired: boolean };

// Conta conectada de uma plataforma dentro do perfil; null quando nao ha conexao.
export async function connectedAccount(profile: string, platform: string): Promise<ProviderAccount | null> {
  const r = await call("GET", "/api/uploadposts/users");
  const p = (r?.profiles ?? []).find((x: any) => x?.username === profile);
  const acc = p?.social_accounts?.[platform];
  if (!acc || typeof acc !== "object") return null; // "" ou null = nao conectado
  const img = acc.social_images;
  return {
    handle: acc.handle ? String(acc.handle).replace(/^@/, "") : (acc.username ? String(acc.username) : null),
    displayName: acc.display_name ? String(acc.display_name) : null,
    image: typeof img === "string" ? img : (img && typeof img === "object" ? String(Object.values(img)[0] ?? "") || null : null),
    reauthRequired: acc.reauth_required === true,
  };
}

export async function disconnect(profile: string, platform: string) {
  await call("DELETE", "/api/uploadposts/users/social", { profile_username: profile, social_platform: platform });
}

export type UploadInput = {
  profile: string; platform: string; kind: "video" | "image" | "carousel"; urls: string[];
  title: string; caption: string; aiGenerated: boolean; autoMusic: boolean;
};

// Envia em segundo plano e devolve o request_id para acompanhar.
export async function upload(input: UploadInput): Promise<string> {
  const form = new FormData();
  form.append("user", input.profile);
  form.append("platform[]", input.platform);
  form.append("async_upload", "true");
  form.append("privacy_level", "PUBLIC_TO_EVERYONE");
  let path = "/api/upload";
  if (input.kind === "video") {
    form.append("video", input.urls[0]);
    form.append("title", input.caption.slice(0, 2200) || input.title);
    if (input.aiGenerated) form.append("is_aigc", "true");
  } else {
    path = "/api/upload_photos";
    for (const u of input.urls) form.append("photos[]", u);
    form.append("title", (input.title || input.caption).slice(0, 90));
    form.append("tiktok_description", input.caption.slice(0, 4000));
    if (input.autoMusic) form.append("auto_add_music", "true");
  }
  const r = await call("POST", path, form);
  if (!r?.request_id) throw new UploadPostError("O provedor não devolveu um request_id.", 500);
  return String(r.request_id);
}

export type UploadState =
  | { state: "pending" }
  | { state: "published"; postId: string | null; url: string | null }
  | { state: "failed"; error: string };

const DONE = ["completed"];
const FAILED = ["failed", "not_found"];

export async function uploadStatus(requestId: string, platform: string): Promise<UploadState> {
  let r: any;
  try {
    r = await call("GET", `/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`);
  } catch (e) {
    if (e instanceof UploadPostError && e.status === 404) return { state: "failed", error: "O provedor não encontrou o envio." };
    throw e;
  }
  const top = String(r?.status ?? "");
  const entry = (r?.results ?? []).find((x: any) => x?.platform === platform);
  const entryStatus = String(entry?.status ?? "");
  if (FAILED.includes(top) || entryStatus === "failed") {
    return { state: "failed", error: String(entry?.error_message ?? entry?.message ?? r?.message ?? "Falha no provedor.") };
  }
  if (!DONE.includes(top) && entryStatus !== "completed") return { state: "pending" };
  if (!entry || entry.success !== true) {
    return { state: "failed", error: String(entry?.error_message ?? entry?.message ?? "O TikTok recusou o post.") };
  }
  const url = [entry.post_url, entry.url].find((u) => typeof u === "string" && /^https?:\/\//.test(u)) ?? null;
  return { state: "published", postId: entry.platform_post_id ? String(entry.platform_post_id) : null, url };
}

// Metricas do post. O TikTok so libera depois que o post e publico e passou pela moderacao.
export async function postMetrics(requestId: string, platform: string): Promise<Record<string, number>> {
  const r = await call("GET", `/api/uploadposts/post-analytics/${encodeURIComponent(requestId)}?platform=${platform}`);
  const block = r?.platforms?.[platform] ?? r?.[platform] ?? r;
  const m = block?.post_metrics ?? {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) if (typeof v === "number") out[k] = v;
  return out;
}
