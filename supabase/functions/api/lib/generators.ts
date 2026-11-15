// Geradores de conteudo atras do contrato de gentypes.ts. O motor (agents.ts) so usa as fabricas daqui:
//   texto: claude (precisa do segredo ANTHROPIC_API_KEY) ou simulado (so cliente de demonstracao)
//   midia: manual (o time envia pelo painel), higgsfield (precisa de HIGGSFIELD_API_KEY) ou simulado (so demonstracao)
// Trocar de fornecedor e escrever outra classe com a mesma interface e registrar na fabrica.
import Anthropic from "npm:@anthropic-ai/sdk@1";
import { getSetting } from "./core.ts";
import { providerStatus, secret } from "./secrets.ts";
import { AgentProfile, Copy, Formato, GenConfigError, GenContext, Generated, GenUsage, MediaGenerator, MediaItem, MediaPoll, MediaRequest, PlanItem, Script, TextGenerator } from "./gentypes.ts";
import { clip, limpar, reviewCopy } from "./humanize.ts";
import { COPY_SCHEMA, copyMessage, PLAN_SCHEMA, planMessage, SCRIPT_SCHEMA, scriptMessage, SYSTEM } from "./prompts.ts";

export { reviewCopy };

// Chaves: segredo da funcao no Supabase ou valor colado no painel (Vault). Demais variaveis: so ambiente.
const env = (key: string) => (["ANTHROPIC_API_KEY", "HIGGSFIELD_API_KEY"].includes(key) ? secret(key) : (Deno.env.get(key) ?? "").trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function hash(s: string): number { // FNV-1a de 32 bits: rodizio estavel, sem sorteio
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// deno-lint-ignore no-explicit-any
type Raw = any;
type AgentConfig = { text_provider?: string | null; media_provider?: string | null };

function demoOnly(profile: AgentProfile, what: string) {
  if (!profile.is_demo) throw new GenConfigError(`A simulação de ${what} só roda em cliente de demonstração. Troque o fornecedor deste agente.`, "simulado_fora_de_demo");
}

// =====================================================================================
// Texto: Claude
// =====================================================================================
export const CLAUDE_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Uma tentativa de ate 50 s por chamada: o motor ja repete a etapa (2, 10 e 30 min) e cada ciclo tem de fechar em 150 s.
const CLAUDE_TIMEOUT_MS = 50_000;
const claudeModel = () => env("CLAUDE_MODEL") || CLAUDE_MODEL;

function claudeError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) {
    return new GenConfigError("O Claude recusou a chave (HTTP 401). Confira o segredo ANTHROPIC_API_KEY nas Edge Functions do Supabase.", "chave_claude_invalida");
  }
  // Rede antes de APIError: no SDK de TypeScript, APIConnectionError e subclasse de APIError.
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new Error(`O Claude não respondeu em ${CLAUDE_TIMEOUT_MS / 1000} segundos (sem status HTTP).`);
  if (e instanceof Anthropic.APIConnectionError) return new Error("Não foi possível falar com o Claude: falha de rede (sem status HTTP).");
  if (e instanceof Anthropic.RateLimitError) return new Error("O Claude limitou as chamadas desta conta (HTTP 429).");
  if (e instanceof Anthropic.APIError) {
    const detail = [e.type, e.apiMessage?.slice(0, 160)].filter(Boolean).join(": ");
    return new Error(`O Claude respondeu com erro (HTTP ${e.status ?? "desconhecido"}${detail ? `, ${detail}` : ""}).`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

const text = (v: unknown, max = 2000) => clip(limpar(v), max);
const STORY_NOTE = "Story sai sem legenda e sem hashtags: a API do Instagram não aceita. O texto está na arte.";
const placeholder = (parts: string[]) => parts.some((p) => /\{\{[^}]*\}\}/.test(p));

function toPlan(v: Raw, profile: AgentProfile, ctx: GenContext): PlanItem {
  const tema = text(v?.tema, 140).replace(/\s+/g, " ");
  if (!tema) throw new Error("O Claude devolveu o plano sem tema.");
  return { tema, pilar: text(v?.pilar, 120) || ctx.pilar || profile.pillars[0] || "", objetivo: text(v?.objetivo, 40) || "alcance", angulo: text(v?.angulo, 600) };
}

// O formato de saida nao aceita contagens, entao as regras de cada formato sao conferidas aqui.
function toScript(v: Raw, formato: Formato): Script {
  const arr = (x: unknown): Raw[] => (Array.isArray(x) ? x : []);
  const hooks = arr(v?.hooks).map((h) => ({ texto: text(h?.texto, 300), formula: text(h?.formula, 80), nota: Math.max(0, Math.min(100, Math.round(Number(h?.nota) || 0))) }))
    .filter((h) => h.texto).slice(0, 5);
  const hook = text(v?.hook, 300) || [...hooks].sort((a, b) => b.nota - a.nota)[0]?.texto || "";
  if (!hook) throw new Error("O Claude devolveu o roteiro sem abertura.");
  let beats = arr(v?.beats).map((b) => ({ tempo: text(b?.tempo, 20), fala: text(b?.fala, 500), tela: text(b?.tela, 120) })).filter((b) => b.fala || b.tela);
  let slides = arr(v?.slides).map((s) => ({ titulo: text(s?.titulo, 120), texto: text(s?.texto, 400) })).filter((s) => s.titulo || s.texto);
  const conceito = text(v?.conceito_visual, 900);
  if (!conceito) throw new Error("O Claude devolveu o roteiro sem conceito visual.");
  let duracao: number | null = null;
  if (formato === "reel") {
    if (beats.length < 2) throw new Error("O Claude devolveu o roteiro do Reel sem os trechos.");
    slides = [];
    const d = Math.round(Number(v?.duracao_s) || 0);
    duracao = d > 0 ? Math.max(5, Math.min(90, d)) : null;
  } else if (formato === "carrossel") {
    if (slides.length < 6) throw new Error(`O Claude devolveu o carrossel com ${slides.length} slides. O mínimo é 6.`);
    slides = slides.slice(0, 10); beats = [];
  } else if (formato === "story") {
    // Story e um quadro: o texto da arte fica em beats[].tela.
    beats = (beats.length ? beats : [{ tempo: "", fala: "", tela: hook }]).slice(0, 2).map((b) => ({ tempo: "", fala: "", tela: b.tela || b.fala }));
    slides = [];
  } else { beats = []; slides = []; }
  if (placeholder([hook, conceito, ...beats.flatMap((b) => [b.fala, b.tela]), ...slides.flatMap((s) => [s.titulo, s.texto])])) {
    throw new Error("O Claude deixou um marcador para preencher no roteiro. O texto precisa sair pronto.");
  }
  return { hooks, hook, beats, slides, conceito_visual: conceito, duracao_s: duracao };
}

function toCopy(v: Raw, plan: PlanItem): Copy {
  const legenda = typeof v?.legenda === "string" ? v.legenda.trim() : "";
  if (!legenda) throw new Error("O Claude devolveu a legenda vazia.");
  if (placeholder([legenda])) throw new Error("O Claude deixou um marcador para preencher na legenda. O texto precisa sair pronto.");
  const tags = (Array.isArray(v?.hashtags) ? v.hashtags : []).map((t: unknown) => `#${String(t ?? "").replace(/^#+/, "").replace(/\s+/g, "")}`).filter((t: string) => t.length > 1);
  const alertas = (Array.isArray(v?.alertas) ? v.alertas : []).map((a: unknown) => text(a, 300)).filter(Boolean).slice(0, 8);
  return { titulo: text(v?.titulo, 120) || plan.tema.slice(0, 120), legenda, hashtags: tags.join(" "), alertas };
}

class ClaudeText implements TextGenerator {
  readonly provider = "claude";
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0 });
  }

  // Uma chamada, resposta em JSON estruturado. max_tokens inclui o raciocinio (thinking), por isso a folga.
  private async ask(user: string, schema: Record<string, unknown>, maxTokens: number): Promise<{ value: Raw; usage: GenUsage }> {
    let res;
    try {
      res = await this.client.beta.messages.create({
        model: claudeModel(),
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema } },
        // Se o classificador de seguranca recusar um pedido legitimo, a API tenta de novo no modelo reserva.
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      });
    } catch (e) { throw claudeError(e); }
    if (res.stop_reason === "refusal") {
      const category = res.stop_details?.category;
      throw new Error(`O Claude recusou escrever este texto${category ? ` (categoria ${category})` : ""}. Revise o contexto, os temas e o pedido de ajuste deste agente.`);
    }
    if (res.stop_reason === "max_tokens") throw new Error("A resposta do Claude foi cortada pelo limite de tokens antes do fim.");
    // Le por tipo de bloco: a resposta pode comecar com blocos de raciocinio vazios.
    const body = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let value: Raw;
    try { value = JSON.parse(body); } catch (_) { throw new Error("O Claude devolveu um texto fora do formato combinado."); }
    const u = res.usage;
    // Entrada total: tokens novos mais os lidos e os gravados no cache de prompt.
    const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return { value, usage: { provider: this.provider, model: res.model, input_tokens: input, output_tokens: u.output_tokens ?? null } };
  }

  async plan(profile: AgentProfile, ctx: GenContext): Promise<Generated<PlanItem>> {
    const r = await this.ask(planMessage(profile, ctx), PLAN_SCHEMA, 6000);
    return { value: toPlan(r.value, profile, ctx), usage: r.usage };
  }

  async script(profile: AgentProfile, plan: PlanItem, ctx: GenContext): Promise<Generated<Script>> {
    const r = await this.ask(scriptMessage(profile, plan, ctx), SCRIPT_SCHEMA, 12000);
    return { value: toScript(r.value, ctx.formato), usage: r.usage };
  }

  async copy(profile: AgentProfile, plan: PlanItem, script: Script, ctx: GenContext): Promise<Generated<Copy>> {
    // Story nao tem o que escrever: a API do Instagram nao aceita legenda nem hashtag em story. Nenhuma chamada e feita.
    if (ctx.formato === "story") {
      return {
        value: { titulo: plan.tema.slice(0, 120), legenda: "", hashtags: "", alertas: [STORY_NOTE] },
        usage: { provider: this.provider, model: null, input_tokens: 0, output_tokens: 0 },
      };
    }
    const r = await this.ask(copyMessage(profile, plan, script, ctx), COPY_SCHEMA, 8000);
    return { value: toCopy(r.value, plan), usage: r.usage };
  }
}

