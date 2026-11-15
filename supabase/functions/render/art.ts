// Arte por template: monta a imagem do post a partir do texto e das cores da marca, sem servico externo.
// Layout com satori (flexbox e quebra de linha com a metrica real da fonte), raster com resvg e saida em JPEG,
// que e o formato aceito pelo Instagram e pelos posts de foto do TikTok.
import satori from "npm:satori@0.12.1";
import { Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import jpeg from "npm:jpeg-js@0.4.4";

export type Brand = { tema?: string; fundo?: string; texto?: string; destaque?: string; assinatura?: string };
export type Spec = {
  size: "4:5" | "9:16";
  layout: "capa" | "conteudo" | "cta";
  brand?: Brand;
  kicker?: string;   // rotulo curto acima do titulo (pilar)
  titulo: string;
  texto?: string;    // paragrafo de apoio
  itens?: string[];  // lista curta (ate 4), vira cartoes numerados
  rodape?: string;   // frase final ou chamada
  pagina?: string;   // "2/7" no carrossel
  dica?: string;     // ex.: "Arraste para o lado"
};
export type FontData = { name: string; weight: 400 | 500 | 700 | 900; style: "normal"; data: ArrayBuffer };

type Palette = { bg: string; fg: string; muted: string; card: string; accent: string; onAccent: string; line: string };
const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const luma = (h: string) => { const [r, g, b] = rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

const THEMES: Record<string, { fundo: string; texto: string; destaque: string }> = {
  noite: { fundo: "#0F172A", texto: "#F8FAFC", destaque: "#34D399" },
  claro: { fundo: "#F4F7FA", texto: "#0B0F14", destaque: "#D9480F" },
  areia: { fundo: "#F6EFE6", texto: "#2B1D12", destaque: "#B4530B" },
  grafite: { fundo: "#16181D", texto: "#F3F4F6", destaque: "#FFA070" },
};

export function palette(b: Brand = {}): Palette {
  const base = THEMES[b.tema ?? ""] ?? THEMES.noite;
  const bg = HEX.test(b.fundo ?? "") ? b.fundo! : base.fundo;
  let fg = HEX.test(b.texto ?? "") ? b.texto! : base.texto;
  // Texto sem contraste com o fundo fica ilegivel: nesse caso usa preto ou branco.
  if (Math.abs(luma(bg) - luma(fg)) < 0.45) fg = luma(bg) > 0.5 ? "#0B0F14" : "#F8FAFC";
  let accent = HEX.test(b.destaque ?? "") ? b.destaque! : base.destaque;
  if (Math.abs(luma(bg) - luma(accent)) < 0.18) accent = fg;
  return {
    bg, fg, accent, muted: mix(fg, bg, 0.42), card: mix(bg, fg, 0.09), line: mix(bg, fg, 0.2),
    onAccent: luma(accent) > 0.55 ? "#0B0F14" : "#FFFFFF",
  };
}

// As fontes cobrem o alfabeto latino. Emoji e outros alfabetos sao removidos para nao virar quadrado vazio.
const ALLOWED = /[^ -~ -ÿıŒœ‐-―‘-„•…€™↑↓−]/g;
export function clean(v: unknown, max: number): string {
  let s = typeof v === "string" ? v : "";
  s = s.replace(/\s*[—–]\s*/g, ", ").replace(ALLOWED, "").replace(/[ \t]+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/[\s,.;:]+\S*$/, "") + "…";
  return s;
}

type Node = { type: string; props: { style: Record<string, unknown>; children?: unknown } };
const h = (style: Record<string, unknown>, children?: unknown): Node => ({ type: "div", props: { style: { display: "flex", ...style }, children } });
const pick = (len: number, steps: [number, number][], last: number) => { for (const [max, size] of steps) if (len <= max) return size; return last; };

export function tree(spec: Spec): { node: Node; width: number; height: number } {
  const story = spec.size === "9:16";
  const W = 1080, H = story ? 1920 : 1350;
  const p = palette(spec.brand);
  const sign = clean(spec.brand?.assinatura, 40);
  const kicker = clean(spec.kicker, 44).toUpperCase();
  const titulo = clean(spec.titulo, 140) || " ";
  const texto = clean(spec.texto, 320);
  const itens = (spec.itens ?? []).map((i) => clean(i, 96)).filter(Boolean).slice(0, spec.layout === "capa" ? 4 : 5);
  const rodape = clean(spec.rodape, 90);
  const pagina = clean(spec.pagina, 8);
  const dica = clean(spec.dica, 30);
  // No story, o topo e a base ficam livres: a interface do Instagram cobre essas faixas.
  const padTop = story ? 250 : 84, padBottom = story ? 330 : 84, padX = 88;
  const top = h({ justifyContent: "space-between", alignItems: "center", fontFamily: "Mono", fontWeight: 500, fontSize: 30, color: p.fg }, [
    h({}, sign || " "), pagina ? h({ color: p.muted, fontSize: 28 }, pagina) : h({}, " "),
  ]);
  const cards = (size: number) => h({ flexDirection: "column", gap: 20, marginTop: 44 }, itens.map((t, i) =>
    h({ alignItems: "center", backgroundColor: p.card, borderRadius: 24, padding: "24px 30px", fontSize: t.length > 44 ? size - 4 : size, fontWeight: 700, lineHeight: 1.25 }, [
      h({ width: 56, height: 56, borderRadius: 28, backgroundColor: p.fg, color: p.bg, alignItems: "center", justifyContent: "center", marginRight: 24, fontSize: 30, fontWeight: 900, flexShrink: 0 }, String(i + 1)),
      h({ flex: 1 }, t)])));
  const foot = (rodape || dica) ? h({ marginTop: "auto", justifyContent: "space-between", alignItems: "flex-end", fontSize: 32, fontWeight: 700, color: p.muted, lineHeight: 1.3 }, [
    h({ flex: 1, paddingRight: 24 }, rodape || " "),
    dica ? h({ color: p.accent, fontSize: 28, flexShrink: 0 }, dica) : h({}, " "),
  ]) : h({ marginTop: "auto" }, " ");
  const root: Record<string, unknown> = {
    width: W, height: H, flexDirection: "column", backgroundColor: p.bg, color: p.fg, fontFamily: "Inter",
    paddingTop: padTop, paddingBottom: padBottom, paddingLeft: padX, paddingRight: padX,
  };
  let body: unknown[];
  if (spec.layout === "cta") {
    const size = pick(titulo.length, [[26, 100], [44, 84], [70, 70]], 58);
    body = [top, h({ flex: 1, flexDirection: "column", justifyContent: "center" }, [
      kicker ? h({ fontSize: 30, fontWeight: 700, color: p.accent, letterSpacing: 1 }, kicker) : null,
      h({ marginTop: 18, fontSize: size, fontWeight: 900, lineHeight: 1.08, letterSpacing: -2 }, titulo),
      texto ? h({ marginTop: 26, fontSize: 40, color: p.muted, lineHeight: 1.3 }, texto) : null,
      rodape ? h({ marginTop: 48, alignSelf: "flex-start", backgroundColor: p.accent, color: p.onAccent, borderRadius: 999, padding: "22px 40px", fontSize: 36, fontWeight: 700 }, rodape) : null,
    ].filter(Boolean))];
  } else if (spec.layout === "conteudo") {
    const size = pick(titulo.length, [[30, 84], [55, 72], [80, 60]], 52);
    body = [top,
      kicker ? h({ marginTop: 70, fontSize: 28, fontWeight: 700, color: p.accent, letterSpacing: 1 }, kicker) : h({ marginTop: 50 }, " "),
      h({ marginTop: 16, fontSize: size, fontWeight: 900, lineHeight: 1.1, letterSpacing: -1.5 }, titulo),
      texto ? h({ marginTop: 30, fontSize: texto.length > 180 ? 38 : 44, color: p.fg, lineHeight: 1.36 }, texto) : null,
      itens.length ? cards(34) : null,
      foot].filter(Boolean);
  } else {
    const size = pick(titulo.length, [[28, 104], [45, 92], [70, 78], [100, 64]], 54);
    body = [top,
      kicker ? h({ marginTop: story ? 60 : 96, fontSize: 30, fontWeight: 700, color: p.accent, letterSpacing: 1 }, kicker) : h({ marginTop: 60 }, " "),
      h({ marginTop: 18, fontSize: size, fontWeight: 900, lineHeight: 1.08, letterSpacing: -2 }, titulo),
      texto ? h({ marginTop: 26, fontSize: 40, color: p.muted, lineHeight: 1.3 }, texto) : null,
      itens.length ? cards(36) : null,
      foot].filter(Boolean);
  }
  return { node: h(root, body), width: W, height: H };
}

export type Rendered = { jpeg: Uint8Array; width: number; height: number; ms: { layout: number; raster: number; jpeg: number } };

export async function renderJpeg(spec: Spec, fonts: FontData[], quality = 88): Promise<Rendered> {
  const t0 = performance.now();
  const { node, width, height } = tree(spec);
  const svg = await satori(node as never, { width, height, fonts });
  const t1 = performance.now();
  const r = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
  const t2 = performance.now();
  const out = jpeg.encode({ data: r.pixels, width: r.width, height: r.height }, quality);
  const t3 = performance.now();
  return { jpeg: out.data, width: r.width, height: r.height, ms: { layout: Math.round(t1 - t0), raster: Math.round(t2 - t1), jpeg: Math.round(t3 - t2) } };
}
