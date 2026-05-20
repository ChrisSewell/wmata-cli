// Ground-truth preview harness (DEV ONLY).
//
// Renders the deterministic gallery fixtures (`buildCards()`) through the
// REAL Even Realities glasses containers in the simulator, so we get
// true LVGL font + bordered-container rendering of every screen state —
// not the monospace HTML approximation of `preview.html`.
//
// Drive it via the simulator automation API: each touchpad gesture
// (TAP / SCROLL) advances to the next card. Cards start at index 0 on
// load, so sending N "click" actions lands deterministically on card N.
// The current card title is logged to the console (readable via
// `GET /api/console`) so screenshots can be correlated to states.
//
// This file is NOT part of the production bundle (index.html → main.ts).
// Point the simulator at `/glasses-preview.html` to use it.

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

import { SCREEN_WIDTH_PX } from "./ui/render";
import { formatClock } from "./ui/format";
import { buildCards, type ScreenCard } from "./preview/gallery";

// --- Container geometry (mirrors glasses-host.ts) ---
const HEADER_ID = 1;
const BODY_ID = 2;
const FOOTER_ID = 3;
const clockId = (layout: Layout): number =>
  layout === "three-section" ? 4 : 3;

const TWO_HEADER_H = 44;
const TWO_BODY_Y = 44;
const TWO_BODY_H = 244;

const THREE_HEADER_H = 44;
const THREE_BODY_Y = 44;
const THREE_BODY_H = 160;
const THREE_FOOTER_Y = 204;
const THREE_FOOTER_H = 84;

// Clock container (mirrors glasses-host.ts). Height > line height so the
// single clock line doesn't trip LVGL's auto-scrollbar in the header.
const CLOCK_X = 486;
const CLOCK_Y = 6;
const CLOCK_W = 84;
const CLOCK_H = 30;

// Body value-column overlay (mirrors glasses-host.ts).
const BODY_RIGHT_ID = 7;
const BODY_RIGHT_X = 466;
const BODY_RIGHT_W = SCREEN_WIDTH_PX - BODY_RIGHT_X;

const BORDER_COLOR = 8;
const BORDER_RADIUS = 4;
const PADDING = 6;

type Layout = "two-section" | "three-section";

function clockContainer(layout: Layout, clock: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: CLOCK_X,
    yPosition: CLOCK_Y,
    width: CLOCK_W,
    height: CLOCK_H,
    borderWidth: 0,
    paddingLength: 0,
    containerID: clockId(layout),
    containerName: "wmata.clock",
    isEventCapture: 0,
    content: clock,
  });
}

function bodyRightContainer(layout: Layout, content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: BODY_RIGHT_X,
    yPosition: layout === "three-section" ? THREE_BODY_Y : TWO_BODY_Y,
    width: BODY_RIGHT_W,
    height: layout === "three-section" ? THREE_BODY_H : TWO_BODY_H,
    borderWidth: 0,
    paddingLength: PADDING,
    containerID: BODY_RIGHT_ID,
    containerName: "wmata.bodyR",
    isEventCapture: 0,
    content,
  });
}

function buildPage(
  layout: Layout,
  header: string,
  body: string,
  footer: string,
  clock: string,
  hasColumns: boolean,
  bodyRight: string,
): CreateStartUpPageContainer {
  if (layout === "three-section") {
    const objs: TextContainerProperty[] = [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: SCREEN_WIDTH_PX,
          height: THREE_HEADER_H,
          borderWidth: 1,
          borderColor: BORDER_COLOR,
          borderRadius: BORDER_RADIUS,
          paddingLength: PADDING,
          containerID: HEADER_ID,
          containerName: "wmata.header",
          isEventCapture: 0,
          content: header,
        }),
        new TextContainerProperty({
          xPosition: 0,
          yPosition: THREE_BODY_Y,
          width: SCREEN_WIDTH_PX,
          height: THREE_BODY_H,
          borderWidth: 1,
          borderColor: BORDER_COLOR,
          borderRadius: BORDER_RADIUS,
          paddingLength: PADDING,
          containerID: BODY_ID,
          containerName: "wmata.body",
          isEventCapture: 1,
          content: body,
        }),
        new TextContainerProperty({
          xPosition: 0,
          yPosition: THREE_FOOTER_Y,
          width: SCREEN_WIDTH_PX,
          height: THREE_FOOTER_H,
          borderWidth: 1,
          borderColor: BORDER_COLOR,
          borderRadius: BORDER_RADIUS,
          paddingLength: PADDING,
          containerID: FOOTER_ID,
          containerName: "wmata.footer",
          isEventCapture: 0,
          content: footer,
        }),
        clockContainer(layout, clock),
    ];
    if (hasColumns) objs.push(bodyRightContainer(layout, bodyRight));
    return new CreateStartUpPageContainer({
      containerTotalNum: objs.length,
      textObject: objs,
    });
  }
  const objs: TextContainerProperty[] = [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_WIDTH_PX,
        height: TWO_HEADER_H,
        borderWidth: 1,
        borderColor: BORDER_COLOR,
        borderRadius: BORDER_RADIUS,
        paddingLength: PADDING,
        containerID: HEADER_ID,
        containerName: "wmata.header",
        isEventCapture: 0,
        content: header,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: TWO_BODY_Y,
        width: SCREEN_WIDTH_PX,
        height: TWO_BODY_H,
        borderWidth: 1,
        borderColor: BORDER_COLOR,
        borderRadius: BORDER_RADIUS,
        paddingLength: PADDING,
        containerID: BODY_ID,
        containerName: "wmata.body",
        isEventCapture: 1,
        content: body,
      }),
      clockContainer(layout, clock),
  ];
  if (hasColumns) objs.push(bodyRightContainer(layout, bodyRight));
  return new CreateStartUpPageContainer({
    containerTotalNum: objs.length,
    textObject: objs,
  });
}