// =====================================================================================
// Texto: simulado (so demonstracao). Sem rede e sem sorteio: o mesmo pedido da o mesmo texto.
// Todo titulo abre com "[Simulação]" e a legenda diz que e texto de exemplo.
// =====================================================================================
const SIM = "[Simulação]";
const SIM_USAGE: GenUsage = { provider: "simulado", model: null, input_tokens: null, output_tokens: null };
const SIM_TEMAS = [
  "o erro mais comum de quem está começando", "três dúvidas que chegam antes da primeira compra", "o passo a passo que a equipe segue",
  "o que muda quando o básico é bem feito", "mito ou verdade: o que mais se ouve por aí", "bastidores de um dia de trabalho",
];
const SIM_OBJETIVO: Record<Formato, string> = { reel: "alcance", carrossel: "salvamento", imagem: "alcance", story: "relacionamento" };
const simCta = (p: AgentProfile) => (typeof p.voice?.cta === "string" && p.voice.cta.trim()) || "Salve este post para consultar depois.";
const words = (s: string, n: number) => s.replace(/[.!?,;:]+$/, "").split(/\s+/).slice(0, n).join(" ");
const slug = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

class SimulatedText implements TextGenerator {
  readonly provider = "simulado";

  plan(profile: AgentProfile, ctx: GenContext): Promise<Generated<PlanItem>> {
    const pilar = ctx.pilar || profile.pillars[0] || "Conteúdo";
    const seed = hash(`${profile.client_id}|${ctx.formato}|${pilar}|${ctx.slot_at ?? ""}`);
    let tema = "", assunto = "";
    // Anda na lista ate achar um tema que ainda nao saiu nos posts recentes.
    for (let i = 0; i < SIM_TEMAS.length; i++) {
      assunto = SIM_TEMAS[(seed + i) % SIM_TEMAS.length];
      tema = `${SIM} ${pilar}: ${assunto}`;
      if (!ctx.recentes.some((r) => r.startsWith(tema))) break;
    }
    const angulo = `Exemplo de ângulo para ${profile.client_name}: falar de ${assunto} com ${(profile.audience ?? "").trim() || "o público da conta"}. Texto de simulação, não foi escrito pelo Claude.`;
    return Promise.resolve({ value: { tema, pilar, objetivo: SIM_OBJETIVO[ctx.formato], angulo }, usage: SIM_USAGE });
  }

