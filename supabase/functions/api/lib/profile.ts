// Temas que o perfil ja tem: titulos dos criativos do cliente no Sr. Post e legendas ja publicadas no
// Instagram conectado (inclusive posts feitos fora do Sr. Post). O agente usa a lista para nao repetir tema.
import { db, getSetting } from "./core.ts";

const GRAPH = `https://graph.facebook.com/${Deno.env.get("IG_API_VERSION") ?? "v27.0"}`;
const CACHE_MS = 3 * 3_600_000;

// Primeira linha da legenda, sem hashtags: e o que identifica o tema.
const firstLine = (caption: string) => caption.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))?.slice(0, 140) ?? "";

async function instagramCaptions(clientId: string): Promise<string[]> {
  const { data: acc } = await db.from("social_accounts").select("id, external_id, provider, simulated, status")
    .eq("client_id", clientId).eq("platform", "instagram").maybeSingle();
  if (!acc || acc.simulated || acc.provider !== "meta" || acc.status !== "connected") return [];
  const { data: token } = await db.rpc("ig_token_read", { p_account_id: acc.id });
  if (!token) return [];
  const qs = new URLSearchParams({ fields: "caption,timestamp", limit: "40", access_token: token as string });
  const res = await fetch(`${GRAPH}/${acc.external_id}/media?${qs}`);
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  return ((body?.data ?? []) as { caption?: string }[]).map((m) => firstLine(m.caption ?? "")).filter(Boolean);
}

// Lista de temas existentes (mais recentes primeiro), com cache de 3 horas para as legendas do Instagram.
export async function existingThemes(clientId: string): Promise<string[]> {
  const { data: mine } = await db.from("creatives").select("title, caption, status").eq("client_id", clientId).is("story_of", null)
    .neq("status", "rejected").order("created_at", { ascending: false }).limit(60);
  const own = (mine ?? []).map((c: { title: string | null; caption: string | null }) => (c.title ?? "").trim() || firstLine(c.caption ?? "")).filter(Boolean);
  const key = `profile_themes:${clientId}`;
  let published: string[] = [];
  const cached = await getSetting(key);
  const parsed = cached ? JSON.parse(cached) as { at: number; items: string[] } : null;
  if (parsed && Date.now() - parsed.at < CACHE_MS) published = parsed.items;
  else {
    try {
      published = await instagramCaptions(clientId);
      await db.from("settings").upsert({ key, value: JSON.stringify({ at: Date.now(), items: published }) });
    } catch (_) { published = parsed?.items ?? []; }
  }
  return [...new Set([...own, ...published])].slice(0, 60);
}

// Comparacao simples de temas: palavras relevantes em comum. Serve para barrar repeticao evidente,
// nao para julgar semelhanca de sentido.
const STOP = new Set(["para", "como", "que", "com", "sem", "uma", "seu", "sua", "seus", "suas", "por", "dos", "das", "nos", "nas", "mais", "voce", "isso", "esse", "essa", "este", "esta", "sobre", "pelo", "pela", "quando", "onde", "qual", "quais"]);
const tokens = (s: string) => new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));

export function sameTheme(a: string, b: string): boolean {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  const small = Math.min(x.size, y.size);
  return common / (x.size + y.size - common) >= 0.6 || (small >= 3 && common / small >= 0.8);
}

export const repeated = (tema: string, existing: string[]) => existing.find((e) => sameTheme(tema, e)) ?? null;
