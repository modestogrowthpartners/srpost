// Revisor de texto deterministico, sem rede. Porta enxuta do pacote do cliente: skills/tt-human (humanize.py e
// slop.pt.json), skills/tt-caption (caption.py) e skills/tt-post (compliance.py). O que e seguro corrigir sozinho
// e corrigido (caracteres invisiveis, travessao, lexico, hashtags, link, tamanho); o que pede julgamento vira
// aviso "Revisar". Tudo o que mudou e descrito em copy.alertas. Rodar duas vezes da o mesmo resultado.
import { AgentProfile, Copy } from "./gentypes.ts";
import { composeCaption } from "./options.ts";

const MAX_CAPTION = 2200;      // limite do Instagram e do TikTok para legenda + link + hashtags
const MAX_HASHTAGS = 30;       // limite do Instagram
const MAX_HASHTAG_CHARS = 600; // limite do campo hashtags na fila de criativos
const MAX_TITLE = 120;

// O \b do JavaScript nao enxerga letra acentuada ("é", "ç"): as fronteiras de palavra sao feitas com \p{L}.
// O "@" entra na fronteira para o lexico nao mexer em mencao nem em e-mail.
const A = "(?<![\\p{L}\\p{N}_@])", Z = "(?![\\p{L}\\p{N}_@])";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isUpper = (c: string) => c !== c.toLowerCase();

// ---------- Lexico (escolha das entradas mais uteis de slop.pt.json) ----------
// Ficaram de fora as trocas que estragam vocabulario legitimo de cliente: "essencial" (oleo essencial),
// "robusta" (cafe), "fundamental", "mergulhar" (turismo), "a fim de" (coloquial) e "utilizacao" (muda o genero).
const TROCAS = `além disso>também|ademais>também|outrossim>também|por conseguinte>então|dessa forma>assim|desta forma>assim
dessa maneira>assim|contudo>mas|todavia>mas|entretanto>mas|não obstante>mesmo assim|com o objetivo de>para
no intuito de>para|com a finalidade de>para|tendo em vista que>porque|visto que>porque|a nível de>em
de forma eficaz>bem|de maneira eficaz>bem|de forma eficiente>bem|de maneira eficiente>bem
de forma significativa>bastante|de maneira significativa>bastante|é de suma importância>é importante
de extrema importância>muito importante|em última análise>no fim|no mundo acelerado de hoje>hoje
no mundo digital de hoje>hoje|no mundo atual>hoje|em um mundo cada vez mais digital>hoje
em um mundo cada vez mais conectado>hoje|em um mundo cada vez mais competitivo>hoje|no cenário atual>hoje
na era digital>hoje|nos dias atuais>hoje|nos dias de hoje>hoje|na atualidade>hoje
alavancar>aumentar|alavancando>aumentando|alavanque>aumente|potencializar>aumentar|potencialize>aumente
potencializa>aumenta|potencializando>aumentando|utilizar>usar|utilizando>usando|utilizamos>usamos|utilizam>usam
utiliza>usa|utilize>use|utilizado>usado|utilizada>usada|proporcionar>dar|proporcionando>dando|proporcionam>dão
proporciona>dá|revolucionar>mudar|revolucionando>mudando|revolucionou>mudou|revoluciona>muda|desvendar>entender
desvende>entenda|desvendando>entendendo|vamos explorar>vamos ver|vamos desvendar>vamos ver|vamos mergulhar>vamos ver
mergulhar fundo em>entrar em|mergulhe fundo em>entre em|divisor de águas>diferencial|game-changer>diferencial
game changer>diferencial|pedra angular>base|sinergia>combinação|um verdadeiro testemunho de>uma prova de
cruciais>importantes|crucial>importante|imprescindíveis>importantes|imprescindível>importante|inovadores>novos
inovadoras>novas|inovador>novo|inovadora>nova|revolucionários>novos|revolucionárias>novas|revolucionário>novo
revolucionária>nova|meticulosamente>com cuidado|holística>completa|holístico>completo|cativante>interessante
de tirar o fôlego>marcante|desbloqueie todo o potencial de>use|desbloqueie o poder de>use`;