  script(profile: AgentProfile, plan: PlanItem, ctx: GenContext): Promise<Generated<Script>> {
    const pilar = (plan.pilar || "o assunto").toLowerCase();
    const assunto = plan.tema.includes(": ") ? plan.tema.slice(plan.tema.indexOf(": ") + 2) : plan.tema.replace(SIM, "").trim();
    const cta = simCta(profile);
    const turn = hash(`${profile.client_id}|${plan.tema}`) % 3, notas = [72, 66, 58];
    const hooks = [
      { texto: `Você não precisa saber tudo sobre ${pilar} para começar.`, formula: "Permissão" },
      { texto: `Se você tem dúvida sobre ${pilar}, isso é para você.`, formula: "Se Isso, Então Assista" },
      { texto: `Pare de deixar ${pilar} para depois.`, formula: "Comando Negativo" },
    ].map((h, i) => ({ ...h, nota: notas[(i + turn) % 3] }));
    const hook = [...hooks].sort((a, b) => b.nota - a.nota)[0].texto;
    const base: Script = { hooks, hook, beats: [], slides: [], conceito_visual: "", duracao_s: null };
    const visual = (desc: string) => `Simulação: ${desc}`; // conceito de exemplo, rotulado como o resto do texto simulado
    if (ctx.formato === "reel") {
      return Promise.resolve({ usage: SIM_USAGE, value: { ...base, duracao_s: 18, conceito_visual: visual(`vídeo vertical com cenas do dia a dia de ${profile.client_name}, em cortes curtos.`), beats: [
        { tempo: "0-3s", fala: hook, tela: words(hook, 6) },
        { tempo: "3-7s", fala: `Aqui, o tema ${pilar} aparece todo dia.`, tela: words(plan.pilar || "Todo dia", 6) },
        { tempo: "7-11s", fala: `O ponto de hoje: ${assunto}.`, tela: words(assunto, 6) },
        { tempo: "11-15s", fala: "Comece pelo simples e observe o que muda.", tela: "Comece pelo simples" },
        { tempo: "15-18s", fala: `${cta} Para começar, você não precisa saber tudo.`, tela: words(cta, 6) },
      ] } });
    }
    if (ctx.formato === "carrossel") {
      return Promise.resolve({ usage: SIM_USAGE, value: { ...base, conceito_visual: visual("imagens de fundo liso, com uma cor de destaque e espaço limpo para o título."), slides: [
        { titulo: words(`${plan.pilar || "Guia"}: guia rápido`, 6), texto: "O que importa, em seis slides." },
        { titulo: "Por que falar disso", texto: `Este é um tema do pilar ${plan.pilar || "principal"} de ${profile.client_name}: ${assunto}.` },
        { titulo: "Comece pelo simples", texto: "Um passo de cada vez. O primeiro é entender onde você está hoje." },
        { titulo: "Observe o que muda", texto: "Anote o que funcionou e o que não funcionou, sem pressa." },
        { titulo: "Resumo", texto: "1. Comece pelo simples. 2. Observe o que muda. 3. Ajuste e repita." },
        { titulo: "Próximo passo", texto: cta },
      ] } });
    }
    if (ctx.formato === "story") {
      return Promise.resolve({ usage: SIM_USAGE, value: { ...base, conceito_visual: visual("foto vertical de bastidor, com espaço limpo no centro do quadro."), beats: [{ tempo: "", fala: "", tela: words(hook, 8) }] } });
    }
    return Promise.resolve({ usage: SIM_USAGE, value: { ...base, conceito_visual: visual(`foto de um detalhe do trabalho de ${profile.client_name}, com luz natural.`) } });
  }

