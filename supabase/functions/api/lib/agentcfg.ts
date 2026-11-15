// Configuracao do agente e criacao de cliente: usados pelo painel (api) e pela central de agentes (agents).
// Fica em arquivo proprio para a central nao precisar carregar o painel inteiro.
import { db, HttpError, must, PLATFORMS, portalUrl, randomToken, sha256Hex, str } from "./core.ts";

// Campos do agente lidos pelo motor, pela central e pelo chat.
export const AGENT_FIELDS = "id, client_id, name, role_line, bio, tone, pillars, posts_per_week, post_times, platforms, status, context, audience, formats, voice, brand, default_link, approval_mode, automation, text_provider, media_provider, story_default, ai_label, lead_hours, config_version, last_run_at, updated_at";

export function slugify(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

const FORMATS = ["reel", "carrossel", "imagem", "story"];
const VOICE_KEYS = ["usa", "evita", "cta", "provas", "proibido", "emoji"];

// Configuracao do agente aceita pelo painel. Listas de valores sao validadas aqui (o banco nao tem check para elas).
export function agentPatch(a: Record<string, unknown> | undefined) {
  if (!a || typeof a !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of ["name", "role_line", "bio", "tone"]) if (k in a) out[k] = str(a[k], 600) || null;
  if ("context" in a) out.context = str(a.context, 4000) || null;
  if ("audience" in a) out.audience = str(a.audience, 600) || null;
  if (Array.isArray(a.formats)) {
    const list = a.formats.map((f) => str(f, 12)).filter((f, i, arr) => FORMATS.includes(f) && arr.indexOf(f) === i);
    if (list.length) out.formats = list;
  }
  if (a.voice && typeof a.voice === "object" && !Array.isArray(a.voice)) {
    const v: Record<string, string> = {};
    for (const k of VOICE_KEYS) { const t = str((a.voice as Record<string, unknown>)[k], 600); if (t) v[k] = t; }
    out.voice = v;
  }
  if ("default_link" in a) {
    const link = str(a.default_link, 500);
    if (link && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(link)) throw new HttpError(400, "bad_link", "Link padrão inválido (use um endereço completo, com https://).");
    out.default_link = link || null;
  }
  const pick = (k: string, allowed: string[], label: string) => {
    if (!(k in a)) return;
    const v = str(a[k], 20);
    if (!allowed.includes(v)) throw new HttpError(400, "bad_" + k, `${label} deve ser: ${allowed.join(", ")}.`);
    out[k] = v;
  };
  pick("approval_mode", ["cliente", "automatica"], "Modo de aprovação");
  pick("automation", ["ligada", "pausada"], "Automação");
  pick("text_provider", ["claude", "banco", "simulado"], "Fornecedor de texto");
  pick("media_provider", ["template", "manual", "higgsfield", "simulado"], "Fornecedor de mídia");
  // Identidade visual da arte por template: tema pronto ou cores proprias, e a assinatura que aparece na arte.
  if (a.brand && typeof a.brand === "object" && !Array.isArray(a.brand)) {
    const src = a.brand as Record<string, unknown>, b: Record<string, string> = {};
    const tema = str(src.tema, 12);
    if (tema) {
      if (!["noite", "claro", "areia", "grafite", "marca"].includes(tema)) throw new HttpError(400, "bad_brand", "Tema da arte deve ser: noite, claro, areia, grafite ou marca.");
      b.tema = tema;
    }
    for (const k of ["fundo", "texto", "destaque"]) {
      const v = str(src[k], 7);
      if (v && !/^#[0-9a-f]{6}$/i.test(v)) throw new HttpError(400, "bad_brand", "As cores da arte devem estar no formato #RRGGBB.");
      if (v) b[k] = v.toUpperCase();
    }
    const sign = str(src.assinatura, 40);
    if (sign) b.assinatura = sign;
    out.brand = b;
  }
  if (typeof a.story_default === "boolean") out.story_default = a.story_default;
  if (typeof a.ai_label === "boolean") out.ai_label = a.ai_label;
  if ("lead_hours" in a) {
    const h = Number(a.lead_hours);
    if (!Number.isInteger(h) || h < 1 || h > 168) throw new HttpError(400, "bad_lead", "A antecedência deve ficar entre 1 e 168 horas.");
    out.lead_hours = h;
  }
  if ("name" in a && !out.name) out.name = "Agente Sr. Post";
  if (Array.isArray(a.pillars)) out.pillars = a.pillars.map((p) => str(p, 60)).filter(Boolean).slice(0, 8);
  if (Array.isArray(a.post_times)) {
    const times = a.post_times.map((t) => str(t, 5)).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    out.post_times = [...new Set(times)].sort().slice(0, 6);
  }
  if (typeof a.posts_per_week === "number") out.posts_per_week = Math.min(28, Math.max(1, Math.round(a.posts_per_week)));
  if (typeof a.status === "string" && ["ativo", "pausado", "configurando"].includes(a.status)) out.status = a.status;
  if (Array.isArray(a.platforms)) {
    const list = a.platforms.map((p) => str(p, 12)).filter((p, i, arr) => (PLATFORMS as readonly string[]).includes(p) && arr.indexOf(p) === i);
    if (list.length) out.platforms = list;
  }
  return out;
}

// Cria o cliente e o agente dele. Usado pelo painel e pelo assistente "Novo agente".
export async function createClientWithAgent(b: Record<string, unknown>): Promise<{ id: string; name: string; slug: string; is_demo: boolean }> {
  const name = str(b.name, 80);
  if (name.length < 2) throw new HttpError(400, "bad_name", "Informe o nome do cliente.");
  // Fuso invalido quebraria as contas de horario do agente: recusa na entrada.
  const tz = str(b.timezone, 60);
  if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch (_) { throw new HttpError(400, "bad_timezone", "Fuso horário inválido. Use um nome como America/Sao_Paulo."); } }
  let slug = slugify(str(b.slug, 60) || name);
  if (slug.length < 2) slug = `cliente-${Date.now().toString(36)}`;
  const { data: dup } = await db.from("clients").select("id").eq("slug", slug).maybeSingle();
  if (dup) slug = `${slug.slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`;
  const client = must(await db.from("clients").insert({
    name, slug, segment: str(b.segment, 80) || null, timezone: str(b.timezone, 60) || "America/Sao_Paulo",
    is_demo: b.is_demo === true,
  }).select("id, name, slug, is_demo").single()) as { id: string; name: string; slug: string; is_demo: boolean };
  must(await db.from("agents").insert({ client_id: client.id, ...agentPatch(b.agent as Record<string, unknown>) }));
  return client;
}

// Gera um link magico do portal. O endereco completo so existe nesta resposta: no banco fica apenas o hash.
export async function newPortalLink(clientId: string, label: string | null, days: number | null = null): Promise<string> {
  const token = randomToken(32);
  must(await db.from("portal_links").insert({
    client_id: clientId, token_hash: await sha256Hex(token), label,
    expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  }));
  return `${await portalUrl()}#${token}`;
}