const CORTES = `sem sombra de dúvida|em suma|em resumo|em conclusão|para concluir|vale ressaltar que|vale a pena ressaltar que
vale destacar que|vale mencionar que|vale a pena mencionar que|cabe ressaltar que|cabe destacar que
é importante ressaltar que|é importante destacar que|é importante lembrar que|é importante notar que
é válido ressaltar que|é fundamental ressaltar que|importante ressaltar que|você já parou para pensar
você já se perguntou|imagine só|imagine o seguinte|vamos ser sinceros|sejamos honestos|não é segredo que
não é nenhum segredo que|sem mais delongas|a dura verdade é que|alerta de spoiler|pare de rolar|para de rolar
não role para baixo|não passe direto|assista até o final|no vídeo de hoje eu vou te mostrar|no vídeo de hoje
neste vídeo eu vou te mostrar|nesse vídeo eu vou te mostrar|hoje eu vou te mostrar|hoje vou te mostrar
você não vai acreditar|esse é o seu sinal para|o futuro é agora|a escolha é sua|pense nisso|reflita sobre isso
e o resto é história|se inscreva no canal|salva esse vídeo pra depois|salve esse vídeo para depois`;

// Iscas de engajamento por reflexo: sai o pedido inteiro, ate o fim da frase, para nao sobrar um pedaco solto.
const ISCAS: [string, string][] = [
  ["segue para mais", "(?:me )?(?:segue|siga|sigam)(?: a gente| o perfil)? (?:para|pra) mais[^.!?\\n]*"],
  ["marca alguém que", "marc(?:a|que) algu[eé]m que[^.!?\\n]*"],
  ["compartilhe com alguém que", "compartilh(?:a|e) com algu[eé]m que[^.!?\\n]*"],
  ["comenta aqui embaixo", "coment(?:a|e) aqui embaixo[^.!?\\n]*"],
  ["me conta nos comentários", "(?:me conta|conta pra mim) nos coment[aá]rios[^.!?\\n]*"],
  ["deixe seu like", "deix[ae] (?:o )?seu like[^.!?\\n]*"],
];

const items = (s: string) => s.split(/[|\n]/).map((x) => x.trim()).filter(Boolean);
// Mais longas primeiro: a frase inteira ganha da palavra que esta dentro dela.
const LEXICO: { find: string; to: string; re: RegExp }[] = [
  ...ISCAS.map(([find, pattern]) => ({ find, to: "", re: new RegExp(A + pattern.replace(/ /g, "[ \\t]+"), "giu") })),
  ...[...items(TROCAS).map((x) => x.split(">")), ...items(CORTES).map((x) => [x, ""])]
    .map(([find, to]) => ({ find, to, re: new RegExp(A + esc(find).replace(/ /g, "[ \\t]+") + Z, "giu") }))
    .sort((a, b) => b.find.length - a.find.length),
];

// Saudacao no comeco da legenda: com vocativo ("Oi, gente!") ou sozinha seguida de pontuacao ("Bom dia!").
const SAUDACAO = new RegExp(
  "^[ \\t]*(?:(?:oi+e?|ol[áa]|e a[ií]|fala|salve|bom dia|boa tarde|boa noite),?[ \\t]+(?:gente|pessoal|galera|meninas|meninos|turma|fam[íi]lia|amores|amigos|amigas)[ \\t]*(?:[!.,?:]+|(?=\\n)|$)" +
    "|(?:oi+e?|ol[áa]|e a[ií]|bom dia|boa tarde|boa noite)[ \\t]*[!.?]+)[ \\t]*\\n*", "iu");

// Hashtags que nao descrevem nada (caption.py, FILLER_TAGS, mais as equivalentes em portugues).
const GENERICAS = new Set(items(`viral|fyp|fy|fypage|explore|explorepage|explorar|foryou|foryoupage|trending|love|follow|followme
like4like|likeforlike|f4f|l4l|tiktok|tiktokviral|parati|paravoce|pravoce|viralizar|viraliza|viralvideo|instagood|instagram|reels|reelsinstagram`));

const HASHTAG = /#(?=[\p{N}_]*\p{L})[\p{L}\p{N}_]+/gu; // precisa ter letra: "#1" no meio do texto nao e hashtag
// Link: com http, com www ou dominio seguido de caminho. A palavra que apresenta o link ("em", "no", "acesse") sai junto.
const LINK = /(?:(?<![\p{L}\p{N}])(?:em|no|na|pelo|pela|via|acesse|link)[ \t]*:?[ \t]+)?(?:https?:\/\/[^\s]+|(?<![\p{L}\p{N}@])www\.[^\s]+|(?<![\p{L}\p{N}@.])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s]*)/giu;