  copy(profile: AgentProfile, plan: PlanItem, script: Script, ctx: GenContext): Promise<Generated<Copy>> {
    const titulo = `${plan.tema.startsWith(SIM) ? plan.tema : `${SIM} ${plan.tema}`}${ctx.revision > 0 ? ` (versão ${ctx.revision + 1})` : ""}`.slice(0, 120);
    const alertas = ["Simulação: texto de exemplo, não foi escrito pelo Claude."];
    if (ctx.feedback?.trim()) alertas.push(`Simulação: o pedido de ajuste do cliente não é interpretado, o texto de exemplo só muda de versão. Pedido: "${ctx.feedback.trim().slice(0, 200)}"`);
    if (ctx.formato === "story") {
      alertas.push(STORY_NOTE);
      return Promise.resolve({ value: { titulo, legenda: "", hashtags: "", alertas }, usage: SIM_USAGE });
    }
    const legenda = [
      script.hook,
      `Este é um texto de exemplo do pilar ${plan.pilar || "principal"}, gerado em modo de simulação para ${profile.client_name}. Ele mostra como a legenda aparece na fila de aprovação.`,
      simCta(profile),
    ].join("\n\n");
    const tags = [...new Set([plan.pilar, profile.segment ?? "", profile.client_name].map(slug).filter((t) => t.length > 2))].slice(0, 4).map((t) => `#${t}`);
    return Promise.resolve({ value: { titulo, legenda, hashtags: tags.join(" "), alertas }, usage: SIM_USAGE });
  }
}

// =====================================================================================
// Midia: manual. O time envia a midia pelo painel e o proprio motor percebe o envio.
// =====================================================================================
const manualMedia: MediaGenerator = {
  provider: "manual", mode: "manual",
  start: (req) => Promise.resolve({ ref: `manual:${req.formato}`, note: "O time envia a mídia pelo painel, a partir do briefing desta execução." }),
  poll: () => Promise.resolve({ state: "pending", note: "Aguardando o envio da mídia pelo painel." }),
};

