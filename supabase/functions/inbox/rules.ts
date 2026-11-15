// Regras da caixa de entrada, sem IA. Classifica o comentario e decide a acao automatica.

export type Category = "emoji" | "praise" | "question" | "attention" | "mention" | "keyword" | "other";

export type KeywordRule = { keywords: string[]; reply: string };

export type InboxSettings = {
  auto_enabled: boolean;
  emoji_action: "reply" | "ignore";
  emoji_reply: string;
  praise_action: "reply" | "ignore";
  praise_reply: string;
  keyword_rules: KeywordRule[];
  daily_cap: number;
};

export const DEFAULT_SETTINGS: InboxSettings = {
  auto_enabled: true,
  emoji_action: "reply",
  emoji_reply: "🙌",
  praise_action: "reply",
  praise_reply: "Valeu! 🙌",
  keyword_rules: [],
  daily_cap: 30,
};

// Tira acento e caixa para comparar palavras.
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu;
const MENTION = /@[\w.]+/g;

const PRAISE = [
  "top", "show", "amei", "adorei", "lindo", "linda", "perfeito", "perfeita", "incrivel", "sensacional", "demais",
  "maravilhoso", "maravilhosa", "otimo", "otima", "excelente", "muito bom", "muito boa", "parabens", "sucesso",
  "arrasou", "massa", "brabo", "foda", "genial", "bom demais", "que legal", "legal", "boa", "obrigado", "obrigada",
  "valeu", "nice", "love", "uau", "wow", "kkk", "haha", "rs",
];

const QUESTION_WORDS = [
  "quanto", "quanta", "qual", "quais", "como", "onde", "quando", "porque", "por que", "pq", "tem como", "da pra",
  "da para", "consigo", "pode", "podem", "voces", "vcs", "preco", "valor", "custa", "frete", "entrega", "link",
  "site", "comprar", "contrato", "plano", "horario", "endereco", "whatsapp", "zap", "contato", "duvida", "ajuda",
];

const ATTENTION_WORDS = [
  "golpe", "fraude", "pessimo", "pessima", "horrivel", "ruim", "reclamacao", "reclamar", "procon", "nao funciona",
  "nao funcionou", "problema", "erro", "cancelar", "cancelamento", "reembolso", "devolucao", "estorno", "nao recebi",
  "atraso", "absurdo", "processo", "advogado", "denuncia", "mentira", "enganacao", "nunca mais",
];

const hasWord = (text: string, words: string[]) =>
  words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/ /g, "\\s+")}([^a-z0-9]|$)`).test(text));

export function classify(raw: string, rules: KeywordRule[] = []): { category: Category; rule?: KeywordRule } {
  const text = (raw ?? "").trim();
  const withoutMentions = text.replace(MENTION, " ").trim();
  const words = fold(withoutMentions.replace(EMOJI, " ")).replace(/[^a-z0-9?\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return { category: "other" };
  if (!withoutMentions) return { category: "mention" }; // so marcou alguem
  if (!words) return { category: "emoji" };
  const f = fold(text);
  if (hasWord(f, ATTENTION_WORDS)) return { category: "attention" };
  for (const rule of rules) {
    const kws = (rule.keywords ?? []).map((k) => fold(String(k)).trim()).filter(Boolean);
    if (kws.length && rule.reply && hasWord(f, kws)) return { category: "keyword", rule };
  }
  if (text.includes("?") || hasWord(f, QUESTION_WORDS)) return { category: "question" };
  const n = words.split(" ").filter(Boolean).length;
  if (n <= 5 && hasWord(words, PRAISE)) return { category: "praise" };
  return { category: "other" };
}

// Texto da resposta automatica, ou null quando o comentario vai para uma pessoa.
export function autoReply(category: Category, s: InboxSettings, rule?: KeywordRule): string | null {
  if (!s.auto_enabled) return null;
  if (category === "emoji" && s.emoji_action === "reply") return s.emoji_reply.trim() || null;
  if (category === "praise" && s.praise_action === "reply") return s.praise_reply.trim() || null;
  if (category === "keyword" && rule?.reply) return rule.reply.trim() || null;
  return null;
}

// Status inicial: o que nao precisa de ninguem fica "done"; o resto espera uma pessoa.
export function initialStatus(category: Category, willReply: boolean): "pending" | "done" {
  if (willReply) return "pending"; // vira auto_replied depois que a resposta sair
  if (category === "mention" || category === "emoji" || category === "praise") return "done";
  return "pending";
}

export function normalizeSettings(row: Record<string, unknown> | null): InboxSettings {
  const r = row ?? {};
  const rules = Array.isArray(r.keyword_rules) ? r.keyword_rules : [];
  return {
    auto_enabled: r.auto_enabled === undefined ? DEFAULT_SETTINGS.auto_enabled : Boolean(r.auto_enabled),
    emoji_action: r.emoji_action === "ignore" ? "ignore" : "reply",
    emoji_reply: typeof r.emoji_reply === "string" ? r.emoji_reply : DEFAULT_SETTINGS.emoji_reply,
    praise_action: r.praise_action === "ignore" ? "ignore" : "reply",
    praise_reply: typeof r.praise_reply === "string" ? r.praise_reply : DEFAULT_SETTINGS.praise_reply,
    keyword_rules: rules
      .map((x: any) => ({
        keywords: (Array.isArray(x?.keywords) ? x.keywords : String(x?.keywords ?? "").split(","))
          .map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 20),
        reply: String(x?.reply ?? "").trim().slice(0, 500),
      }))
      .filter((x: KeywordRule) => x.keywords.length && x.reply)
      .slice(0, 30),
    daily_cap: Math.max(0, Math.min(300, Number(r.daily_cap ?? DEFAULT_SETTINGS.daily_cap) || 0)),
  };
}
