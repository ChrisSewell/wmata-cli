// Renders the Predictions hero numeral (the soonest ETA) to a canvas and
// encodes it as PNG bytes for `updateImageRawData`. White-on-black: the SDK
// quantizes to 4-bit grey + colorizes to green, and level-0 (black) is
// transparent, so the result is a bright-green numeral over the see-through
// world. Numeric tokens use the big dot-matrix font + a "MIN" caption; letter
// tokens (ARR/BRD) use a bold canvas font.

import { drawDotString, dotStringWidth, GLYPH_ROWS, isDotDrawable } from "../accent/dotfont";

/** Largest dot `step` (dot = step-1, gap = 1) whose glyphs fit `maxW`×`maxH`. */
function fitStep(token: string, maxW: number, maxH: number): number {
  for (let step = Math.floor(maxH / GLYPH_ROWS); step >= 3; step--) {
    const dot = Math.max(2, step - 1);
    const gap = step - dot;
    if (dotStringWidth(token, { dot, gap }) <= maxW) return step;
  }
  return 3;
}

const SANS = "-apple-system, BlinkMacSystemFont, system-ui, sans-serif";

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
    // Bold dot-matrix numeral + a small "MIN" caption beneath it.
    const marginBottom = 8;
    const captionSize = Math.round(h * 0.15);
    const captionTop = h - marginBottom - captionSize;
    const numZoneH = captionTop - 8;
    const step = fitStep(token, w * 0.9, numZoneH);
    const dot = Math.max(2, step - 1);
    const gap = step - dot;
    const nw = dotStringWidth(token, { dot, gap });
    const nh = GLYPH_ROWS * step;
    const x = Math.round((w - nw) / 2);
    const top = Math.max(2, Math.round((numZoneH - nh) / 2));
    drawDotString(ctx, token, x, top, { dot, gap, color: "#ffffff" });

    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${captionSize}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // Spaced caps read better at this size.
    ctx.fillText("M I N", Math.round(w / 2), h - marginBottom);
  } else {
    // Letters (ARR / BRD) — bold canvas font, shrunk to fit the width.
    let size = Math.round(h * 0.46);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${size}px ${SANS}`;
    while (ctx.measureText(token).width > w * 0.88 && size > 12) {
      size -= 2;
      ctx.font = `700 ${size}px ${SANS}`;
    }
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