// =====================================================================================
// Midia: simulada (so demonstracao). Usa as midias de exemplo da configuracao "sim_media":
//   { "images": [url], "videos": [{ "url": url, "thumb": url|null }] }
// Nada e gerado: a referencia guarda a hora do pedido e as amostras escolhidas, e a midia "fica pronta" 30 s depois.
// =====================================================================================
const SIM_WAIT_MS = 30_000;
export type MediaDeps = { loadSetting?: (key: string) => Promise<string | null>; now?: () => number };
const isUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

class SimulatedMedia implements MediaGenerator {
  readonly provider = "simulado";
  readonly mode = "async" as const;
  constructor(private deps: MediaDeps) {}
  private now() { return (this.deps.now ?? Date.now)(); }

  async start(req: MediaRequest, profile: AgentProfile): Promise<{ ref: string; note: string | null }> {
    let cfg: Raw = null;
    try { cfg = JSON.parse((await (this.deps.loadSetting ?? getSetting)("sim_media")) ?? "null"); } catch (_) { /* configuracao invalida: cai no erro abaixo */ }
    const images: string[] = (Array.isArray(cfg?.images) ? cfg.images : []).filter(isUrl);
    const videos: { url: string; thumb: string | null }[] = (Array.isArray(cfg?.videos) ? cfg.videos : []).filter((v: Raw) => isUrl(v?.url))
      .map((v: Raw) => ({ url: v.url, thumb: isUrl(v.thumb) ? v.thumb : null }));
    // Rodizio pelo conteudo do pedido: posts diferentes pegam amostras diferentes, e o mesmo pedido pega sempre a mesma.
    const turn = hash(`${profile.client_id}|${req.formato}|${req.prompt}|${req.slides.join("|")}`);
    const video = req.formato === "reel" || (req.formato === "story" && req.duracao_s != null);
    let items: MediaItem[] = [], erro: string | null = null;
    if (video) {
      if (videos.length) { const v = videos[turn % videos.length]; items = [{ kind: "video", url: v.url, thumb: v.thumb }]; }
      else erro = "A simulação não tem vídeo de exemplo cadastrado (configuração sim_media, lista videos).";
    } else if (!images.length) {
      erro = "A simulação não tem imagem de exemplo cadastrada (configuração sim_media, lista images).";
    } else {
      const count = req.formato === "carrossel" ? Math.max(2, Math.min(5, req.slides.length)) : 1;
      for (let i = 0; i < count; i++) items.push({ kind: "image", url: images[(turn + i) % images.length], thumb: null });
    }
    return { ref: JSON.stringify({ sim: 1, t: this.now(), items, erro }), note: erro ?? "Simulação: mídia de exemplo, nada foi gerado. Fica pronta em 30 segundos." };
  }

  poll(ref: string): Promise<MediaPoll> {
    let job: Raw = null;
    try { job = JSON.parse(ref); } catch (_) { /* tratado abaixo */ }
    if (!job || job.sim !== 1) return Promise.resolve({ state: "failed", error: "Simulação: a referência do pedido é inválida." });
    if (job.erro) return Promise.resolve({ state: "failed", error: String(job.erro) });
    if (this.now() - Number(job.t) < SIM_WAIT_MS) return Promise.resolve({ state: "pending", note: "Simulação: imitando o tempo de geração (30 segundos)." });
    if (!Array.isArray(job.items) || !job.items.length) return Promise.resolve({ state: "failed", error: "Simulação: nenhuma mídia de exemplo foi escolhida." });
    return Promise.resolve({ state: "ready", items: job.items as MediaItem[] });
  }
}

