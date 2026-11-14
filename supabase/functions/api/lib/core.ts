// Base compartilhada: cliente do banco, respostas HTTP, hash e autenticacao.
import { createClient } from "npm:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1/api`;
export const BUCKET = "creatives";

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-portal-token,x-admin-key,x-api-key",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch (_) { /* cai no erro abaixo */ }
  throw new HttpError(400, "invalid_json", "Corpo da requisição inválido.");
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new HttpError(500, "db_error", res.error.message);
  return res.data as T;
}

export async function getSetting(key: string): Promise<string | null> {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function portalUrl(): Promise<string> {
  return (await getSetting("portal_url")) ?? "https://modestogrowthpartners.github.io/srpost/portal/";
}

export const igConfigured = () => Boolean(Deno.env.get("IG_APP_ID") && Deno.env.get("IG_APP_SECRET"));

export const PLATFORMS = ["instagram", "tiktok"] as const;
export type Platform = typeof PLATFORMS[number];

// Volta para o portal com o resultado de uma conexao (ex.: ?ig=ok, ?tt=erro&motivo=...).
export async function backToPortal(params: Record<string, string>): Promise<Response> {
  const url = new URL(await portalUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return redirect(url.toString());
}

export const str = (v: unknown, max = 5000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function publicUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------- Autenticacao ----------
export type ClientRow = {
  id: string; name: string; slug: string; segment: string | null; timezone: string; is_demo: boolean; status: string;
};

export async function authPortal(req: Request): Promise<ClientRow> {
  const token = req.headers.get("x-portal-token") ?? "";
  if (token.length < 20) throw new HttpError(401, "missing_token", "Link de acesso ausente.");
  const hash = await sha256Hex(token);
  const { data: link } = await db.from("portal_links")
    .select("id, client_id, expires_at, revoked_at, last_used_at")
    .eq("token_hash", hash).maybeSingle();
  if (!link || link.revoked_at || (link.expires_at && new Date(link.expires_at) < new Date())) {
    throw new HttpError(401, "invalid_token", "Este link de acesso não é mais válido. Peça um novo ao Sr. Post.");
  }
  const { data: client } = await db.from("clients")
    .select("id, name, slug, segment, timezone, is_demo, status").eq("id", link.client_id).maybeSingle();
  if (!client) throw new HttpError(401, "invalid_token", "Cliente não encontrado.");
  if (!link.last_used_at || Date.now() - new Date(link.last_used_at).getTime() > 5 * 60_000) {
    await db.from("portal_links").update({ last_used_at: new Date().toISOString() }).eq("id", link.id);
  }
  return client as ClientRow;
}

export async function authKey(req: Request, roles: string[]): Promise<{ id: string; role: string; name: string }> {
  const key = req.headers.get("x-admin-key") ?? req.headers.get("x-api-key") ?? "";
  if (key.length < 20) throw new HttpError(401, "missing_key", "Chave de acesso ausente.");
  const hash = await sha256Hex(key);
  const { data } = await db.from("api_keys").select("id, role, name, revoked_at, last_used_at")
    .eq("key_hash", hash).maybeSingle();
  if (!data || data.revoked_at || !roles.includes(data.role)) {
    throw new HttpError(401, "invalid_key", "Chave de acesso inválida.");
  }
  if (!data.last_used_at || Date.now() - new Date(data.last_used_at).getTime() > 5 * 60_000) {
    await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  }
  return { id: data.id, role: data.role, name: data.name };
}

// ---------- Criativos (usado pelo painel e pela ingestao) ----------
const VIDEO_EXT = /\.(mp4|mov)(\?|#|$)/i;
const MAX_CAROUSEL = 10;

function mediaRef(it: Record<string, unknown>, clientId: string, label: string) {
  const path = str(it.media_path, 500);
  if (path && !path.startsWith(`${clientId}/`)) throw new HttpError(400, "bad_path", `${label}: media_path não pertence a este cliente.`);
  const url = path ? publicUrl(path) : str(it.media_url, 2000);
  if (!/^https:\/\//i.test(url)) throw new HttpError(400, "bad_media", `${label}: informe media_path ou media_url (https).`);
  let kind = str(it.kind, 10);
  if (kind !== "video" && kind !== "image") kind = VIDEO_EXT.test(url) ? "video" : "image";
  const thumb = str(it.thumb_path, 500) ? publicUrl(str(it.thumb_path, 500)) : str(it.thumb_url, 2000);
  return { kind, url, path: path || null, thumb: thumb || null };
}

export async function createCreatives(clientId: string, rawItems: unknown, source: "upload" | "api") {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, "no_items", "Envie ao menos um criativo em items.");
  }
  if (rawItems.length > 50) throw new HttpError(400, "too_many", "Máximo de 50 criativos por chamada.");
  const { data: agent } = await db.from("agents").select("platforms").eq("client_id", clientId).maybeSingle();
  const defaults = ((agent?.platforms ?? []) as string[]).filter((p) => (PLATFORMS as readonly string[]).includes(p));
  const rows = [];
  const replaced: string[] = [];
  for (const [i, raw] of rawItems.entries()) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const label = `Item ${i + 1}`;
    // Carrossel: lista "media" com 2 a 10 itens. Midia unica: media_path ou media_url no proprio item.
    const list = Array.isArray(it.media) ? it.media as Record<string, unknown>[] : [];
    if (list.length === 1 || list.length > MAX_CAROUSEL) {
      throw new HttpError(400, "bad_carousel", `${label}: carrossel precisa de 2 a ${MAX_CAROUSEL} mídias.`);
    }
    const media = list.map((m, j) => mediaRef(m ?? {}, clientId, `${label}, mídia ${j + 1}`));
    const single = media.length ? null : mediaRef(it, clientId, label);
    const kind = media.length ? "carousel" : single!.kind;
    let format = str(it.format, 10) || (kind === "video" ? "reel" : "feed");
    if (!["reel", "feed", "story"].includes(format)) throw new HttpError(400, "bad_format", `${label}: format deve ser reel, feed ou story.`);
    if (kind === "carousel" && format !== "feed") throw new HttpError(400, "bad_format", `${label}: carrossel só vai para o feed.`);
    if (format === "reel" && kind !== "video") throw new HttpError(400, "bad_format", `${label}: Reel precisa ser vídeo.`);
    if (format === "feed" && kind === "video") format = "reel"; // video no feed e publicado como Reel pela API
    const caption = str(it.caption, 2200);
    const hashtags = str(it.hashtags, 600);
    if ((caption + "\n\n" + hashtags).length > 2200) {
      throw new HttpError(400, "caption_too_long", `${label}: legenda + hashtags passam de 2.200 caracteres.`);
    }
    if ((hashtags.match(/#/g) ?? []).length > 30) {
      throw new HttpError(400, "too_many_hashtags", `${label}: o Instagram aceita no máximo 30 hashtags.`);
    }
    let suggestedAt: string | null = null;
    if (it.suggested_at) {
      const d = new Date(String(it.suggested_at));
      if (isNaN(d.getTime())) throw new HttpError(400, "bad_date", `${label}: suggested_at inválido (use ISO 8601).`);
      suggestedAt = d.toISOString();
    }
    let platforms = (Array.isArray(it.platforms) ? it.platforms.map((p) => str(p, 12)) : defaults)
      .filter((p, idx, arr) => (PLATFORMS as readonly string[]).includes(p) && arr.indexOf(p) === idx);
    if (format === "story") platforms = platforms.filter((p) => p !== "tiktok"); // o TikTok nao tem stories
    if (!platforms.length) platforms = ["instagram"];
    const locationId = str(it.location_id, 40);
    if (locationId && !/^\d+$/.test(locationId)) throw new HttpError(400, "bad_location", `${label}: location_id deve ser o ID numérico da Página do local.`);
    const revisionOf = isUuid(it.revision_of) ? it.revision_of : null;
    if (revisionOf) replaced.push(revisionOf);
    const cover = media[0] ?? single!;
    rows.push({
      client_id: clientId, kind, format, media_url: cover.url, media_path: cover.path,
      thumb_url: cover.thumb, media,
      title: str(it.title, 120) || null, caption, hashtags, platforms,
      location_id: locationId || null, location_name: locationId ? (str(it.location_name, 120) || null) : null,
      audio_name: format === "reel" ? (str(it.audio_name, 80) || null) : null,
      auto_music: it.auto_music === true,
      ai_generated: it.ai_generated === true, suggested_at: suggestedAt, revision_of: revisionOf,
      source, external_ref: str(it.external_ref, 200) || null,
    });
  }
  const refs = rows.map((r) => r.external_ref).filter(Boolean) as string[];
  let skipped = 0;
  let toInsert = rows;
  if (refs.length) {
    const existing = must(await db.from("creatives").select("external_ref").eq("client_id", clientId).in("external_ref", refs));
    const seen = new Set((existing ?? []).map((e: { external_ref: string }) => e.external_ref));
    toInsert = rows.filter((r) => !r.external_ref || !seen.has(r.external_ref));
    skipped = rows.length - toInsert.length;
  }
  let created: unknown[] = [];
  if (toInsert.length) {
    created = must(await db.from("creatives").insert(toInsert).select("id, kind, format, media_url, platforms, status, external_ref"));
  }
  if (replaced.length) {
    await db.from("creatives").update({ status: "replaced" })
      .eq("client_id", clientId).in("id", replaced).in("status", ["adjust", "rejected"]);
  }
  return { created, skipped_duplicates: skipped };
}

export async function signedUpload(clientId: string, filename: string, contentType: string) {
  const allowed: Record<string, string> = {
    "video/mp4": "mp4", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  };
  const ext = allowed[contentType];
  if (!ext) throw new HttpError(400, "bad_type", "Tipo de arquivo não aceito. Use MP4, MOV, JPG, PNG ou WEBP.");
  const safe = filename.replace(/\.[^.]+$/, "").normalize("NFD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "midia";
  const path = `${clientId}/${crypto.randomUUID()}-${safe}.${ext}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(500, "upload_url_failed", error?.message ?? "Falha ao gerar URL de upload.");
  return { path, token: data.token, signed_url: data.signedUrl, public_url: publicUrl(path), content_type: contentType };
}
