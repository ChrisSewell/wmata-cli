// Pure layout math shared by the host (builds containers) and screens (size
// text to fit). No SDK, no DOM. All widths come from `./measure` (pretext) —
// never character counts. Pixel values here are tuned in the simulator review
// loop; this module is the single place they live.

import { WIDTH, HEIGHT, LINE_HEIGHT, BORDER_W } from "./geometry";
import { maxWidth, wrapInfo } from "./measure";

// --- Container insets (shared by the host renderer and screens) -----------
// Padding for the header / body boxes. Kept small so the INNER height clears
// the 27px line height (a container whose inner height < 27 sprouts an
// auto-scrollbar). Total inset = border + padding.
export const HEADER_PAD = 4;
export const BODY_PAD = 8;
export const BODY_INSET = BORDER_W + BODY_PAD;
export const HEADER_INSET = BORDER_W + HEADER_PAD;
/** Worst-case clock cell width (e.g. "12:00p **") + slop — reserved top-right. */
export const CLOCK_RESERVE_PX = 96;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Standard page rectangles every screen shares: a bordered header box (title
 *  left, clock/status right), a bordered body box (the content + event
 *  capturer), and a borderless hint line at the bottom. The two boxes ARE the
 *  visible frame (House native chrome: header box brighter than body box). */
export interface PageRects {
  header: Rect;
  body: Rect;
  hint: Rect;
  /** Left inset for the header title / right region for the clock. */
  headerPadX: number;
}

const MARGIN = 6; // keep the rounded borders off the extreme panel edge
// Single-line boxes are sized so their INNER height clears the 27px firmware
// line height (else the firmware draws an auto-scrollbar): header inner = 44 −
// 2·(border 2 + pad 4) = 32; the borderless hint inner = its full 30px.
const HEADER_H = 44;
const HINT_H = 30;
const GAP = 6;

export function pageRects(): PageRects {
  const innerW = WIDTH - MARGIN * 2;
  const bodyY = MARGIN + HEADER_H + GAP;
  const hintY = HEIGHT - MARGIN - HINT_H;
  return {
    header: { x: MARGIN, y: MARGIN, w: innerW, h: HEADER_H },
    body: { x: MARGIN, y: bodyY, w: innerW, h: hintY - GAP - bodyY },
    hint: { x: MARGIN + 8, y: hintY, w: WIDTH - (MARGIN + 8) * 2, h: HINT_H },
    headerPadX: 12,
  };
}

/** The body box's text area (width/height), for pagination. */
export function bodyInnerBox(): { width: number; height: number } {
  const { body } = pageRects();
  return { width: body.w - BODY_INSET * 2, height: body.h - BODY_INSET * 2 };
}

/** Paginate text to fill the body box — the page split used by paged screens. */
export function paginateBody(text: string): string[] {
  const inner = bodyInnerBox();
  return paginate(text, { width: inner.width, height: inner.height });
}

/** Inset a rect by uniform padding + border on all four sides (the text area
 *  of a container, where `paddingLength`/`borderWidth` eat into the box). */
export function innerBox(rect: Rect, padding: number, border = 0): Rect {
  const inset = padding + border;
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    w: Math.max(0, rect.w - inset * 2),
    h: Math.max(0, rect.h - inset * 2),
  };
}

/** How many 27px rows fit in an inner height. */
export function maxLines(innerHeight: number): number {
  return Math.max(0, Math.floor(innerHeight / LINE_HEIGHT));
}

export interface ValueColumn {
  /** Left x of the value-overlay container (its values left-align here). */
  valueX: number;
  /** Width reserved for the value column. */
  valueW: number;
  /** Max pixel width left content may occupy before it would collide. */
  leftW: number;
}

/**
 * Compute a fixed-x value column inside `[innerLeft, innerRight]`, sized to the
 * WORST-CASE value (a reserve) — never the current frame's values — because
 * container geometry is committed at page creation and can't change on a text
 * upgrade. Every value line then shares `valueX` regardless of the
 * variable-width left content: alignment by position, the cardinal-sin fix.
 */
export function computeValueColumn(
  innerLeft: number,
  innerRight: number,
  reserveValues: readonly string[],
  gap = 12,
): ValueColumn {
  const SLOP = 6; // a few px so a measured value never clips its container
  const valueW = Math.ceil(maxWidth(reserveValues)) + SLOP;
  const valueX = innerRight - valueW;
  const leftW = Math.max(0, valueX - gap - innerLeft);
  return { valueX, valueW, leftW };
}

export interface PaginateBox {
  width: number;
  height: number;
}

/**
 * Split long text into page-sized chunks using pretext's pixel-accurate wrap
 * (27px lines), filling each page without clipping. Pass the container's INNER
 * box. Paragraph-aware with a greedy-token fallback for an over-long paragraph.
 * Adapted from House `native/paginate.ts`.
 */
export function paginate(source: string, box: PaginateBox): string[] {
  const limit = Math.max(1, maxLines(box.height));
  const paragraphs = source
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pages: string[] = [];
  let buffer: string[] = [];
  let bufferLines = 0;

  const flush = (): void => {
    if (!buffer.length) return;
    pages.push(buffer.join("\n\n"));
    buffer = [];
    bufferLines = 0;
  };

  for (const para of paragraphs) {
    const paraLines = wrapInfo(para, box.width).lineCount;
    if (paraLines > limit) {
      flush();
      for (const chunk of splitParagraph(para, box.width, limit)) pages.push(chunk);
      continue;
    }
    const cost = paraLines + (buffer.length ? 1 : 0); // +1 blank between paras
    if (bufferLines + cost > limit) {
      flush();
      buffer.push(para);
      bufferLines = paraLines;
    } else {
      buffer.push(para);
      bufferLines += cost;
    }
  }
  flush();
  return pages.length ? pages : [""];
}

function splitParagraph(text: string, width: number, limit: number): string[] {
  const tokens = text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current + token;
    if (wrapInfo(candidate, width).lineCount > limit && current.trim()) {
      chunks.push(current.trim());
      current = token.replace(/^\s+/, "");
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