// =====================================================================================
// Midia: Higgsfield (API REST, https://docs.higgsfield.ai). Escrito pela documentacao publica e testado so contra um
// servidor falso: A VERIFICAR com chave real antes de ligar em cliente.
//   Autenticacao: cabecalho Authorization: Key {id}:{segredo}. O segredo HIGGSFIELD_API_KEY guarda "id:segredo".
//   Envio: POST no endpoint do modelo devolve request_id na hora. Consulta: GET /requests/{id}/status.
//   Estados: queued, in_progress (seguem pendentes), completed, failed, nsfw, canceled (finais).
//   As midias somem do Higgsfield 7 dias depois: o motor copia para o nosso armazenamento assim que ficam prontas.
// A VERIFICAR:
//   - Preco por modelo: nao ha tabela publica confirmada. Use POST /estimate/{endpoint} com a chave real.
//   - Modelo de imagem: SOUL (unico de texto para imagem no openapi.json de referencia). O openapi.json lista
//     aspect_ratio com 4:5 e 9:16; a pagina do modelo lista outras proporcoes (sem 4:5) e outros nomes para
//     resolucao e quantidade. Por isso o pedido leva so prompt e aspect_ratio, os dois campos em que as fontes concordam.
//   - Modelo de video: Kling 2.5 Turbo Pro, imagem para video (5 ou 10 s). O endpoint nao tem campo de proporcao:
//     a suposicao e que o video segue a proporcao da imagem de entrada, por isso a imagem base e gerada em 9:16.
//     Alternativa documentada: /bytedance/seedance-2.0/image-to-video (4 a 15 s, "o enquadramento segue a imagem").
//   - Formato dos arquivos: os exemplos da documentacao mostram imagem .png, e o Instagram so aceita JPEG no feed.
//     O adaptador devolve a URL como veio; a conversao, se for preciso, e de quem guarda a midia (motor).
//   - Trilha de audio: o endpoint do Kling nao tem campo de som. Nao foi conferido se o clipe sai com audio.
// Limites que o time precisa saber (aparecem na nota de cada pedido):
//   - Gerador de imagem nao escreve texto de forma confiavel. O texto da arte (titulo de slide, texto de tela) NAO
//     entra no pedido, so uma pista curta do assunto. Arte com texto continua sendo trabalho do modo manual.
//   - O Reel gerado e um clipe curto a partir de uma imagem, sem a fala e sem o texto de tela do roteiro.
// =====================================================================================
const HF_IMAGE = "/higgsfield-ai/soul/standard";
const HF_VIDEO = "/kling-video/v2.5-turbo/pro/image-to-video";
const HF_TIMEOUT_MS = 15_000;
const hfBase = () => (env("HIGGSFIELD_BASE_URL") || "https://api.higgsfield.ai").replace(/\/+$/, "");
const hfConfigured = () => /^[^\s:]+:\S+$/.test(env("HIGGSFIELD_API_KEY"));

type HfJob = { v: 1; etapa: "imagens" | "base" | "video"; ids: string[]; video?: { prompt: string; duration: number; key: string } };
type HfStatus = { status?: string; error?: string | null; images?: { url?: string }[]; video?: { url?: string } };
type HfResponse = { status: number; data: Raw; retryAfter: string | null };

// Falha ambigua (rede, tempo esgotado, 5xx) e repetida uma vez. No envio, a chave de idempotencia e a mesma nas
// duas tentativas: o Higgsfield devolve o mesmo pedido, sem gerar nem cobrar de novo.
async function hfFetch(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<HfResponse> {
  const headers: Record<string, string> = { authorization: `Key ${env("HIGGSFIELD_API_KEY")}`, accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${hfBase()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(HF_TIMEOUT_MS) });
      const raw = await res.text();
      if (res.status >= 500 && attempt === 0) { await sleep(800); continue; }
      let data: Raw = null;
      try { data = JSON.parse(raw); } catch (_) { /* resposta sem JSON */ }
      return { status: res.status, data, retryAfter: res.headers.get("retry-after") };
    } catch (e) {
      if (attempt === 0) { await sleep(800); continue; }
      throw new Error(`O Higgsfield não respondeu (${e instanceof Error && e.name === "TimeoutError" ? "tempo esgotado" : "falha de rede"}).`);
    }
  }
}

function hfError(r: HfResponse, what: string): Error {
  const d = r.data?.detail;
  const detail = (typeof d === "string" ? d : d ? String(d.message ?? d.code ?? JSON.stringify(d)) : "").slice(0, 200);
  const tail = detail ? `: ${detail}` : "";
  if (r.status === 401) return new GenConfigError("O Higgsfield recusou a chave (HTTP 401). Confira o segredo HIGGSFIELD_API_KEY, no formato id:segredo.", "chave_higgsfield_invalida");
  if (r.status === 403) return new GenConfigError(`O Higgsfield recusou o pedido (HTTP 403${tail}). O motivo mais comum é falta de saldo na conta da API.`, "higgsfield_recusou");
  if (r.status === 429) return new Error(`A fila do Higgsfield está cheia (HTTP 429)${r.retryAfter ? `. O fornecedor pede ${r.retryAfter} segundos de espera` : ""}.`);
  return new Error(`O Higgsfield respondeu com erro ${what} (HTTP ${r.status}${tail}).`);
}

