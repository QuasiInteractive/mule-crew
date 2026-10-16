// Artwork facts measured in code, and the proof preview the model looks at.
// Anything a number can settle (resolution, transparency, sharpness, contrast)
// is measured here, so the model's eyes are only needed for what code can't see.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export type ArtworkLimits = { min_dpi: number; min_sharpness: number; min_contrast: number; max_safe_zone_ink_pct: number };

export type ArtworkFacts = ArtworkLimits & {
  width_px: number;
  height_px: number;
  dpi_at_order_size: number;
  has_transparent_background: boolean;
  // Steepest edges relative to the design's tonal range: ~1 for crisp artwork,
  // far lower for a small image that was blown up.
  sharpness: number;
  // WCAG contrast ratio between the darkest and lightest parts of the design.
  contrast_ratio: number;
  // Share of the safe zone (the 1/8 inch inside the cut line) covered by ink
  // rather than the design's base colour. Text there gets sliced or crowded.
  // Null when there is no transparency, so no cut line to measure from.
  safe_zone_ink_pct: number | null;
};

// sRGB channel to linear light, for WCAG relative luminance.
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

export function measureArtwork(path: string, widthIn: number, heightIn: number, limits: ArtworkLimits): ArtworkFacts {
  const png = PNG.sync.read(readFileSync(path));
  const { width, height, data } = png;
  // A die-cut sticker is cut around the artwork, so the area around it must be
  // transparent. If nearly every pixel on the outer border is opaque, the
  // customer left a background in and the cut would follow that box.
  let border = 0, opaque = 0;
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];
  for (let x = 0; x < width; x++) { border += 2; opaque += +(alpha(x, 0) > 250) + +(alpha(x, height - 1) > 250); }
  for (let y = 0; y < height; y++) { border += 2; opaque += +(alpha(0, y) > 250) + +(alpha(width - 1, y) > 250); }

  // Luminance and neighbour-to-neighbour steps over the opaque artwork only.
  const Y = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) Y[i] = 0.2126 * lin(data[i * 4]) + 0.7152 * lin(data[i * 4 + 1]) + 0.0722 * lin(data[i * 4 + 2]);
  const ys: number[] = [], steps: number[] = [];
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const i = y * width + x;
    if (data[i * 4 + 3] < 250 || data[(i + 1) * 4 + 3] < 250 || data[(i + width) * 4 + 3] < 250) continue;
    ys.push(Y[i]);
    steps.push(Math.max(Math.abs(Y[i] - Y[i + 1]), Math.abs(Y[i] - Y[i + width])));
  }
  ys.sort((a, b) => a - b); steps.sort((a, b) => a - b);
  const q = (a: number[], f: number) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : 0;
  // Ignore the extreme half-percent at each end so a few stray pixels don't count.
  const dark = q(ys, 0.005), light = q(ys, 0.995);

  return {
    safe_zone_ink_pct: safeZoneInk(data, width, height, Math.round(width / widthIn / 8)),
    width_px: width,
    height_px: height,
    dpi_at_order_size: Math.round(Math.min(width / widthIn, height / heightIn)),
    has_transparent_background: opaque / border < 0.9,
    sharpness: Number((q(steps, 0.999) / Math.max(1e-6, light - dark)).toFixed(3)),
    contrast_ratio: Number(((light + 0.05) / (dark + 0.05)).toFixed(2)),
    ...limits,
  };
}

// The cut line is where the artwork meets transparency. Walk inward from it up
// to `margin` pixels (1/8 inch) and count pixels that aren't the base colour.
function safeZoneInk(data: Buffer, w: number, h: number, margin: number): number | null {
  const n = w * h;
  // Base colour = the most common opaque colour, quantised to 5 bits a channel.
  const hist = new Map<number, number>();
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] > 250) {
    const k = (data[i * 4] >> 3) << 10 | (data[i * 4 + 1] >> 3) << 5 | data[i * 4 + 2] >> 3;
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let top = 0, key = 0;
  for (const [k, v] of hist) if (v > top) { top = v; key = k; }
  const base = [(key >> 10) << 3, ((key >> 5) & 31) << 3, (key & 31) << 3];
  // Breadth-first distance from the nearest transparent pixel, capped at margin.
  const dist = new Int32Array(n).fill(-1), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) { dist[i] = 0; queue[tail++] = i; }
  if (tail === 0) return null;
  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= margin) continue;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j >= 0 && j < n && dist[j] < 0) { dist[j] = dist[i] + 1; queue[tail++] = j; }
    }
  }
  let zone = 0, ink = 0;
  for (let i = 0; i < n; i++) if (dist[i] > 0 && data[i * 4 + 3] > 250) {
    zone++;
    if (Math.abs(data[i * 4] - base[0]) + Math.abs(data[i * 4 + 1] - base[1]) + Math.abs(data[i * 4 + 2] - base[2]) > 60) ink++;
  }
  return zone ? Number((ink / zone * 100).toFixed(2)) : null;
}

// The issues the numbers alone settle. The model may add to these, never drop them.
export function measuredIssues(f: ArtworkFacts) {
  const out: string[] = [];
  if (f.dpi_at_order_size < f.min_dpi) out.push('low_resolution');
  if (!f.has_transparent_background) out.push('background_not_removed');
  if (f.sharpness < f.min_sharpness) out.push('upscaled_blurry');
  if (f.contrast_ratio < f.min_contrast) out.push('low_contrast');
  if (f.safe_zone_ink_pct !== null && f.safe_zone_ink_pct > f.max_safe_zone_ink_pct) out.push('text_near_edge');
  return out;
}

// What a proofing screen shows: the artwork over a checkerboard (so transparency
// is visible) at a size the model can take in, as a PNG data URL.
export function proofPreview(path: string, maxPx = 768): string {
  const src = PNG.sync.read(readFileSync(path));
  const k = Math.max(1, Math.ceil(Math.max(src.width, src.height) / maxPx));
  const w = Math.floor(src.width / k), h = Math.floor(src.height / k);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Box-average the k*k block, then composite over the checkerboard.
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
        const i = ((y * k + dy) * src.width + (x * k + dx)) * 4;
        const al = src.data[i + 3] / 255;
        r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al; a += al;
      }
      const n = k * k, cover = a / n;
      const check = ((x >> 4) + (y >> 4)) % 2 ? 205 : 245;
      const o = (y * w + x) * 4;
      out.data[o] = Math.round(r / n + check * (1 - cover));
      out.data[o + 1] = Math.round(g / n + check * (1 - cover));
      out.data[o + 2] = Math.round(b / n + check * (1 - cover));
      out.data[o + 3] = 255;
    }
  }
  return 'data:image/png;base64,' + PNG.sync.write(out).toString('base64');
}
