// Sr. Post: funcao de renderizacao. Fica separada da API para ter o proprio limite de processamento.
//   { spec, client_id }      arte por template (JPEG 4:5 ou 9:16)
//   { fit: { url }, client_id }  story em 9:16 a partir de uma imagem do proprio armazenamento
// Quem chama e o motor dos agentes e o publicador (x-worker-secret) ou o painel do time (x-admin-key).
import { createClient } from "npm:@supabase/supabase-js@2";
import { initWasm } from "npm:@resvg/resvg-wasm@2.6.2";
import { FontData, renderJpeg, Spec } from "./art.ts";
import { fitStory } from "./fit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = "creatives";
const WASM_URLS = [
  "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm",
  "https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm",
];
const FONTS: { key: string; name: string; weight: 400 | 500 | 700 | 900; file: string }[] = [
  { key: "inter-400", name: "Inter", weight: 400, file: "inter@latest/latin-400-normal.ttf" },
  { key: "inter-700", name: "Inter", weight: 700, file: "inter@latest/latin-700-normal.ttf" },
  { key: "inter-900", name: "Inter", weight: 900, file: "inter@latest/latin-900-normal.ttf" },
  { key: "mono-500", name: "Mono", weight: 500, file: "jetbrains-mono@latest/latin-500-normal.ttf" },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf); let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
function fromBase64(text: string): ArrayBuffer {
  const bin = atob(text); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// O modulo de raster e as fontes carregam uma vez por instancia. As fontes ficam guardadas no banco
// depois do primeiro download, para o inicio a frio nao depender de rede externa.
let wasmReady: Promise<void> | null = null;
let fontsReady: Promise<FontData[]> | null = null;

async function loadWasm(): Promise<void> {
  let last: unknown = null;
  for (const url of WASM_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await initWasm(await res.arrayBuffer());
      return;
    } catch (e) { last = e; }
  }
  throw new Error(`Não foi possível carregar o módulo de renderização: ${last instanceof Error ? last.message : last}`);
}