async function hfSubmit(path: string, body: Record<string, unknown>, idempotencyKey: string): Promise<string> {
  const r = await hfFetch("POST", path, body, idempotencyKey);
  if (r.status < 200 || r.status > 299) throw hfError(r, "no envio");
  const id = r.data?.request_id;
  if (typeof id !== "string" || !id) throw new Error("O Higgsfield aceitou o pedido mas não devolveu o identificador.");
  return id;
}

// A consulta usa o caminho documentado, montado com o request_id, e nao a status_url da resposta:
// assim a chave nunca e enviada para outro endereco.
async function hfStatus(id: string): Promise<HfStatus> {
  const r = await hfFetch("GET", `/requests/${encodeURIComponent(id)}/status`);
  if (r.status === 404) return { status: "not_found" };
  if (r.status !== 200) throw hfError(r, "na consulta");
  return (r.data ?? {}) as HfStatus;
}

function hfFailure(s: HfStatus): string | null {
  if (s.status === "failed") return `O Higgsfield não conseguiu gerar a mídia${s.error ? ` (${String(s.error).slice(0, 200)})` : ""}.`;
  if (s.status === "nsfw") return "A moderação do Higgsfield bloqueou o conteúdo (nsfw). Ajuste o conceito visual do post.";
  if (s.status === "canceled") return "O pedido foi cancelado no Higgsfield antes de começar.";
  if (s.status === "not_found") return "O Higgsfield não encontrou o pedido (HTTP 404). Ele pode ter expirado ou ser de outra conta.";
  return null;
}

// O texto da arte fica fora do pedido (ver limites acima): entra so como pista curta do assunto.
function hfImagePrompt(req: MediaRequest, slide: number | null, total = 1): string {
  const hint = slide === null ? req.texto_na_arte[0] : (req.texto_na_arte[slide] ?? req.slides[slide]?.replace(/^Slide \d+:\s*/, ""));
  return [
    (req.prompt.trim().replace(/[.\s]+$/, "") || "Cena do dia a dia da marca") + ".",
    slide === null ? null : `Imagem ${slide + 1} de ${total} de uma mesma série, com o mesmo estilo visual.`,
    hint?.trim() ? `Assunto: ${hint.trim().slice(0, 80).replace(/[.\s]+$/, "")}.` : null,
    "Sem texto, letras, números, logotipos ou marcas d'água na imagem.",
  ].filter(Boolean).join(" ").slice(0, 1500);
}

class HiggsfieldMedia implements MediaGenerator {
  readonly provider = "higgsfield";
  readonly mode = "async" as const;