function isGesture(t: OsEventTypeList | undefined): boolean {
  const v = t ?? OsEventTypeList.CLICK_EVENT; // protobuf zero-value omission
  return (
    v === OsEventTypeList.CLICK_EVENT ||
    v === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    v === OsEventTypeList.SCROLL_TOP_EVENT ||
    v === OsEventTypeList.SCROLL_BOTTOM_EVENT
  );
}

/**
 * Calibration mode (URL `?calib`): render ruler lines of known widths so
 * we can read off — from a screenshot — the max chars-per-line that fit
 * the 576px container WITHOUT the LVGL container hard-wrapping. Each line
 * is prefixed with its length; if a line wraps, its tail spills to col 0
 * and we know that width is unsafe. We test the worst case (wide glyphs:
 * caps + 'm'/'w') and a realistic mixed-case sentence.
 */
function calibrationCards(): { header: string; body: string }[] {
  const mk = (n: number, ch: string) =>
    String(n).padStart(2, "0") + ":" + ch.repeat(n - 3);
  const widthsCaps: string[] = [];
  for (const n of [40, 44, 48, 52, 56, 60, 64, 68, 72]) {
    widthsCaps.push(mk(n, "W"));
  }
  const widthsMixed: string[] = [
    "Trains single-tracking between Tenleytown and Bethesda now",
    "Single-tracking between Foggy Bottom and Rosslyn due to work",
    "Mt Vernon Sq 7th St-Convention Center to Gallery Pl-Chinatown!",
    "Escalator between street and mezzanine, east side of the entrance",
  ];
  return [
    { header: "CALIB caps (W) — find wrap point", body: widthsCaps.join("\n") },
    { header: "CALIB mixed sentences", body: widthsMixed.join("\n") },
  ];
}

async function runCalibration(bridge: EvenAppBridge): Promise<void> {
  const cards = calibrationCards();
  let i = 0;
  const draw = async (k: number): Promise<void> => {
    const c = cards[k]!;
    try {
      await bridge.shutDownPageContainer(0);
    } catch {
      /* first */
    }
    await bridge.createStartUpPageContainer(
      buildPage("two-section", c.header, c.body, "", "", false, ""),
    );
    console.log(`[calib] ${String(k + 1)}/${String(cards.length)}: ${c.header}`);
  };
  bridge.onEvenHubEvent((event: EvenHubEvent) => {
    const t = event.textEvent?.eventType ?? event.sysEvent?.eventType;
    if (!isGesture(t)) return;
    i = (i + 1) % cards.length;
    void draw(i);
  });
  await draw(0);
}

/**
 * Image-pipeline probe (URL `?img`): create a few image containers and
 * push test patterns in different candidate byte formats, so a
 * screenshot tells us (a) that image containers render at all, and
 * (b) which `imageData` format the host expects (RGBA vs grayscale vs
 * packed gray4). Each container is labeled by a text container above it.
 */