async function loadFonts(): Promise<FontData[]> {
  const { data } = await db.from("assets").select("key, content").in("key", FONTS.map((f) => `font:${f.key}`));
  const cached = new Map((data ?? []).map((r: { key: string; content: string }) => [r.key, r.content]));
  return await Promise.all(FONTS.map(async (f) => {
    const hit = cached.get(`font:${f.key}`);
    if (hit) return { name: f.name, weight: f.weight, style: "normal" as const, data: fromBase64(hit) };
    const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${f.file}`);
    if (!res.ok) throw new Error(`Não foi possível baixar a fonte ${f.key} (HTTP ${res.status}).`);
    const buf = await res.arrayBuffer();
    await db.from("assets").upsert({ key: `font:${f.key}`, content: toBase64(buf), updated_at: new Date().toISOString() });
    return { name: f.name, weight: f.weight, style: "normal" as const, data: buf };
  }));
}

async function assets(): Promise<FontData[]> {
  wasmReady ??= loadWasm().catch((e) => { wasmReady = null; throw e; });
  fontsReady ??= loadFonts().catch((e) => { fontsReady = null; throw e; });
  const [, fonts] = await Promise.all([wasmReady, fontsReady]);
  return fonts;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let secretCache: { value: string; at: number } | null = null;
async function authorized(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-worker-secret") ?? "";
  if (secret.length >= 20) {
    if (!secretCache || Date.now() - secretCache.at > 60_000) {
      const { data } = await db.from("settings").select("value").eq("key", "worker_secret").maybeSingle();
      secretCache = { value: data?.value ?? "", at: Date.now() };
    }
    if (secretCache.value && secret === secretCache.value) return true;
  }
  const key = req.headers.get("x-admin-key") ?? "";
  if (key.length < 20) return false;
  const { data } = await db.from("api_keys").select("role, revoked_at").eq("key_hash", await sha256Hex(key)).maybeSingle();
  return Boolean(data && !data.revoked_at && data.role === "admin");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Story em 9:16. So aceita imagem do proprio armazenamento, na pasta do cliente: nunca busca endereco externo.
async function fitRoute(url: string, clientId: string, store: boolean): Promise<Response> {
  if (!UUID.test(clientId)) return json({ error: "bad_client", message: "client_id inválido." }, 400);
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${clientId}/`;
  if (!url.startsWith(prefix) || url.includes("..")) return json({ error: "bad_url", message: "A imagem precisa estar no armazenamento do Sr. Post, na pasta do cliente." }, 400);
  const t0 = performance.now();
  wasmReady ??= loadWasm().catch((e) => { wasmReady = null; throw e; });
  await wasmReady;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return json({ error: "source_failed", message: `Não foi possível baixar a imagem (HTTP ${res.status}).` }, 502);
  if (Number(res.headers.get("content-length") ?? 0) > 20 * 1024 * 1024) { await res.body?.cancel(); return json({ error: "too_big", message: "A imagem passa de 20 MB." }, 400); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  let r;
  try { r = fitStory(bytes); }
  catch (e) { return json({ error: "fit_failed", message: e instanceof Error ? e.message : "Falha ao ajustar o story." }, 422); }
  if (!r.fitted) return json({ ok: true, fitted: false, message: r.reason });
  const info = { fitted: true, bytes: r.jpeg.length, width: 1080, height: 1920, band: r.band, ms: { ...r.ms, total: Math.round(performance.now() - t0) } };
  if (!store) return json({ ok: true, ...info });
  const path = `${clientId}/${crypto.randomUUID()}-story.jpg`;
  const { error } = await db.storage.from(BUCKET).upload(path, r.jpeg, { contentType: "image/jpeg" });
  if (error) return json({ error: "upload_failed", message: `Falha ao guardar o story: ${error.message}` }, 500);
  return json({ ok: true, path, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, ...info });
}
let warm = false;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized", message: "Chamada não autorizada." }, 401);
    const body = await req.json().catch(() => null) as { spec?: Spec; client_id?: string; store?: boolean; fit?: { url?: string } } | null;
    if (body?.fit) return await fitRoute(body.fit.url ?? "", body.client_id ?? "", body.store !== false);
    const spec = body?.spec;
    if (!spec || typeof spec.titulo !== "string" || !spec.titulo.trim()) return json({ error: "bad_spec", message: "Informe spec.titulo." }, 400);
    if (!["capa", "conteudo", "cta"].includes(spec.layout)) return json({ error: "bad_spec", message: "spec.layout deve ser capa, conteudo ou cta." }, 400);
    if (!["4:5", "9:16"].includes(spec.size)) return json({ error: "bad_spec", message: "spec.size deve ser 4:5 ou 9:16." }, 400);
    const t0 = performance.now();
    const cold = !warm;
    const fonts = await assets();
    const loaded = performance.now();
    const r = await renderJpeg(spec, fonts);
    warm = true;
    const info = { bytes: r.jpeg.length, width: r.width, height: r.height, cold, ms: { ...r.ms, carga: Math.round(loaded - t0), total: Math.round(performance.now() - t0) } };
    // Teste do painel: renderiza e mede, sem guardar arquivo.
    if (body?.store === false) return json({ ok: true, ...info });
    if (!UUID.test(body?.client_id ?? "")) return json({ error: "bad_client", message: "client_id inválido." }, 400);
    const path = `${body!.client_id}/${crypto.randomUUID()}-arte.jpg`;
    const { error } = await db.storage.from(BUCKET).upload(path, r.jpeg, { contentType: "image/jpeg" });
    if (error) return json({ error: "upload_failed", message: `Falha ao guardar a arte: ${error.message}` }, 500);
    return json({ ok: true, path, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, ...info });
  } catch (e) {
    console.error("render", e);
    return json({ error: "render_failed", message: e instanceof Error ? e.message : "Falha ao renderizar a arte." }, 500);
  }
});