  async start(req: MediaRequest, _profile: AgentProfile): Promise<{ ref: string; note: string | null }> {
    const pack = (job: HfJob) => JSON.stringify(job);
    // Uma chave de idempotencia nova por geracao pretendida, como a documentacao pede.
    if (req.formato === "reel") {
      const base = await hfSubmit(HF_IMAGE, { prompt: hfImagePrompt(req, null), aspect_ratio: "9:16" }, crypto.randomUUID());
      const duration = (req.duracao_s ?? 0) >= 8 ? 10 : 5; // o modelo so aceita 5 ou 10 segundos
      // A chave do video nasce aqui e viaja na referencia: se a consulta que dispara o video rodar duas vezes, o pedido e o mesmo.
      const video = { prompt: `${req.prompt.trim().replace(/[.\s]+$/, "") || "Cena do dia a dia"}. Movimento de câmera suave e natural.`.slice(0, 1500), duration, key: crypto.randomUUID() };
      return {
        ref: pack({ v: 1, etapa: "base", ids: [base], video }),
        note: `Imagem base 9:16 pedida ao Higgsfield. Quando ficar pronta, ela é animada em um clipe de ${duration} segundos, sem a fala e sem o texto de tela do roteiro.`,
      };
    }
    const slides = req.formato === "carrossel" ? req.slides.slice(0, 10) : [];
    if (req.formato === "carrossel" && slides.length < 2) throw new Error("O carrossel precisa de pelo menos 2 slides para pedir as imagens.");
    const prompts = slides.length ? slides.map((_, i) => hfImagePrompt(req, i, slides.length)) : [hfImagePrompt(req, null)];
    const sent = await Promise.allSettled(prompts.map((prompt) => hfSubmit(HF_IMAGE, { prompt, aspect_ratio: req.proporcao }, crypto.randomUUID())));
    const ids = sent.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    const failed = sent.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) {
      // Um slide recusado derruba o carrossel: cancela o que ja entrou na fila para nao pagar por imagens sem uso.
      await Promise.allSettled(ids.map((id) => hfFetch("POST", `/requests/${encodeURIComponent(id)}/cancel`)));
      throw failed.reason;
    }
    const n = ids.length;
    return {
      ref: pack({ v: 1, etapa: "imagens", ids }),
      note: `${n === 1 ? `Uma imagem ${req.proporcao} pedida` : `${n} imagens ${req.proporcao} pedidas`} ao Higgsfield${n > 1 ? ", uma por slide" : ""}. A arte sai sem texto, porque gerador de imagem não escreve texto de forma confiável. Para arte com texto, use a mídia manual.`,
    };
  }

  async poll(ref: string, _profile: AgentProfile): Promise<MediaPoll> {
    let job: HfJob | null = null;
    try { job = JSON.parse(ref); } catch (_) { /* tratado abaixo */ }
    if (!job || job.v !== 1 || !Array.isArray(job.ids) || !job.ids.length || !["imagens", "base", "video"].includes(job.etapa)) {
      return { state: "failed", error: "A referência do pedido no Higgsfield é inválida." };
    }
    const list = await Promise.all(job.ids.map(hfStatus));
    for (const [i, s] of list.entries()) {
      const why = hfFailure(s);
      if (why) return { state: "failed", error: list.length > 1 ? `Imagem ${i + 1} de ${list.length}: ${why}` : why };
    }
    const done = list.filter((s) => s.status === "completed").length;
    if (done < list.length) {
      return { state: "pending", note: job.etapa === "video" ? "O Higgsfield está gerando o vídeo." : `${done} de ${list.length} ${list.length === 1 ? "imagem pronta" : "imagens prontas"} no Higgsfield.` };
    }
    if (job.etapa === "video") {
      const url = list[0].video?.url;
      if (!isUrl(url)) return { state: "failed", error: "O Higgsfield concluiu o pedido sem devolver o vídeo." };
      // Sem capa: a imagem base expira no Higgsfield em 7 dias e o motor so copia a midia principal.
      return { state: "ready", items: [{ kind: "video", url, thumb: null }] };
    }
    const urls = list.map((s) => s.images?.[0]?.url);
    if (!urls.every(isUrl)) return { state: "failed", error: "O Higgsfield concluiu o pedido sem devolver a imagem." };
    if (job.etapa === "base") {
      if (!job.video?.key) return { state: "failed", error: "A referência do pedido no Higgsfield está sem os dados do vídeo." };
      const id = await hfSubmit(HF_VIDEO, { prompt: job.video.prompt, image_url: urls[0], duration: job.video.duration }, job.video.key);
      return { state: "pending", note: "Imagem base pronta. O Higgsfield está animando a imagem em vídeo.", ref: JSON.stringify({ v: 1, etapa: "video", ids: [id] } satisfies HfJob) };
    }
    return { state: "ready", items: (urls as string[]).map((url) => ({ kind: "image" as const, url, thumb: null })) };
  }
}

// =====================================================================================
// Fabricas e estado
// =====================================================================================
export function textGeneratorFor(agent: AgentConfig, profile: AgentProfile): TextGenerator {
  const provider = agent?.text_provider || "claude";
  if (provider === "simulado") { demoOnly(profile, "texto"); return new SimulatedText(); }
  if (provider === "claude") {
    const key = env("ANTHROPIC_API_KEY");
    if (!key) throw new GenConfigError("Falta a chave do Claude: cole em Configuração, Chaves e integrações, ou use o banco de pautas.", "sem_chave_claude");
    return new ClaudeText(key);
  }
  throw new GenConfigError(`Fornecedor de texto desconhecido: ${provider}.`, "fornecedor_desconhecido");
}

// deps serve aos testes: troca a leitura da configuracao e o relogio da midia simulada.
export function mediaGeneratorFor(agent: AgentConfig, profile: AgentProfile, deps: MediaDeps = {}): MediaGenerator {
  const provider = agent?.media_provider || "manual";
  if (provider === "manual") return manualMedia;
  if (provider === "simulado") { demoOnly(profile, "mídia"); return new SimulatedMedia(deps); }
  if (provider === "higgsfield") {
    if (!env("HIGGSFIELD_API_KEY")) throw new GenConfigError("Falta a chave do Higgsfield: cole em Configuração, Chaves e integrações (formato id:segredo).", "sem_chave_higgsfield");
    if (!hfConfigured()) throw new GenConfigError("O segredo HIGGSFIELD_API_KEY precisa estar no formato id:segredo.", "chave_higgsfield_invalida");
    return new HiggsfieldMedia();
  }
  throw new GenConfigError(`Fornecedor de mídia desconhecido: ${provider}.`, "fornecedor_desconhecido");
}

// Diz so se o segredo esta cadastrado. Se a chave vale, so a primeira chamada real mostra.
export function generatorStatus() {
  return providerStatus();
}
