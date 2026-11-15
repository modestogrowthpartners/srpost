// PublisherAdapter: contrato unico de publicacao. O worker nao sabe qual rede ou provedor esta por tras.
//   meta        Instagram pela API oficial da Meta (token da Pagina do cliente).
//   uploadpost  TikTok pelo provedor Upload-Post (perfil do cliente no provedor).
// Para trocar o TikTok pela Content Posting API direta, basta criar outro adaptador com este contrato.
import * as ig from "./instagram.ts";
import * as up from "./uploadpost.ts";

export type AccountRow = {
  id: string; client_id: string; platform: string; provider: string; provider_ref: string | null;
  external_id: string; status: string; token_issued_at: string | null; token_expires_at: string | null; updated_at: string;
};

export type CreativeRow = {
  kind: "video" | "image" | "carousel"; format: "reel" | "feed" | "story";
  media_url: string; media: { kind: "video" | "image"; url: string }[] | null;
  title: string | null; caption: string; hashtags: string; ai_generated: boolean;
  location_id: string | null; audio_name: string | null; auto_music: boolean;
};

export type PublishJob = { creative: CreativeRow; account: AccountRow; token: string | null };

export type PollResult =
  | { state: "pending" }
  | { state: "published"; mediaId: string | null; permalink: string | null }
  | { state: "failed"; error: string };

export type Metrics = {
  views?: number; reach?: number; likes?: number; comments?: number; saved?: number; shares?: number;
  total_interactions?: number; avg_watch_time_ms?: number;
};

// A conta precisa ser reconectada pelo cliente (token invalido, expirado ou acesso revogado).
export class ReconnectError extends Error {
  constructor(message: string, public code: string | null = null, public detail: Record<string, unknown> = {}) { super(message); }
}

// Como o worker deve tratar uma falha: reconectar, tentar de novo (em quantos ciclos e ate quantas vezes) ou desistir.
export type Failure = {
  kind: "reconnect" | "retry" | "fatal"; ticks: number; maxAttempts: number;
  code: string | null; message: string; detail: Record<string, unknown>;
};

const META_TRANSIENT_SUBCODES = [2207001, 2207003, 2207020, 2207027, 2207032, 2207053];
const META_THROTTLE_CODES = [4, 17, 32, 368, 613];

// Classifica o erro pela documentacao de codigos da API de publicacao do Instagram.
export function classifyError(e: unknown): Failure {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ReconnectError) return { kind: "reconnect", ticks: 0, maxAttempts: 0, code: e.code, message, detail: e.detail };
  if (e instanceof ig.IgError) {
    const code = [e.code, e.subcode].filter((v) => v !== undefined && v !== null).join("/") || `http/${e.status}`;
    const f = (kind: Failure["kind"], ticks: number, maxAttempts: number, classe: string): Failure =>
      ({ kind, ticks, maxAttempts, code, message, detail: { ...e.info, classe } });
    if (e.subcode === 2207050 || e.code === 25) return f("fatal", 0, 0, "conta do Instagram restrita: o dono precisa resolver no aplicativo");
    if (e.subcode === 2207042 || e.code === 9) return f("retry", 72, 6, "limite diario de publicacoes pela API");
    if (e.subcode === 2207051) return f("retry", 2, 5, "suspeita de spam (Meta)");
    if (META_THROTTLE_CODES.includes(e.code ?? 0) || e.status === 429) return f("retry", 2, 5, "limite de chamadas");
    if (e.info.is_transient === true || e.status >= 500 || [-2, -1, 1, 2, 9007].includes(e.code ?? 0) || META_TRANSIENT_SUBCODES.includes(e.subcode ?? 0)) {
      return f("retry", 1, 5, "falha temporaria da Meta");
    }
    return f("retry", 2, 3, "erro da Meta");
  }
  if (e instanceof up.UploadPostError) {
    const code = `uploadpost/${e.status}${e.code ? "/" + e.code : ""}`;
    const soon = e.status === 429 || e.status >= 500;
    return { kind: "retry", ticks: soon ? 1 : 2, maxAttempts: soon ? 5 : 3, code, message, detail: { http: e.status, classe: soon ? "falha temporaria do provedor" : "erro do provedor" } };
  }
  if (e instanceof TypeError) return { kind: "retry", ticks: 1, maxAttempts: 5, code: "network", message, detail: { classe: "falha de rede" } };
  return { kind: "retry", ticks: 2, maxAttempts: 3, code: null, message, detail: {} };
}

