// Story em 9:16: o Instagram mostra o story em tela cheia vertical (1080x1920). Uma imagem 4:5 ou quadrada
// publicada como story fica fora de proporcao. Aqui a imagem inteira e centralizada no quadro 9:16, sem
// cortar nada. As faixas que sobram continuam a cor da borda da arte quando a borda e lisa (arte desenhada);
// quando a borda varia (foto), recebem a propria imagem ampliada, bem desfocada e escurecida.
import { Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import jpeg from "npm:jpeg-js@0.4.4";

export const STORY_W = 1080, STORY_H = 1920;
const BLUR_W = 12;              // fundo renderizado bem pequeno (12x21) e ampliado: o desfoque sai de graca
const DARKEN = 0.5;             // fundo de foto mais escuro que a arte, para a arte se destacar
const FLAT_STD = 14;            // desvio padrao maximo da cor da borda para considerar a borda lisa
const TOLERANCE = 0.02;         // ate 2% de faixa vazia a imagem ja e considerada 9:16

export function imageType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

const frame = (href: string, mode: "meet" | "slice") =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${STORY_W}" height="${STORY_H}" viewBox="0 0 ${STORY_W} ${STORY_H}">` +
  `<image x="0" y="0" width="${STORY_W}" height="${STORY_H}" preserveAspectRatio="xMidYMid ${mode}" xlink:href="${href}"/></svg>`;

export type Fitted = { fitted: false; reason: string } | { fitted: true; jpeg: Uint8Array; band: number; ms: Record<string, number> };

// Recebe os bytes da imagem original e devolve o JPEG 1080x1920, ou fitted=false quando ja e 9:16.
export function fitStory(bytes: Uint8Array, quality = 90): Fitted {
  const type = imageType(bytes);
  if (!type) throw new Error("Formato de imagem não reconhecido. Use JPEG, PNG, GIF ou WebP.");
  const href = `data:${type};base64,${base64(bytes)}`;
  const t0 = performance.now();
  const fg = new Resvg(frame(href, "meet"), { fitTo: { mode: "width", value: STORY_W } }).render();
  const t1 = performance.now();
  if (fg.width !== STORY_W || fg.height !== STORY_H) throw new Error("A renderização do story saiu com tamanho inesperado.");
  const px = fg.pixels;
  // Quanto do quadro ficou vazio (alfa zero). Sem nenhum pixel desenhado, o formato nao foi lido.
  let empty = 0;
  for (let i = 3; i < px.length; i += 4 * 9) if (px[i] === 0) empty++;
  const band = empty / Math.ceil(px.length / (4 * 9));
  if (band > 0.999) throw new Error(`Não foi possível ler a imagem (${type}).`);
  if (band <= TOLERANCE) return { fitted: false, reason: "A imagem já está em 9:16." };
  const bg = new Resvg(frame(href, "slice"), { fitTo: { mode: "width", value: BLUR_W } }).render();
  const t2 = performance.now();
  const bw = bg.width, bh = bg.height, bp = bg.pixels;
  const W = STORY_W, H = STORY_H, cx = W >> 1, cy = H >> 1;
  const opaque = (x: number, y: number) => px[(y * W + x) * 4 + 3] > 250;
  // Limites da arte dentro do quadro (o que sobra em volta sao as faixas).
  let top = 0, bottom = H - 1, left = 0, right = W - 1;
  while (top < H - 1 && !opaque(cx, top)) top++;
  while (bottom > 0 && !opaque(cx, bottom)) bottom--;
  while (left < W - 1 && !opaque(left, cy)) left++;
  while (right > 0 && !opaque(right, cy)) right--;
  // Cor media e variacao de uma linha ou coluna da borda da arte.
  const edge = (fixed: number, from: number, to: number, horizontal: boolean): number[] | null => {
    const sum = [0, 0, 0], sq = [0, 0, 0]; let n = 0;
    for (let k = from; k <= to; k += 2) {
      const o = (horizontal ? fixed * W + k : k * W + fixed) * 4;
      for (let c = 0; c < 3; c++) { sum[c] += px[o + c]; sq[c] += px[o + c] * px[o + c]; }
      n++;
    }
    if (!n) return null;
    const mean = sum.map((v) => v / n), std = Math.max(...sq.map((v, c) => Math.sqrt(Math.max(0, v / n - mean[c] * mean[c]))));
    return std <= FLAT_STD ? mean : null;
  };
  const fill = {
    top: top > 0 ? edge(Math.min(top + 2, bottom), left, right, true) : null,
    bottom: bottom < H - 1 ? edge(Math.max(bottom - 2, top), left, right, true) : null,
    left: left > 0 ? edge(Math.min(left + 2, right), top, bottom, false) : null,
    right: right < W - 1 ? edge(Math.max(right - 2, left), top, bottom, false) : null,
  };
  const out = new Uint8Array(W * H * 4);
  const sx = bw / W, sy = bh / H, back = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, a = px[o + 3] / 255;
      out[o + 3] = 255;
      if (a === 1) { out[o] = px[o]; out[o + 1] = px[o + 1]; out[o + 2] = px[o + 2]; continue; }
      // Faixa lisa: continua a cor da borda. Senao, fundo desfocado (amostragem bilinear do quadro pequeno).
      const flat = y < top ? fill.top : y > bottom ? fill.bottom : x < left ? fill.left : x > right ? fill.right : null;
      if (flat) { back[0] = flat[0]; back[1] = flat[1]; back[2] = flat[2]; }
      else {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), wx = fx - x0;
        const i00 = (y0 * bw + x0) * 4, i01 = (y0 * bw + x1) * 4, i10 = (y1 * bw + x0) * 4, i11 = (y1 * bw + x1) * 4;
        for (let c = 0; c < 3; c++) {
          const t = bp[i00 + c] * (1 - wx) + bp[i01 + c] * wx, b = bp[i10 + c] * (1 - wx) + bp[i11 + c] * wx;
          back[c] = (t * (1 - wy) + b * wy) * DARKEN;
        }
      }
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(px[o + c] * a + back[c] * (1 - a));
    }
  }
  const t3 = performance.now();
  const enc = jpeg.encode({ data: out, width: W, height: H }, quality);
  const t4 = performance.now();
  return { fitted: true, jpeg: enc.data, band: Math.round(band * 1000) / 1000, ms: { quadro: Math.round(t1 - t0), fundo: Math.round(t2 - t1), composicao: Math.round(t3 - t2), jpeg: Math.round(t4 - t3) } };
}
