// Opcoes por criativo (story, legenda, musica, local): o que cada rede aceita pela API oficial e,
// quando nao aceita, o motivo. E a unica fonte dessas regras: portal, painel, ingestao e publicacao usam daqui.
// Referencias: developers.facebook.com/docs/instagram-platform/content-publishing e docs.upload-post.com
export type OptionKey = "story" | "caption" | "music" | "location";
export const OPTION_KEYS: OptionKey[] = ["story", "caption", "music", "location"];
export type OptionState = { on: boolean; allowed: boolean; reason: string | null; note: string | null };
export type OptionSet = Record<OptionKey, OptionState>;
export type OptionValues = Record<OptionKey, boolean>;

export type OptionSource = {
  kind: string; format: string; platforms: string[] | null;
  caption: string | null; hashtags: string | null; link_url: string | null;
  location_id: string | null; location_name: string | null;
  auto_music: boolean | null; opt_story: boolean | null; opt_caption: boolean | null; opt_location: boolean | null;
};

const join = (parts: (string | null | false)[]) => parts.filter(Boolean).join(" ") || null;

export function creativeOptions(c: OptionSource): OptionSet {
  const nets = c.platforms?.length ? c.platforms : ["instagram"];
  const isStory = c.format === "story";
  const ig = nets.includes("instagram");
  const tt = nets.includes("tiktok") && !isStory; // o TikTok nao recebe stories
  const video = c.kind === "video";
  const hasText = Boolean((c.caption ?? "").trim() || (c.hashtags ?? "").trim() || (c.link_url ?? "").trim());
  const off = (reason: string, on = false): OptionState => ({ on, allowed: false, reason, note: null });
  const ok = (on: boolean, note: string | null = null): OptionState => ({ on, allowed: true, reason: null, note });

  const story = isStory ? off("Este criativo já é um story.", true)
    : !ig ? off("Story só existe no Instagram. O TikTok não publica stories pela API.")
    : ok(c.opt_story === true, join([
      c.kind === "carousel" && "O story leva só a primeira imagem do carrossel.",
      "O story sai sem legenda, link e figurinhas: a API do Instagram não permite.",
      tt && "No TikTok não há story.",
    ]));

  const caption = isStory ? off("A API do Instagram não aceita legenda em story. O texto precisa estar na própria arte.")
    : !hasText ? off("O agente não enviou legenda para este criativo.")
    : ok(c.opt_caption !== false, join([
      (c.link_url ?? "").trim() && "O link vai no fim da legenda como texto: as redes não deixam clicar.",
      story.on && "No story não entra legenda.",
    ]));

  const music = tt && !video
    ? ok(c.auto_music === true, join([
      "No TikTok, o provedor adiciona uma música automática às fotos.",
      ig && "No Instagram a API não escolhe música.",
    ]))
    : off(join([
      video && "Em vídeo, a música precisa estar no próprio arquivo.",
      ig && "A API do Instagram não escolhe música da biblioteca.",
      tt && "A escolha de faixa do TikTok ainda não está disponível no Sr. Post.",
    ]) ?? "Não disponível para este formato.");

  const location = !c.location_id ? off("O agente não indicou um local para este post.")
    : isStory ? off("A API do Instagram não marca local em story.")
    : !ig ? off("O local só é marcado no Instagram. No TikTok ainda não está disponível no Sr. Post.")
    : ok(c.opt_location !== false, join([
      c.location_name && `Local: ${c.location_name}.`,
      tt && "No TikTok o post sai sem local.",
      story.on && "No story não entra local.",
    ]));

  return { story, caption, music, location };
}

const stored = (c: OptionSource): OptionValues => ({
  story: c.opt_story === true, caption: c.opt_caption !== false, music: c.auto_music === true, location: c.opt_location !== false,
});

// Aplica o que foi pedido so onde a rede aceita; o resto fica como estava gravado.
export function normalizeOptions(c: OptionSource, wanted: unknown): OptionValues {
  const out = stored(c);
  if (!wanted || typeof wanted !== "object") return out;
  const w = wanted as Record<string, unknown>;
  // Duas passadas: a opcao de story muda as observacoes das outras, nao as permissoes; uma passada basta para os valores.
  const caps = creativeOptions(c);
  for (const k of OPTION_KEYS) if (caps[k].allowed && typeof w[k] === "boolean") out[k] = w[k] as boolean;
  return out;
}

export const optionColumns = (v: OptionValues) => ({
  opt_story: v.story, opt_caption: v.caption, auto_music: v.music, opt_location: v.location,
});

// Legenda final do post principal: texto, link e hashtags. Vazia quando a opcao de legenda esta desligada.
export function composeCaption(c: { caption: string | null; hashtags: string | null; link_url?: string | null; opt_caption?: boolean | null }): string {
  if (c.opt_caption === false) return "";
  return [c.caption, c.link_url, c.hashtags].map((s) => (s ?? "").trim()).filter(Boolean).join("\n\n");
}
