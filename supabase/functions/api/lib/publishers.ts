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

// A conta precisa ser reconectada pelo cliente (token invalido ou acesso revogado).
export class ReconnectError extends Error {}

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
    if (e instanceof ig.IgError && e.tokenInvalid) throw new ReconnectError(e.message);
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
    throw new ReconnectError(e.message);
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