async function runImageTest(bridge: EvenAppBridge): Promise<void> {
  const W = 120;
  const H = 96;
  // Candidate A: RGBA, 4 bytes/px, horizontal black→white gradient + border.
  const rgba: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x < 2 || x >= W - 2 || y < 2 || y >= H - 2;
      const v = border ? 255 : Math.floor((x / W) * 255);
      rgba.push(v, v, v, 255);
    }
  }
  // Candidate B: grayscale, 1 byte/px, same gradient.
  const gray: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x < 2 || x >= W - 2 || y < 2 || y >= H - 2;
      gray.push(border ? 255 : Math.floor((x / W) * 255));
    }
  }
  // Candidate C: packed gray4, 2 px/byte (high nibble = left px), gradient.
  const packed: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x += 2) {
      const n1 = Math.floor((x / W) * 15) & 0xf;
      const n2 = Math.floor(((x + 1) / W) * 15) & 0xf;
      packed.push((n1 << 4) | n2);
    }
  }

  const page = new CreateStartUpPageContainer({
    containerTotalNum: 4,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_WIDTH_PX,
        height: 28,
        borderWidth: 1,
        borderColor: 8,
        paddingLength: 4,
        containerID: 1,
        containerName: "lbl",
        isEventCapture: 1,
        content: "IMG TEST  A=rgba  B=gray  C=gray4packed",
      }),
    ],
    imageObject: [
      new ImageContainerProperty({
        xPosition: 8,
        yPosition: 40,
        width: W,
        height: H,
        containerID: 2,
        containerName: "imgA",
      }),
      new ImageContainerProperty({
        xPosition: 160,
        yPosition: 40,
        width: W,
        height: H,
        containerID: 3,
        containerName: "imgB",
      }),
      new ImageContainerProperty({
        xPosition: 312,
        yPosition: 40,
        width: W,
        height: H,
        containerID: 4,
        containerName: "imgC",
      }),
    ],
  });
  const res = await bridge.createStartUpPageContainer(page);
  console.log(`[img] createPage result=${String(res)}`);
  const push = async (id: number, data: number[], tag: string) => {
    try {
      const r = await bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: id, imageData: data }),
      );
      console.log(`[img] ${tag} (id=${String(id)}, ${String(data.length)} bytes) result=${String(r)}`);
    } catch (e) {
      console.log(`[img] ${tag} threw: ${String(e)}`);
    }
  };
  await push(2, rgba, "A rgba");
  await push(3, gray, "B gray");
  await push(4, packed, "C gray4packed");
}

/** Column probe (URL `?cols`): render a hand-built two-column body to
 *  confirm the value-overlay renders as a pixel-aligned right column. */
async function runColsTest(bridge: EvenAppBridge): Promise<void> {
  const left = [
    "> Metro Center · RED BLUE ORANGE SILVER",
    "  Gallery Pl-Chinatown · RED YELLOW GREEN",
    "  Union Station · RED",
    "  ALERTS · RED · ORANGE",
    "  ACCESS",
  ].join("\n");
  const right = ["4 min", "12 min", "ARR", "2 alerts", "2 outages"].join("\n");
  await bridge.createStartUpPageContainer(
    buildPage("two-section", "WMATA  Favorites", left, "", " 2:32p", true, right),
  );
  console.log("[cols] rendered 2-column body");
}

async function main(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  if (typeof location !== "undefined" && location.search.includes("cols")) {
    await runColsTest(bridge);
    return;
  }
  if (typeof location !== "undefined" && location.search.includes("img")) {
    await runImageTest(bridge);
    return;
  }
  if (typeof location !== "undefined" && location.search.includes("calib")) {
    await runCalibration(bridge);
    return;
  }
  const cards = buildCards();
  let idx = 0;
  let currentLayout: Layout | null = null;
  let currentHasColumns = false;

  const renderCard = async (i: number): Promise<void> => {
    const card: ScreenCard<unknown> = cards[i]!;
    const layout: Layout = card.screen.layout ?? "two-section";
    const sections = card.screen.view(card.snapshot, card.nav, card.ctx);
    const header = sections.header.join("\n");
    const cols = sections.bodyColumns;
    const hasColumns = cols != null;
    const body = (cols ? cols.left : sections.body).join("\n");
    const bodyRight = cols ? cols.right.join("\n") : "";
    const footer = (sections.footer ?? []).join("\n");
    // Host-owned clock: formatted from the card's fixed ctx clock +
    // the screen's optional staleness marker.
    const clock = formatClock(card.ctx.nowMs) + (sections.clockMarker ?? "");

    if (layout !== currentLayout || hasColumns !== currentHasColumns) {
      // Layout / column-mode change requires recreating the page.
      try {
        await bridge.shutDownPageContainer(0);
      } catch {
        // First mount: no page to shut down.
      }
      await bridge.createStartUpPageContainer(
        buildPage(layout, header, body, footer, clock, hasColumns, bodyRight),
      );
      currentLayout = layout;
      currentHasColumns = hasColumns;
    } else {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: HEADER_ID, content: header }),
      );
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: BODY_ID, content: body }),
      );
      if (hasColumns) {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: BODY_RIGHT_ID, content: bodyRight }),
        );
      }
      if (layout === "three-section") {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: FOOTER_ID, content: footer }),
        );
      }
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: clockId(layout), content: clock }),
      );
    }
    console.log(
      `[preview] card ${String(i + 1)}/${String(cards.length)}: ${card.title}`,
    );
  };

  bridge.onEvenHubEvent((event: EvenHubEvent) => {
    const t = event.textEvent?.eventType ?? event.sysEvent?.eventType;
    if (!isGesture(t)) return;
    idx = (idx + 1) % cards.length;
    void renderCard(idx);
  });

  await renderCard(0);
}

void main();
