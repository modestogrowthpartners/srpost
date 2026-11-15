// Gerador de midia padrao: arte montada por template a partir do texto do post, sem chave externa.
// A imagem e renderizada pela funcao "render" do proprio projeto (uma chamada por imagem) e ja fica no
// armazenamento do Sr. Post. Produz imagem, carrossel e story em imagem. Nao produz video.
import { getSetting, SUPABASE_URL } from "./core.ts";
import { AgentProfile, ArtBrief, GenConfigError, MediaGenerator, MediaItem, MediaPoll, MediaRequest } from "./gentypes.ts";

const RENDER_URL = `${SUPABASE_URL}/functions/v1/render`;

type Spec = {
  size: "4:5" | "9:16"; layout: "capa" | "conteudo" | "cta"; brand: Record<string, unknown>;
  kicker?: string; titulo: string; texto?: string; itens?: string[]; rodape?: string; pagina?: string; dica?: string;
};

// "texto" com varias linhas vira lista; uma linha so vira paragrafo de apoio.
function split(texto: string): { texto?: string; itens?: string[] } {
  const lines = (texto ?? "").split(/\n+/).map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  if (lines.length >= 2) return { itens: lines.slice(0, 5) };
  return lines.length ? { texto: lines[0] } : {};
}

// Transforma o pedido de midia nas especificacoes de cada imagem.
export function artSpecs(req: MediaRequest): Spec[] {
  const arte = req.arte as ArtBrief | undefined;
  if (!arte || !arte.slides.length) throw new Error("O roteiro não trouxe o texto da arte.");
  const brand = { ...arte.brand, assinatura: arte.assinatura };
  const size = req.proporcao;
  if (req.formato !== "carrossel") {
    const s = arte.slides[0];
    return [{ size, layout: "capa", brand, kicker: arte.kicker, titulo: s.titulo, ...split(s.texto), rodape: arte.cta }];
  }
  const slides = arte.slides.slice(0, 10), n = slides.length;
  return slides.map((s, i) => {
    const pagina = `${i + 1}/${n}`;
    if (i === 0) return { size, layout: "capa" as const, brand, kicker: arte.kicker, titulo: s.titulo, ...split(s.texto), pagina, dica: "Arraste para o lado" };
    if (i === n - 1) return { size, layout: "cta" as const, brand, kicker: arte.kicker, titulo: s.titulo, texto: split(s.texto).texto ?? split(s.texto).itens?.join(" "), rodape: arte.cta || arte.assinatura, pagina };
    return { size, layout: "conteudo" as const, brand, kicker: arte.kicker, titulo: s.titulo, ...split(s.texto), pagina };
  });
}

async function renderOne(clientId: string, spec: Spec, secretValue: string): Promise<MediaItem> {
  const res = await fetch(RENDER_URL, {
    method: "POST", headers: { "content-type": "application/json", "x-worker-secret": secretValue },
    body: JSON.stringify({ client_id: clientId, spec }), signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.url) throw new Error(`A renderização da arte falhou (HTTP ${res.status}): ${body?.message ?? "sem detalhe"}`);
  return { kind: "image", url: body.url as string, thumb: null };
}

export const templateGenerator: MediaGenerator = {
  provider: "template",
  mode: "inline",
  start(req: MediaRequest, _profile: AgentProfile) {
    if (req.formato === "reel") return Promise.reject(new GenConfigError("A arte por template produz imagem, carrossel e story. Reel precisa de vídeo: envie pelo painel ou configure um gerador de vídeo.", "template_sem_video"));
    const specs = artSpecs(req);
    return Promise.resolve({ ref: JSON.stringify({ specs }), note: `${specs.length === 1 ? "1 arte" : specs.length + " artes"} por template` });
  },
  async poll(ref: string, profile: AgentProfile): Promise<MediaPoll> {
    const { specs } = JSON.parse(ref) as { specs: Spec[] };
    const secretValue = (await getSetting("worker_secret")) ?? "";
    const items: MediaItem[] = [];
    // Tres por vez: cada imagem e uma chamada curta a funcao de renderizacao.
    for (let i = 0; i < specs.length; i += 3) {
      items.push(...await Promise.all(specs.slice(i, i + 3).map((s) => renderOne(profile.client_id, s, secretValue))));
    }
    return { state: "ready", items };
  },
};

// Teste do painel: renderiza uma arte de exemplo sem guardar arquivo e devolve o tempo.
export async function templatePing(): Promise<{ ok: boolean; message: string; detail?: unknown }> {
  const secretValue = (await getSetting("worker_secret")) ?? "";
  const res = await fetch(RENDER_URL, {
    method: "POST", headers: { "content-type": "application/json", "x-worker-secret": secretValue },
    body: JSON.stringify({ store: false, spec: { size: "4:5", layout: "capa", brand: { tema: "noite", assinatura: "srpost" }, kicker: "Teste", titulo: "Arte de teste do Sr. Post", itens: ["Layout", "Fontes", "JPEG"] } }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) return { ok: false, message: `A renderização falhou (HTTP ${res.status}): ${body?.message ?? "sem detalhe"}` };
  return { ok: true, message: `Arte de ${body.width}x${body.height} gerada em ${body.ms?.total ?? "?"} ms.`, detail: body };
}