type Notes = { fixes: Set<string>; trocas: Set<string>; cortes: Set<string> };

// Os caracteres especiais sao montados pelo codigo do caractere, nunca digitados: o arquivo nao carrega
// caractere invisivel nem travessao, e nenhum editor troca um escape por engano.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ZWJ = cp(0x200d), VS16 = cp(0xfe0f);                               // juncao e seletor de emoji
const SPACES = cp(0xa0, 0x202f, 0x2009, 0x2007, 0x2003, 0x2002);         // espacos que nao sao o espaco comum
const LONG_DASH = cp(0x2014, 0x2015), SHORT_DASH = cp(0x2013);           // travessao, barra horizontal e meia-risca
const QUOTE1 = cp(0x2018, 0x2019, 0x2032), QUOTE2 = cp(0x201c, 0x201d);  // aspas curvas
const ELLIPSIS = cp(0x2026), BULLET = cp(0x2022);
const CUT_CAP = cp(1), CUT_KEEP = cp(3);                                 // marcas internas do corte de frase
const RX = {
  zwj: new RegExp(`(?<!\\p{Extended_Pictographic}${VS16}?)${ZWJ}|${ZWJ}(?!\\p{Extended_Pictographic})`, "gu"),
  format: new RegExp(`(?!${ZWJ})\\p{Cf}`, "gu"),
  spaces: new RegExp(`[${SPACES}]`, "g"),
  longDash: new RegExp(`[ \\t]*[${LONG_DASH}][ \\t]*`, "g"),
  rangeDash: new RegExp(`(?<=\\d)[ \\t]*${SHORT_DASH}[ \\t]*(?=\\d)`, "g"),
  spacedDash: new RegExp(`[ \\t]+${SHORT_DASH}[ \\t]+`, "g"),
  shortDash: new RegExp(SHORT_DASH, "g"),
  quote1: new RegExp(`[${QUOTE1}]`, "g"),
  quote2: new RegExp(`[${QUOTE2}]`, "g"),
  ellipsis: new RegExp(ELLIPSIS, "g"),
  bullet: new RegExp(`^[ \\t]*${BULLET}[ \\t]*`, "gm"),
  sentenceStart: new RegExp(`(?:^|[\\n.!?:;])[ \\t"'(\\-${CUT_CAP}${CUT_KEEP}]*$`), // o trecho apagado abria uma frase, uma oracao ou um item de lista
  emoji: new RegExp(`\\p{Extended_Pictographic}(?:${VS16}?${ZWJ}\\p{Extended_Pictographic})*`, "gu"), // emoji composto conta um
  cutMark: new RegExp(`[${CUT_CAP}${CUT_KEEP}][ \\t]*[,;:.!?]*[ \\t]*(\\p{L})?`, "gu"),
};

// ---------- Passadas de texto ----------
// Caracteres que teclado nenhum produz. A juncao (ZWJ) fica quando esta dentro de um emoji composto.
function invisiveis(t: string, n: Notes): string {
  const out = t
    .replace(RX.zwj, "").replace(RX.format, "")
    .replace(/\p{Cc}/gu, (c: string) => (c === "\n" || c === "\r" || c === "\t" ? c : ""))
    .replace(RX.spaces, " ").replace(/\r\n?/g, "\n");
  if (out !== t) n.fixes.add("Caracteres invisíveis removidos.");
  return out;
}

function tipografia(t: string, n: Notes): string {
  let out = t;
  // Travessao, barra horizontal, meia-risca usada como travessao e dois hifens entre espacos viram virgula. Meia-risca entre numeros vira hifen.
  const dash = out.replace(RX.longDash, ", ").replace(RX.rangeDash, "-").replace(RX.spacedDash, ", ").replace(RX.shortDash, "-")
    .replace(/(?:[ \t]+--)+[ \t]+/g, ", ");
  if (dash !== out) {
    n.fixes.add("Travessão trocado por vírgula.");
    // A virgula nova nao pode ficar antes de outra pontuacao nem abrir ou fechar uma linha.
    out = dash.replace(/,[ \t]*([,.;:!?])/g, "$1").replace(/,[ \t]*\n/g, "\n").replace(/^[ \t]*,[ \t]*/gm, "").replace(/,[ \t]*$/, "");
  }
  const plain = out.replace(RX.quote1, "'").replace(RX.quote2, '"').replace(RX.ellipsis, "...").replace(RX.bullet, "- ");
  if (plain !== out) n.fixes.add("Aspas curvas, reticências e marcadores especiais trocados pelos caracteres comuns.");
  return plain;
}