export interface PublisherAdapter {
  readonly provider: string;
  readonly needsToken: boolean;
  /** Tempo maximo de processamento antes de desistir da tentativa. */
  readonly timeoutMs: number;
  /** Inicia a publicacao e devolve a referencia do job no provedor. */
  start(job: PublishJob): Promise<string>;
  /** Consulta o job; quando pronto, conclui a publicacao. */
  poll(job: PublishJob, ref: string): Promise<PollResult>;
  /** Metricas do post publicado; null quando ainda nao ha dados. */
  metrics(job: PublishJob, post: { media_id: string | null; ref: string | null }): Promise<Metrics | null>;
}

const fullCaption = (c: CreativeRow) => [c.caption, c.hashtags].filter(Boolean).join("\n\n");

async function guardMeta<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof ig.IgError && e.tokenInvalid) {
      throw new ReconnectError(e.message, [e.code, e.subcode].filter((v) => v !== undefined && v !== null).join("/"), { ...e.info, classe: "token invalido, expirado ou revogado" });
    }
    throw e;
  }
}

const metaInstagram: PublisherAdapter = {
  provider: "meta",
  needsToken: true,
  timeoutMs: 30 * 60_000,
  start: (job) => guardMeta(() => ig.createContainer(job.account.external_id, job.token!, {
    kind: job.creative.kind, format: job.creative.format, mediaUrl: job.creative.media_url,
    items: job.creative.media ?? [], caption: fullCaption(job.creative), aiGenerated: job.creative.ai_generated,
    locationId: job.creative.location_id, audioName: job.creative.audio_name,
  })),
  poll: (job, ref) => guardMeta(async () => {
    const st = await ig.containerStatus(ref, job.token!);
    if (st.code === "IN_PROGRESS") return { state: "pending" };
    if (st.code === "ERROR" || st.code === "EXPIRED") return { state: "failed", error: `Instagram recusou a mídia: ${st.detail || st.code}` };
    let mediaId: string | null = null;
    if (st.code === "FINISHED") mediaId = await ig.publishContainer(job.account.external_id, job.token!, ref);
    let permalink: string | null = null;
    if (mediaId) {
      try { permalink = (await ig.mediaInfo(mediaId, job.token!))?.permalink ?? null; } catch (_) { /* segue sem link */ }
    }
    return { state: "published", mediaId, permalink };
  }),
  metrics: (job, post) => guardMeta(async () => {
    if (!post.media_id) return null;
    const m = await ig.mediaInsights(post.media_id, job.token!, job.creative.format);
    return {
      views: m.views, reach: m.reach, likes: m.likes, comments: m.comments, saved: m.saved, shares: m.shares,
      total_interactions: m.total_interactions, avg_watch_time_ms: m.ig_reels_avg_watch_time,
    };
  }),
};

// Erro do provedor que indica conexao perdida do cliente (401 e chave do provedor invalida: configuracao, nao cliente).
function guardProvider(e: unknown): never {
  if (e instanceof up.UploadPostError && e.status !== 401 && /reauth|reconnect|not connected|no connected/i.test(e.message)) {
    throw new ReconnectError(e.message, `uploadpost/${e.status}`, { http: e.status, classe: "conexao do provedor precisa ser refeita" });
  }
  throw e;
}

const uploadPost: PublisherAdapter = {
  provider: "uploadpost",
  needsToken: false,
  timeoutMs: 60 * 60_000,
  async start(job) {
    const c = job.creative;
    const urls = c.kind === "carousel" ? (c.media ?? []).map((m) => m.url) : [c.media_url];
    try {
      return await up.upload({
        profile: job.account.provider_ref!, platform: job.account.platform, kind: c.kind, urls,
        title: c.title ?? "", caption: fullCaption(c), aiGenerated: c.ai_generated, autoMusic: c.auto_music,
      });
    } catch (e) { guardProvider(e); }
  },
  async poll(job, ref) {
    try {
      const st = await up.uploadStatus(ref, job.account.platform);
      if (st.state === "pending") return { state: "pending" };
      if (st.state === "failed") return { state: "failed", error: st.error };
      return { state: "published", mediaId: st.postId, permalink: st.url };
    } catch (e) { guardProvider(e); }
  },
  async metrics(job, post) {
    if (!post.ref) return null;
    const m = await up.postMetrics(post.ref, job.account.platform);
    if (!Object.keys(m).length) return null;
    const saved = m.saves ?? m.favorites;
    const parts = [m.likes, m.comments, m.shares, saved].filter((v) => typeof v === "number") as number[];
    return {
      views: m.views, reach: m.reach, likes: m.likes, comments: m.comments, saved, shares: m.shares,
      total_interactions: parts.length ? parts.reduce((a, b) => a + b, 0) : undefined,
    };
  },
};

const ADAPTERS: Record<string, PublisherAdapter> = { meta: metaInstagram, uploadpost: uploadPost };

export function adapterFor(account: AccountRow): PublisherAdapter {
  const a = ADAPTERS[account.provider];
  if (!a) throw new Error(`Provedor desconhecido: ${account.provider}`);
  return a;
}
