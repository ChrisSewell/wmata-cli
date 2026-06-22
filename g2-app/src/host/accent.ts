// Renders the Predictions hero numeral (the soonest ETA) to a canvas and
// encodes it as PNG bytes for `updateImageRawData`. White-on-black: the SDK
// quantizes to 4-bit grey + colorizes to green, and level-0 (black) is
// transparent, so the result is a bright-green numeral over the see-through
// world. Numeric tokens use the dot-matrix font; letter tokens (ARR/BRD) use a
// bold canvas font.

import { drawDotString, dotStringWidth, GLYPH_ROWS, isDotDrawable } from "../accent/dotfont";

/** Draw `token` big and centered in a w×h canvas (black bg, white fg). */
export function renderHeroCanvas(token: string, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (!token) return c;

  if (isDotDrawable(token)) {
    // Size the dot grid to ~62% of the canvas height.
    const step = Math.max(3, Math.floor((h * 0.62) / GLYPH_ROWS));
    const dot = Math.max(2, step - 2);
    const gap = step - dot;
    const width = dotStringWidth(token, { dot, gap });
    const x = Math.round((w - width) / 2);
    const top = Math.round((h - GLYPH_ROWS * step) / 2);
    drawDotString(ctx, token, x, top, { dot, gap, color: "#ffffff" });
  } else {
    const size = Math.floor(h * 0.42);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${size}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(token, Math.round(w / 2), Math.round(h / 2));
  }
  return c;
}

/** Encode a canvas to PNG bytes (the SDK decodes/quantizes/recolors). */
export async function encodePng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** Render + encode in one step. */
export async function encodeHero(token: string, w: number, h: number): Promise<Uint8Array> {
  return encodePng(renderHeroCanvas(token, w, h));
}