// Limpeza segura para qualquer texto gerado (plano, roteiro, titulo): invisiveis e tipografia, sem mexer em palavras.
export function limpar(text: unknown): string {
  const n: Notes = { fixes: new Set(), trocas: new Set(), cortes: new Set() };
  let out = typeof text === "string" ? text : "";
  for (let i = 0; i < 5; i++) { // ate estabilizar: limpar duas vezes da o mesmo texto
    const next = tipografia(invisiveis(out, n), n).trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

// Corta no tamanho sem deixar meio emoji no fim (par substituto ou juncao solta).
export function clip(text: string, max: number): string {
  let cut = text.slice(0, Math.max(0, max));
  const tail = cut.charCodeAt(cut.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1);
  return cut.length < text.length ? limpar(cut) : cut;
}

// keep = chamada para acao e palavras que a marca usa: o que a propria marca escolheu nao e trocado nem cortado.
function lexico(t: string, n: Notes, keep: string): string {
  let out = t, cut = false;
  for (const e of LEXICO) {
    e.re.lastIndex = 0;
    if (keep && e.re.test(keep)) continue;
    out = out.replace(e.re, (m: string, offset: number, whole: string) => {
      if (e.to) {
        n.trocas.add(`"${e.find}" por "${e.to}"`);
        return m.length > 1 && m === m.toUpperCase() ? e.to.toUpperCase() : isUpper(m.charAt(0)) ? upperFirst(e.to) : e.to;
      }
      n.cortes.add(`"${e.find}"`); cut = true;
      // No comeco de frase, a marca leva junto a pontuacao que sobrou e devolve a maiuscula para a palavra seguinte.
      return RX.sentenceStart.test(whole.slice(0, offset)) ? (isUpper(m.charAt(0)) ? CUT_CAP : CUT_KEEP) : "";
    });
  }
  if (!cut) return out;
  return out
    .replace(RX.cutMark, (m: string, c?: string) => (!c ? "" : m.charAt(0) === CUT_CAP ? c.toUpperCase() : c))
    .replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])/g, "$1").replace(/,([,.;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "").replace(/^-$/gm, "").replace(/\n{3,}/g, "\n\n"); // item de lista que ficou vazio sai
}

function saudacao(t: string, n: Notes): string {
  const m = SAUDACAO.exec(t);
  if (!m) return t;
  n.fixes.add("Saudação removida do começo da legenda.");
  const rest = t.slice(m[0].length);
  return isUpper(m[0].trim().charAt(0)) ? upperFirst(rest) : rest;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  const ends = [...cut.matchAll(/[.!?](?=\s|$)/g)];
  const last = ends.length ? ends[ends.length - 1].index! + 1 : -1;
  const space = cut.search(/\s\S*$/);
  if (last >= max * 0.6) return cut.slice(0, last).trimEnd();
  if (space > 0) return cut.slice(0, space).trimEnd();
  return clip(cut, max); // texto sem espaco nenhum: corta no tamanho, sem partir um emoji
}

// ---------- Hashtags ----------
function hashtags(raw: string, moved: string[], n: Notes): string {
  const seen = new Set<string>(), out: string[] = [], generic: string[] = [];
  let repeated = false, invalid = false;
  for (const tok of [...raw.replace(/#+/g, " #").split(/[\s,;]+/), ...moved].filter(Boolean)) { // "#a#b" sao duas
    const body = tok.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!body || !/\p{L}/u.test(body)) { invalid = true; continue; } // so numero ou so simbolo nao e hashtag
    const tag = `#${body}`, key = tag.toLowerCase();
    if (GENERICAS.has(fold(body))) { generic.push(tag); continue; }
    if (seen.has(key)) { repeated = true; continue; }
    seen.add(key); out.push(tag);
  }
  if (generic.length) n.fixes.add(`Hashtags genéricas removidas: ${[...new Set(generic)].slice(0, 6).join(", ")}.`);
  if (repeated) n.fixes.add("Hashtags repetidas removidas.");
  if (invalid) n.fixes.add("Hashtags inválidas removidas (sem letra).");
  if (out.length > MAX_HASHTAGS) { out.length = MAX_HASHTAGS; n.fixes.add(`Hashtags cortadas para o limite de ${MAX_HASHTAGS} do Instagram.`); }
  if (out.join(" ").length > MAX_HASHTAG_CHARS) {
    while (out.join(" ").length > MAX_HASHTAG_CHARS) out.pop();
    n.fixes.add(`Hashtags cortadas para caber em ${MAX_HASHTAG_CHARS} caracteres.`);
  }
  return out.join(" ");
}

// ---------- Avisos que pedem julgamento humano (nao mudam o texto) ----------
const RISCOS: [RegExp, string][] = [
  [/\bgarantid[oa]s?\b|\bgarantimos\b|\bsem risco\b/iu, "promessa de garantia"],
  [/\bdinheiro f[aá]cil\b|\bsem esfor[cç]o\b|\bfique rico\b|\brenda extra garantida\b/iu, "promessa de ganho fácil"],
  [/\bmilagr\p{L}+|\bcura(?:r|m)?(?![\p{L}])/iu, "alegação de saúde"],
  [/\bemagre[cç]\p{L}*[ \t]+\d+[ \t]?kg\b|\bperca[ \t]+\d+[ \t]?kg\b/iu, "promessa de emagrecimento"],
  [/\bganhe?[ \t]+(?:r\$[ \t]?)?\d[\d.,]*|\bfature?[ \t]+(?:r\$[ \t]?)?\d[\d.,]*/iu, "promessa de faturamento"],
];
const ESTRUTURAS: [RegExp, string][] = [
  [/(?<![\p{L}])n[aã]o [eé] (?:s[óo]|apenas|somente|simplesmente) [^.!?\n]{2,60}[,.;][ \t]*(?:é|e sim|mas)(?![\p{L}])/iu, '"não é só X, é Y"'],
  [/(?<![\p{L}])(?:leve|levar|levando|levou) [^.!?\n]{2,40} ao pr[oó]ximo n[ií]vel/iu, '"leve X ao próximo nível"'],
  [/(?<![\p{L}])desempenh\p{L}+ um papel (?:crucial|fundamental|essencial|importante|central|vital)/iu, '"desempenha um papel crucial"'],
  [/(?<![\p{L}])[Cc]omo (?:uma? )?(?:IA|[Ii]ntelig[eê]ncia [Aa]rtificial|[Mm]odelo de [Ll]inguagem)(?![\p{L}])/u, "o texto fala de si como IA"],
  [/(?:concorda\?|o que voc[eê] acha\?|e voc[eê]\?)[ \t]*$/imu, "pergunta de engajamento por reflexo"],
];
const NUMERO = /R\$[ \t]?\d[\d.,]*|\d[\d.,]*[ \t]?%|\b\d[\d.,]*[ \t]?(?:mil|milh[õo]es|milh[ãa]o)\b|\b\d[\d.,]*[ \t]+(?:clientes|alunos|alunas|pacientes|pessoas|seguidores|vendas|pedidos|empresas|anos de)\b/giu;
const digits = (s: string) => (s.match(/\d[\d.,]*/g) ?? []).map((x) => x.replace(/[.,]+$/, ""));

const termos = (s: unknown) => (typeof s === "string" ? s : "").split(/[,;\n]+/).map((t) => t.trim().replace(/^["']+|["'.]+$/g, ""))
  .filter((t) => t.length >= 3 && t.split(/\s+/).length <= 4).slice(0, 40);

function avisos(legenda: string, profile: AgentProfile, out: string[]) {
  if (!legenda) return;
  if (/\{\{[^}]*\}\}|\[(?:inserir|preencher|seu |sua )[^\]]*\]/iu.test(legenda)) out.push("Revisar: a legenda tem um marcador para preencher. Complete antes de aprovar.");
  // Numero que nao esta nas provas nem no contexto da marca pode ter sido inventado.
  const known = new Set(digits(`${profile.voice?.provas ?? ""} ${profile.context ?? ""} ${profile.audience ?? ""}`));
  const loose = [...new Set((legenda.match(NUMERO) ?? []).filter((m) => digits(m).some((d) => !known.has(d))).map((m) => m.trim().replace(/[.,]+$/, "")))];
  if (loose.length) out.push(`Revisar: número sem prova cadastrada no perfil (${loose.slice(0, 4).map((x) => `"${x}"`).join(", ")}). Confira antes de aprovar.`);
  for (const [re, why] of RISCOS) { const m = re.exec(legenda); if (m) out.push(`Revisar: possível ${why} ("${m[0].trim()}").`); }
  const flat = fold(legenda);
  const has = (t: string) => new RegExp(`(?<![a-z0-9_])${esc(fold(t)).replace(/ +/g, "\\s+")}(?![a-z0-9_])`).test(flat);
  const evita = termos(profile.voice?.evita).filter(has), proibido = termos(profile.voice?.proibido).filter(has);
  const quoted = (list: string[]) => list.slice(0, 5).map((t) => `"${t}"`).join(", ");
  if (evita.length) out.push(`Revisar: a legenda usa ${quoted(evita)}, da lista de palavras que a marca evita.`);
  if (proibido.length) out.push(`Revisar: a legenda cita ${quoted(proibido)}, da lista de temas proibidos da marca.`);
  for (const [re, name] of ESTRUTURAS) if (re.test(legenda)) out.push(`Revisar: estrutura com cara de IA (${name}).`);
  if (legenda.trimStart().startsWith("@")) out.push("Revisar: a legenda abre com uma menção. A primeira linha deveria ser o gancho.");
  const emoji = (legenda.match(RX.emoji) ?? []).length;
  if (emoji >= 3 && emoji * 100 / legenda.length > 4) out.push(`Revisar: muitos emojis para o tamanho da legenda (${emoji}).`);
}

// ---------- Revisao da copy ----------
export function reviewCopy(copy: Copy, profile: AgentProfile): Copy {
  const n: Notes = { fixes: new Set(), trocas: new Set(), cortes: new Set() };
  let titulo = typeof copy?.titulo === "string" ? copy.titulo : "";
  for (let i = 0; i < 5; i++) { // uma linha so, limpa e no tamanho do cartao; repete ate estabilizar
    const next = clip(limpar(titulo).replace(/\s+/g, " ").trim(), MAX_TITLE);
    if (next === titulo) break;
    titulo = next;
  }
  let legenda = typeof copy?.legenda === "string" ? copy.legenda : "";
  const moved: string[] = [];
  const keep = `${profile?.voice?.cta ?? ""}\n${profile?.voice?.usa ?? ""}`.trim();
  // Repete ate estabilizar: uma troca pode expor outra, e o revisor precisa dar o mesmo resultado na segunda vez.
  for (let i = 0; i < 5; i++) {
    // Link e hashtag saem antes do lexico: um corte de frase nao pode partir um endereco ao meio.
    let next = tipografia(invisiveis(legenda, n), n);
    const links = next.match(LINK);
    if (links) {
      n.fixes.add("Link removido da legenda: o link da marca entra no fim do post, pelo sistema.");
      next = next.replace(LINK, (m: string) => m.match(/[.,;:!?)]+$/)?.[0] ?? "");
    }
    const tags = next.match(HASHTAG);
    if (tags) {
      moved.push(...tags);
      n.fixes.add("Hashtags tiradas do meio da legenda e levadas para o campo de hashtags.");
      next = next.replace(HASHTAG, "");
    }
    if (links || tags) next = next.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])/g, "$1").replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "");
    next = saudacao(lexico(next, n, keep), n).replace(/\n{3,}/g, "\n\n").trim();
    if (next === legenda) break;
    legenda = next;
  }
  const tags = hashtags(limpar(copy?.hashtags), moved, n);
  // Legenda, link e hashtags saem juntos no post: os tres precisam caber no limite da rede.
  const size = (text: string) => composeCaption({ caption: text, hashtags: tags, link_url: profile?.default_link ?? null }).length;
  if (size(legenda) > MAX_CAPTION) {
    legenda = truncate(legenda, MAX_CAPTION - (size(legenda) - legenda.length));
    n.fixes.add("Legenda encurtada para caber em 2.200 caracteres junto com o link e as hashtags.");
  }
  const novos = [...n.fixes];
  if (n.trocas.size) novos.push(`Palavras com cara de IA trocadas: ${[...n.trocas].join("; ")}.`);
  if (n.cortes.size) novos.push(`Frases com cara de IA removidas: ${[...n.cortes].join("; ")}.`);
  avisos(legenda, profile, novos);
  const antes = (Array.isArray(copy?.alertas) ? copy.alertas : []).map(limpar).filter(Boolean); // avisos do gerador, limpos como o resto
  return { titulo, legenda, hashtags: tags, alertas: [...new Set([...antes, ...novos])] };
}
