// SDK glue between the pure `Screen<S>` contract and the Even Realities
// bridge. This is the ONLY file in the screens/ directory that imports
// the SDK; everything else stays pure so it can be unit-tested.
//
// Responsibilities:
//   - Build a `TextContainerProperty` covering the 576x288 panel and
//     mount the page with `bridge.createStartUpPageContainer`.
//   - Translate the SDK's three event envelopes into the unified
//     `ScreenEvent` and feed them through `screen.reduce`.
//   - After each reduce: render via `bridge.textContainerUpgrade` and
//     dispatch any returned `NavIntent` to the router.
//   - Return an unmount function that unsubscribes + tears the page down.
//
// SDK quirks captured here so screen authors never have to learn them:
//
//   1. Protobuf zero-value omission. `CLICK_EVENT = 0` arrives on the
//      wire as `undefined`, NOT as `0`. We coalesce every `eventType`
//      with `?? 0` before comparing.
//   2. Event routing. The TextContainer is the page's sole event
//      capturer (`isEventCapture: 1`), so all touchpad inputs — taps,
//      double-taps, AND swipes — arrive as `textEvent` with the
//      appropriate `eventType`. The `sysEvent` envelope is the
//      fallback for global touchpad events (and the source for
//      lifecycle events FOREGROUND_*, SYSTEM_EXIT). We handle every
//      `OsEventTypeList` value on both envelopes so a future routing
//      change can't silently swallow a gesture.
//
//      Earlier iterations of this file mounted a hidden 1x1
//      ListContainer alongside the text purely as a scroll-event
//      source, on the assumption that "only LIST containers emit
//      SCROLL_TOP/SCROLL_BOTTOM" (a misreading of the SDK docs).
//      Lists actually *consume* scroll events internally for native
//      scrolling and never surface them to the page — the design
//      worked at the parse level but silently dropped every swipe.
//      We removed the list entirely once empirical testing
//      (simulator `RUST_LOG=debug`) confirmed text containers
//      receive scroll events as `textEvent` with eventType
//      SCROLL_TOP_EVENT/SCROLL_BOTTOM_EVENT.
//   3. `createStartUpPageContainer` returns a `StartUpPageCreateResult`
//      enum. Any value other than `success (0)` is logged but does
//      NOT throw — we still wire up event handlers so a USER can
//      double-tap to exit. (If we threw, the user would be stuck on
//      whatever blank page the OS leaves up.)

import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

import { SCREEN_WIDTH_PX } from "../ui/render";
import { formatClock } from "../ui/format";
import { TIER } from "../ui/palette";

import type {
  NavState,
  Router,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";
import { initialNav } from "./router";

// Multi-section page layout. Each section is a bordered TextContainer
// for visual hierarchy. All screens have a HEADER (title + clock) and
// a BODY (main content + event capturer); screens that opt into a
// three-section layout also get a FOOTER container (used by Predictions
// to surface incident headlines in their own bordered block).
//
// Heights are empirically tuned in the simulator — see
// `g2_simulator_debugging` memory for how to verify.

/** Container ID for the header text container. */
const HEADER_CONTAINER_ID = 1;
/** Container ID for the body text container (event capturer). */
const BODY_CONTAINER_ID = 2;
/** Container ID for the optional footer text container. */
const FOOTER_CONTAINER_ID = 3;
/**
 * Container ID for the host-managed clock. The ID is layout-dependent
 * so it's always the last container (after the footer, when present):
 * 3 for two-section pages, 4 for three-section. `clockContainerId()`
 * resolves it.
 */
function clockContainerId(layout: "two-section" | "three-section"): number {
  return layout === "three-section" ? 4 : 3;
}

// --- Clock container (host-owned, top-right of every screen) ---
/**
 * The clock lives in its own small borderless container pinned to the
 * top-right, so its position is identical on every screen instead of
 * drifting with the title length (as it did when each screen embedded
 * the clock at the end of its header string). Geometry sits INSIDE the
 * header band (y 0..40) with margin so it never collides with the
 * header's border. Content = `formatClock(now)` + the screen's optional
 * `clockMarker`.
 */
const CLOCK_X_PX = 486;
const CLOCK_Y_PX = 6;
const CLOCK_WIDTH_PX = 84;
/**
 * Height must exceed the font's line height with margin — at 24px (≈ the
 * line height) the single clock line sat exactly at the container bound
 * and LVGL drew an auto-scrollbar in the top-right of the header. 30px
 * leaves slack so no scrollbar appears (6 + 30 = 36 ≤ the 44px header).
 */
const CLOCK_HEIGHT_PX = 30;

// --- Body value-column overlay (two-column bodies) ---
/**
 * Container ID for the optional right-hand VALUE column. When a screen
 * returns `ScreenSections.bodyColumns`, the host keeps the normal
 * full-width body container (id 2) holding the LEFT lines, and overlays
 * this small BORDERLESS container on the body's right portion with the
 * value lines — so the value column starts at a fixed pixel x and is
 * truly aligned (a space-padded column in the body can't be, given the
 * variable-width font). Like the clock, it's an additive overlay, so
 * the header/body/footer/clock IDs and geometry are unchanged. The
 * high, fixed ID avoids colliding with the layout-dependent footer/
 * clock IDs.
 */
const BODY_RIGHT_CONTAINER_ID = 7;
/** Left x of the value-column overlay (and width to the right border). */
const BODY_RIGHT_X_PX = 466;
const BODY_RIGHT_WIDTH_PX = SCREEN_WIDTH_PX - BODY_RIGHT_X_PX; // 110

// --- Two-section layout (default) ---
/** Header section height for two-section pages. */
// 44 (not 40): at 40 the header's inner area (40 − 2 border − 2×6
// padding = 26px) exactly equalled the font line height, so LVGL drew an
// auto-scrollbar in the header's top-right. 44 gives the single title
// line clear room (inner 30px) — no scrollbar.
const TWO_HEADER_HEIGHT_PX = 44;
/** Body section y-position for two-section pages. */
const TWO_BODY_Y_PX = TWO_HEADER_HEIGHT_PX;
/** Body section height for two-section pages. */
const TWO_BODY_HEIGHT_PX = 244; // 288 - 44

// --- Three-section layout (Predictions) ---
/** Header section height for three-section pages — same as two-section. */
const THREE_HEADER_HEIGHT_PX = 44; // see TWO_HEADER_HEIGHT_PX (scrollbar fix)
/** Body section y-position for three-section pages. */
const THREE_BODY_Y_PX = THREE_HEADER_HEIGHT_PX;
/**
 * Body section height. Sized to hold the densest body state — a pinned
 * train (compact summary + schematic) ON TOP of the live train list —
 * without clipping. The previous 120px clipped the pinned state's last
 * row while the footer sat empty below; 160px (~5 rows) fits it and
 * still leaves a footer for the incident alert.
 */
const THREE_BODY_HEIGHT_PX = 160;
/** Footer section y-position for three-section pages. */
const THREE_FOOTER_Y_PX = THREE_HEADER_HEIGHT_PX + THREE_BODY_HEIGHT_PX; // 200
/**
 * Footer section height (~3 rows). Holds the active service-alert
 * headline wrapped at SAFE_TEXT_WIDTH (typically 2-3 lines). Smaller
 * than before so an EMPTY footer (no incident) doesn't read as a big
 * broken box; the screen fills it with a quiet line when there's no
 * alert.
 */
const THREE_FOOTER_HEIGHT_PX = 84; // = 288 - 204

/**
 * Container border-colour brightness tiers (16-shade greyscale, 0..15).
 *
 * Hierarchy on the G2 is expressed through BRIGHTNESS, not hue (see
 * `ui/palette.ts`). We render ~3 tiers per screen so the one focused /
 * active element stands out from its frame, replacing the previous flat
 * single index where header / body / footer all read at one weight:
 *
 *   - HEADER → SECONDARY (9): structural chrome that should recede.
 *   - BODY   → PRIMARY (15): the sole `isEventCapture` element — the
 *     focused / interactive container, so it carries the brightest frame.
 *   - FOOTER → MUTED (6): the dimmest still-legible weight (the floor).
 */
const HEADER_BORDER_COLOR = TIER.SECONDARY;
const BODY_BORDER_COLOR = TIER.PRIMARY;
const FOOTER_BORDER_COLOR = TIER.MUTED;

/**
 * Border-radius for the container corners. 6px is the official Even
 * Realities OS default frame radius (figma-extract guidelines `02 §2.3`;
 * 6px is also by far the most-used corner radius in the design tokens),
 * giving the bordered sections the system "card" feel.
 */
const BORDER_RADIUS = 6;

/** Padding inside every container, in pixels. A small inset keeps
 *  content (especially the cursor marker and first text column) from
 *  sitting flush against the bordered frame — it was previously 0 on
 *  the theory that right-anchored content could then reach the right
 *  border, but the variable-width font means space-padded right
 *  content never reaches the border anyway, so the inset is pure
 *  upside: every screen breathes and nothing collides with the frame. */
const HEADER_PADDING = 6;
const BODY_PADDING = 6;
const FOOTER_PADDING = 6;

/**
 * Cadence for the screen-independent clock-only re-render. Every
 * 1000ms the host calls `screen.view(snapshot, nav, { nowMs:
 * Date.now() })` and pushes the result through the bridge — without
 * invoking `screen.tick`. This keeps the on-HUD clock (and any
 * stale-marker logic) advancing even when a fetch has hung.
 *
 * Cheap: one `setInterval`, one `Date.now()`, one `view()` call per
 * second. Output is de-duped against `lastRenderedContent` so a
 * no-op clock tick (e.g. inside the same minute) does not retransmit
 * an identical container payload.
 */
const CLOCK_TICK_MS = 1000;

/**
 * Coalesce a `textEvent` eventType to `OsEventTypeList`, defaulting to
 * CLICK_EVENT (0).
 *
 * Protobuf strips zero-value fields on the wire, so `CLICK_EVENT = 0`
 * arrives as `undefined`. The `?? CLICK` coalesce is correct ONLY for
 * the `textEvent` envelope: that is the one place a real single press
 * legitimately arrives with no `eventType`. It must NOT be applied to
 * `sysEvent` — lifecycle events (FOREGROUND_*, EXITs) ride the sys
 * envelope and a zero-value/unrecognised sysEvent must never be coerced
 * into a phantom TAP (see `sysEventType`).
 */
function normalizeTextEventType(
  raw: OsEventTypeList | undefined,
): OsEventTypeList {
  return raw ?? OsEventTypeList.CLICK_EVENT;
}

/**
 * Read a `sysEvent` eventType WITHOUT the zero-value coalesce.
 *
 * The sys envelope carries lifecycle events (FOREGROUND_ENTER/EXIT,
 * ABNORMAL/SYSTEM exit, IMU) as well as the global touchpad fallback.
 * Coalescing `undefined → CLICK` here would turn any zero-value-omitted
 * or unrecognised sysEvent into a phantom press (which on Home navigates
 * away). Instead we return `undefined` for a missing type and match
 * every real type EXPLICITLY at the call sites — never defaulting an
 * unknown sysEvent to a gesture.
 */
function sysEventType(
  sys: { eventType?: OsEventTypeList } | undefined,
): OsEventTypeList | undefined {
  return sys?.eventType;
}

/**
 * Convert an `EvenHubEvent` into our normalised `ScreenEvent`, or
 * `null` if the envelope doesn't correspond to a user input.
 *
 * Lifecycle events (FOREGROUND_*, SYSTEM_EXIT, IMU) are reported
 * separately by the caller — this function only deals with
 * navigation gestures.
 *
 * Envelope handling is deliberately asymmetric:
 *   - `textEvent`: the page's sole event capturer; a real single press
 *     arrives here with eventType omitted (protobuf zero-value), so we
 *     coalesce `undefined → CLICK`.
 *   - `sysEvent`: the global fallback that ALSO carries lifecycle. We
 *     match gesture types EXPLICITLY and never coalesce — a zero-value
 *     or unrecognised sysEvent returns no gesture (so it cannot fire a
 *     phantom TAP). DOUBLE_CLICK is honoured on both envelopes.
 */
export function eventToScreenEvent(event: EvenHubEvent): ScreenEvent | null {
  const text = event.textEvent;
  if (text) {
    const mapped = mapGestureEventType(normalizeTextEventType(text.eventType));
    if (mapped) return mapped;
  }
  const sys = event.sysEvent;
  if (sys) {
    // Explicit match only — no `?? CLICK`. An unknown/zero-value
    // sysEvent (e.g. a future lifecycle code) yields `undefined` and is
    // dropped, never coerced into a press.
    const t = sysEventType(sys);
    if (t !== undefined) {
      const mapped = mapGestureEventType(t);
      if (mapped) return mapped;
    }
  }
  return null;
}

/**
 * Lifecycle kind extracted from a sysEvent, or `null` for non-lifecycle
 * envelopes. Lets the host pause/resume timers on FOREGROUND_EXIT/ENTER
 * (so a backgrounded app stops burning the WMATA rate budget) and tear
 * the page down on the two exit codes.
 */
export type LifecycleEvent =
  | "FOREGROUND_ENTER"
  | "FOREGROUND_EXIT"
  | "EXIT";

export function lifecycleEvent(event: EvenHubEvent): LifecycleEvent | null {
  const t = sysEventType(event.sysEvent);
  if (t === undefined) return null;
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) return "FOREGROUND_ENTER";
  if (t === OsEventTypeList.FOREGROUND_EXIT_EVENT) return "FOREGROUND_EXIT";
  if (
    t === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    t === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    return "EXIT";
  }
  return null;
}

/**
 * Map a touchpad-gesture `OsEventTypeList` value to a `ScreenEvent`.
 *
 * Only the four real gesture codes map. Lifecycle codes
 * (FOREGROUND_ENTER/EXIT, ABNORMAL/SYSTEM exit, IMU) return `null` so
 * they can never be mistaken for a press even if they reach this mapper.
 */
function mapGestureEventType(t: OsEventTypeList): ScreenEvent | null {
  if (t === OsEventTypeList.CLICK_EVENT) return { type: "TAP" };
  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: "DOUBLE_TAP" };
  if (t === OsEventTypeList.SCROLL_TOP_EVENT) return { type: "SCROLL_UP" };
  if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return { type: "SCROLL_DOWN" };
  return null;
}

/** True if the event is a system-exit (the page is being torn down by the OS). */
export function isSystemExit(event: EvenHubEvent): boolean {
  // Use the non-coalescing sys reader: a zero-value/omitted eventType is
  // NOT an exit (the old `?? CLICK` coalesce made every type-less
  // sysEvent read as CLICK, which happened not to match the exit codes
  // but masked the asymmetry we now make explicit).
  return lifecycleEvent(event) === "EXIT";
}

/**
 * Build the page container spec. Each section is a bordered
 * `TextContainerProperty`:
 *
 *   ┌───────────────────────────────┐ HEADER (compact title bar)
 *   │ Station name           14:32  │
 *   ├───────────────────────────────┤
 *   │  > RD SHADY GROVE      4 min  │ BODY (event capturer)
 *   │    RD GLENMONT        12 min  │
 *   ├───────────────────────────────┤
 *   │ ! Service alert text wrapped  │ FOOTER (3-section only)
 *   │   across multiple lines…      │
 *   └───────────────────────────────┘
 *
 * The body holds `isEventCapture: 1`; all touchpad gestures (TAP,
 * DOUBLE_TAP, SCROLL_UP, SCROLL_DOWN) arrive as `textEvent` on the
 * body — see `eventToScreenEvent`. Header / footer are decorative.
 */
/** Compose the clock-cell text: the wall clock + an optional staleness
 *  marker the screen surfaced via `ScreenSections.clockMarker`. */
export function clockContent(nowMs: number, marker: string | undefined): string {
  return formatClock(nowMs) + (marker ?? "");
}

/** Build the host-owned clock container for a given layout. */
function makeClockContainer(
  layout: "two-section" | "three-section",
  content: string,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: CLOCK_X_PX,
    yPosition: CLOCK_Y_PX,
    width: CLOCK_WIDTH_PX,
    height: CLOCK_HEIGHT_PX,
    borderWidth: 0,
    paddingLength: 0,
    containerID: clockContainerId(layout),
    containerName: "wmata.clock",
    isEventCapture: 0,
    content,
  });
}

/** Build the borderless value-column overlay for a two-column body. */
function makeBodyRightContainer(
  layout: "two-section" | "three-section",
  content: string,
): TextContainerProperty {
  const is3 = layout === "three-section";
  return new TextContainerProperty({
    xPosition: BODY_RIGHT_X_PX,
    yPosition: is3 ? THREE_BODY_Y_PX : TWO_BODY_Y_PX,
    width: BODY_RIGHT_WIDTH_PX,
    height: is3 ? THREE_BODY_HEIGHT_PX : TWO_BODY_HEIGHT_PX,
    borderWidth: 0,
    paddingLength: BODY_PADDING,
    containerID: BODY_RIGHT_CONTAINER_ID,
    containerName: "wmata.bodyR",
    isEventCapture: 0,
    content,
  });
}

function buildPage(
  layout: "two-section" | "three-section",
  initialHeader: string,
  initialBody: string,
  initialFooter: string,
  initialClock: string,
  hasColumns: boolean,
  initialBodyRight: string,
): CreateStartUpPageContainer {
  if (layout === "three-section") {
    const header = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: SCREEN_WIDTH_PX,
      height: THREE_HEADER_HEIGHT_PX,
      borderWidth: 1,
      borderColor: HEADER_BORDER_COLOR,
      borderRadius: BORDER_RADIUS,
      paddingLength: HEADER_PADDING,
      containerID: HEADER_CONTAINER_ID,
      containerName: "wmata.header",
      isEventCapture: 0,
      content: initialHeader,
    });
    const body = new TextContainerProperty({
      xPosition: 0,
      yPosition: THREE_BODY_Y_PX,
      width: SCREEN_WIDTH_PX,
      height: THREE_BODY_HEIGHT_PX,
      borderWidth: 1,
      borderColor: BODY_BORDER_COLOR,
      borderRadius: BORDER_RADIUS,
      paddingLength: BODY_PADDING,
      containerID: BODY_CONTAINER_ID,
      containerName: "wmata.body",
      isEventCapture: 1,
      content: initialBody,
    });
    const footer = new TextContainerProperty({
      xPosition: 0,
      yPosition: THREE_FOOTER_Y_PX,
      width: SCREEN_WIDTH_PX,
      height: THREE_FOOTER_HEIGHT_PX,
      borderWidth: 1,
      borderColor: FOOTER_BORDER_COLOR,
      borderRadius: BORDER_RADIUS,
      paddingLength: FOOTER_PADDING,
      containerID: FOOTER_CONTAINER_ID,
      containerName: "wmata.footer",
      isEventCapture: 0,
      content: initialFooter,
    });
    const three = [header, body, footer, makeClockContainer(layout, initialClock)];
    if (hasColumns) three.push(makeBodyRightContainer(layout, initialBodyRight));
    return new CreateStartUpPageContainer({
      containerTotalNum: three.length,
      textObject: three,
    });
  }
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_WIDTH_PX,
    height: TWO_HEADER_HEIGHT_PX,
    borderWidth: 1,
    borderColor: HEADER_BORDER_COLOR,
    borderRadius: BORDER_RADIUS,
    paddingLength: HEADER_PADDING,
    containerID: HEADER_CONTAINER_ID,
    containerName: "wmata.header",
    isEventCapture: 0,
    content: initialHeader,
  });
  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: TWO_BODY_Y_PX,
    width: SCREEN_WIDTH_PX,
    height: TWO_BODY_HEIGHT_PX,
    borderWidth: 1,
    borderColor: BODY_BORDER_COLOR,
    borderRadius: BORDER_RADIUS,
    paddingLength: BODY_PADDING,
    containerID: BODY_CONTAINER_ID,
    containerName: "wmata.body",
    isEventCapture: 1,
    content: initialBody,
  });
  const two = [header, body, makeClockContainer(layout, initialClock)];
  if (hasColumns) two.push(makeBodyRightContainer(layout, initialBodyRight));
  return new CreateStartUpPageContainer({
    containerTotalNum: two.length,
    textObject: two,
  });
}

/** Render `lines` into a single newline-joined string for `textContainerUpgrade`. */
export function joinForRender(lines: readonly string[]): string {
  return lines.join("\n");
}

/**
 * Mount a screen onto the glasses. Returns an unmount function.
 *
 * The host owns:
 *   - The page lifecycle (`createStartUpPageContainer` /
 *     `shutDownPageContainer`).
 *   - The event subscription.
 *   - The `NavState` (so we can preserve highlight across data
 *     refreshes — though WP6 has no live refresh yet).
 *
 * The screen owns:
 *   - Snapshot construction.
 *   - View rendering.
 *   - Reducer logic.
 */
export async function mountGlassesScreen<S>(
  screen: Screen<S>,
  bridge: EvenAppBridge,
  router: Router,
): Promise<() => Promise<void>> {
  // The snapshot starts at `screen.init()` and is mutated in-place by
  // tick refreshes (e.g. predictions polling). Reducers receive the
  // current snapshot by reference and never mutate it themselves.
  let snapshot = screen.init();
  let nav: NavState = initialNav();
  let active = true;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Independent 1Hz timer that re-renders with a fresh wall clock.
   * Decoupled from `tickTimer` (the fetch cadence) so a hung fetch
   * cannot freeze the HUD clock or stall the stale-marker check.
   */
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Last content strings we successfully pushed to each container.
   * Used to skip a redundant `textContainerUpgrade` when a clock tick
   * lands inside the same minute (i.e. the rendered string is byte-
   * identical to the previous one). One entry per container.
   */
  let lastRenderedHeader: string | null = null;
  let lastRenderedBody: string | null = null;
  let lastRenderedBodyRight: string | null = null;
  let lastRenderedFooter: string | null = null;
  let lastRenderedClock: string | null = null;

  // Render serialization. `render()` is invoked from three un-synchronised
  // sources — the event `dispatch`, the fetch `runTick`, and the 1Hz clock
  // timer — each of which awaits `bridge.textContainerUpgrade`. Without a
  // lock, two render bodies can interleave across those awaits and leave a
  // per-container de-dup cache entry (`lastRendered*`) disagreeing with the
  // last content actually pushed. We coalesce: only one render body runs at
  // a time; a render requested while one is in flight sets `renderPending`,
  // and the in-flight render loops once more so the LATEST snapshot/clock
  // is always the final frame (no dropped renders).
  let renderInFlight = false;
  let renderPending = false;

  /**
   * The screen's static layout mode. Cached because it controls
   * whether the footer container exists; switching it at runtime
   * would require re-creating the page.
   */
  const layoutMode: "two-section" | "three-section" =
    screen.layout ?? "two-section";

  // Single-flight tick guard.
  //
  // STRATEGY: SKIP (drop overlapping ticks).
  //
  // Background: the interval fires regardless of whether the previous
  // tick has settled. On a slow network this would mean overlapping
  // in-flight fetches racing each other to write to `snapshot`, with
  // the later fetch arbitrarily winning (or losing). The WP7 Builder
  // flagged this as a known gap.
  //
  // We pick SKIP over QUEUE-ONE because:
  //   - Predictions are a "freshest wins" stream; if a fetch is in
  //     flight when the next interval fires, the in-flight result is
  //     already the freshest available — queuing a redundant fetch
  //     would just compound the back-pressure that triggered the skip.
  //   - SKIP keeps the rate-limit budget honest (WMATA's 10 req/s soft
  //     cap): one fetch per `tickIntervalMs`, never more.
  //   - QUEUE-ONE would still leave us racing if the user navigated
  //     away mid-flight (we'd need to drop the queued tick anyway).
  //
  // We also use a *generation counter* (rather than a plain boolean) so
  // that a tick whose fetch settles AFTER `unmount` was called can
  // detect that it is stale and refuse to write to `snapshot`.
  let inFlightTick = false;
  let tickGeneration = 0;

  /**
   * Build a fresh `ViewContext` for the current render. The host is
   * the single source of `Date.now()` — screens never reach for the
   * wall clock themselves.
   */
  const makeCtx = (): ViewContext => ({ nowMs: Date.now() });

  // Render-loop guard: ignore events that arrive after unmount.
  //
  // De-duplication: if the rendered content is byte-identical to the
  // last frame we pushed, skip the `textContainerUpgrade` entirely.
  // This is the cheap optimisation that makes the 1Hz clock tick
  // essentially free inside a minute (the only thing that can change
  // within 60s of clock ticks is the HH:MM string, which only flips
  // at the minute boundary; everything else in the snapshot is held
  // steady between fetch ticks).
  const render = async (): Promise<void> => {
    if (!active) return;
    // Coalescing guard (see `renderInFlight` declaration): never run two
    // render bodies concurrently; instead loop once more for the latest.
    if (renderInFlight) {
      renderPending = true;
      return;
    }
    renderInFlight = true;
    try {
      do {
        renderPending = false;
        if (!active) break;
        const ctx = makeCtx();
        const sections = screen.view(snapshot, nav, ctx);
    const headerContent = joinForRender(sections.header);
    // Two-column body: the LEFT lines go in the normal body container,
    // the RIGHT (value) lines in the borderless overlay. Single-column
    // screens just render `body`.
    const cols = sections.bodyColumns;
    const bodyContent = joinForRender(cols ? cols.left : sections.body);
    const bodyRightContent = cols ? joinForRender(cols.right) : null;
    const footerContent = joinForRender(sections.footer ?? []);
    const clockText = clockContent(ctx.nowMs, sections.clockMarker);
    // Each container is independently de-duped — the clock-only tick
    // changes the header inside the minute but body/footer stay
    // identical, so we typically push at most one upgrade per second.
    if (headerContent !== lastRenderedHeader) {
      try {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: HEADER_CONTAINER_ID,
            content: headerContent,
          }),
        );
        lastRenderedHeader = headerContent;
      } catch (err) {
        console.warn(`[glasses-host] header textContainerUpgrade failed:`, err);
      }
    }
    if (bodyContent !== lastRenderedBody) {
      try {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: BODY_CONTAINER_ID,
            content: bodyContent,
          }),
        );
        lastRenderedBody = bodyContent;
      } catch (err) {
        console.warn(`[glasses-host] body textContainerUpgrade failed:`, err);
      }
    }
    if (bodyRightContent !== null && bodyRightContent !== lastRenderedBodyRight) {
      try {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: BODY_RIGHT_CONTAINER_ID,
            content: bodyRightContent,
          }),
        );
        lastRenderedBodyRight = bodyRightContent;
      } catch (err) {
        console.warn(`[glasses-host] body-right textContainerUpgrade failed:`, err);
      }
    }
    if (
      layoutMode === "three-section" &&
      footerContent !== lastRenderedFooter
    ) {
      try {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: FOOTER_CONTAINER_ID,
            content: footerContent,
          }),
        );
        lastRenderedFooter = footerContent;
      } catch (err) {
        console.warn(`[glasses-host] footer textContainerUpgrade failed:`, err);
      }
    }
    // Host-owned clock container (top-right, every screen). Updated
    // here so the minute flip + any staleness marker stay live on the
    // 1Hz tick; de-duped so a same-minute tick is a no-op.
    if (clockText !== lastRenderedClock) {
      try {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: clockContainerId(layoutMode),
            content: clockText,
          }),
        );
        lastRenderedClock = clockText;
      } catch (err) {
        console.warn(`[glasses-host] clock textContainerUpgrade failed:`, err);
      }
    }
      } while (renderPending && active);
    } finally {
      renderInFlight = false;
    }
  };

  // Mount the page. A non-success result still leaves event handlers
  // wired so the user can double-tap out.
  const initialCtx = makeCtx();
  const initialSections = screen.view(snapshot, nav, initialCtx);
  // Two-column mode is static per screen (decided by whether `view`
  // returns `bodyColumns`), so it's safe to commit the container set at
  // mount from the first render.
  const initialCols = initialSections.bodyColumns;
  const hasColumns = initialCols != null;
  const initialHeader = joinForRender(initialSections.header);
  const initialBody = joinForRender(initialCols ? initialCols.left : initialSections.body);
  const initialBodyRight = initialCols ? joinForRender(initialCols.right) : "";
  const initialFooter = joinForRender(initialSections.footer ?? []);
  const initialClock = clockContent(initialCtx.nowMs, initialSections.clockMarker);
  lastRenderedHeader = initialHeader;
  lastRenderedBody = initialBody;
  lastRenderedBodyRight = hasColumns ? initialBodyRight : null;
  lastRenderedFooter = initialFooter;
  lastRenderedClock = initialClock;
  try {
    const result = await bridge.createStartUpPageContainer(
      buildPage(
        layoutMode,
        initialHeader,
        initialBody,
        initialFooter,
        initialClock,
        hasColumns,
        initialBodyRight,
      ),
    );
    if (result !== StartUpPageCreateResult.success) {
      console.warn(
        `[glasses-host] createStartUpPageContainer returned non-success: ${String(result)}`,
      );
    }
  } catch (err) {
    console.warn(`[glasses-host] createStartUpPageContainer threw:`, err);
  }

  /**
   * Async-event dispatch for screens that need to push `ScreenEvent`s
   * from a callback (e.g. the Voice screen's STT subscriber). Mirrors
   * the touchpad event path: reduce the snapshot, apply any returned
   * snapshot replacement, fire any navigation intent, then re-render.
   * Ignored after unmount.
   */
  const dispatch = (event: ScreenEvent): void => {
    if (!active) return;
    const result = screen.reduce(snapshot, nav, event);
    nav = result.nav;
    // A reducer may return a fresh snapshot (e.g. Voice folds a new
    // transcript into `snapshot.transcript`). When present, apply it
    // before the re-render so `view` sees the updated state.
    if (result.snapshot !== undefined) {
      snapshot = result.snapshot;
    }
    const intent = result.navigate;
    if (intent) {
      void render().then(() => router.navigate(intent));
      return;
    }
    void render();
    // "Tap to retry" affordance: a reducer in an error/empty state can
    // ask the host to refetch immediately. `runTick` honours the normal
    // single-flight guard, so a retry while a fetch is already in flight
    // is harmlessly dropped. Declared later in this scope but only ever
    // invoked here at event time (well after mount), so no TDZ issue.
    if (result.requestTick) {
      void runTick();
    }
  };

  // Optional: side-effect setup tied to the screen's lifetime. The
  // Voice screen uses this to flip the microphone on and start its STT
  // stream. Errors are swallowed (logged) so a misbehaving screen
  // cannot strand the user on an unmountable page.
  if (screen.onMount) {
    try {
      await screen.onMount(bridge, dispatch);
    } catch (err) {
      console.warn(`[glasses-host] onMount threw:`, err);
    }
  }

  // Run one tick (fetch + re-render).
  //
  // Defensive try/catch: a screen's `tick` is contracted not to throw,
  // but we treat the contract as best-effort so a buggy screen can't
  // take down the page.
  //
  // Single-flight: if `inFlightTick` is set, drop this invocation on
  // the floor (see strategy note above). If `unmount` is called while
  // a tick is in flight, the post-await `generation !== tickGeneration`
  // check ensures the late result is discarded — we never write to a
  // snapshot that the unmount has already taken down.
  const runTick = async (): Promise<void> => {
    if (!active || !screen.tick) return;
    if (inFlightTick) {
      // A previous tick hasn't settled yet — drop this one rather than
      // racing. The next interval firing will get a fresh shot.
      return;
    }
    inFlightTick = true;
    const myGeneration = tickGeneration;
    try {
      const next = await screen.tick(snapshot);
      // Re-check after the await: if the host was unmounted (and thus
      // `tickGeneration` was bumped) while we were waiting, do NOT
      // apply this result to the snapshot — the snapshot is about to
      // be discarded.
      if (!active || myGeneration !== tickGeneration) return;
      snapshot = next;
      await render();
    } catch (err) {
      console.warn(`[glasses-host] tick threw:`, err);
    } finally {
      inFlightTick = false;
    }
  };

  // Whether the screen opted into auto-refresh. Cached so `resume()`
  // (after a FOREGROUND_ENTER) knows whether to restart the fetch timer.
  const fetchEnabled = Boolean(
    screen.tick && screen.tickIntervalMs && screen.tickIntervalMs > 0,
  );

  /** Whether the host is currently paused (backgrounded via FOREGROUND_EXIT). */
  let paused = false;

  /**
   * Start (or restart) the fetch + clock timers. Idempotent: clears any
   * existing timer first so a double `resume` can't leak intervals.
   * Used at mount and on every FOREGROUND_ENTER.
   */
  const startTimers = (): void => {
    if (fetchEnabled) {
      if (tickTimer !== null) clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        void runTick();
      }, screen.tickIntervalMs);
    }
    if (clockTimer !== null) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (!active) return;
      void render();
    }, CLOCK_TICK_MS);
  };

  /**
   * Stop the fetch + clock timers without tearing the page down.
   * Used on FOREGROUND_EXIT so a backgrounded app stops firing fetches
   * (honouring the WMATA rate budget) and stops the 1Hz clock churn.
   */
  const stopTimers = (): void => {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };

  /**
   * Pause on FOREGROUND_EXIT: the OS has put the app in the background
   * (e.g. the user opened another feature). Stop the timers so we don't
   * burn the fetch rate budget or re-render an off-screen page.
   */
  const pause = (): void => {
    if (!active || paused) return;
    paused = true;
    stopTimers();
  };

  /**
   * Resume on FOREGROUND_ENTER: restart the timers and run one immediate
   * fetch + render so the user sees fresh data the moment the app returns
   * to the foreground (rather than waiting a full tick interval).
   */
  const resume = (): void => {
    if (!active || !paused) return;
    paused = false;
    startTimers();
    // Immediate catch-up: a render to refresh the clock, plus one fetch
    // tick if the screen polls (so stale predictions update on return).
    void render();
    if (fetchEnabled) void runTick();
  };

  // Wire up auto-refresh if the screen opted in, and the always-on 1Hz
  // clock tick. We deliberately fire the first fetch tick AFTER the
  // initial mount-render (inside `startTimers` via the interval, plus an
  // explicit kickoff here), so the user sees whatever the snapshot's
  // `init()` produced (e.g. "Loading…") rather than a blank container
  // during the network round-trip. The clock tick keeps the visible
  // clock advancing even while a fetch is hung; the de-dup cache means
  // most clock ticks are no-ops (HH:MM doesn't change inside a minute).
  if (fetchEnabled) {
    void runTick();
  }
  startTimers();

  const unsubscribe = bridge.onEvenHubEvent((event: EvenHubEvent) => {
    if (!active) return;

    // Lifecycle first — match the sys envelope EXPLICITLY (no zero-value
    // coalesce), so a type-less or unrecognised sysEvent can never be
    // mistaken for a press.
    const lifecycle = lifecycleEvent(event);
    if (lifecycle === "EXIT") {
      // SYSTEM_EXIT / ABNORMAL_EXIT: the page is going away — clean up
      // regardless of which screen owns it.
      void unmount();
      return;
    }
    if (lifecycle === "FOREGROUND_EXIT") {
      pause();
      return;
    }
    if (lifecycle === "FOREGROUND_ENTER") {
      resume();
      return;
    }

    const screenEvent = eventToScreenEvent(event);
    if (!screenEvent) return;

    // Route touchpad gestures through the same `dispatch` path as
    // screen-driven async events (e.g. the Voice screen's STT
    // callbacks). This keeps re-render / navigation logic in one place.
    dispatch(screenEvent);
  });

  const unmount = async (): Promise<void> => {
    if (!active) return;
    active = false;
    // Bump the generation so an in-flight tick can detect, when its
    // fetch finally settles, that the host was unmounted in the
    // meantime and refuse to write its result back into `snapshot`.
    tickGeneration += 1;
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    // The clock tick is always-on regardless of `tickIntervalMs`, so
    // its timer must be torn down here too — otherwise a stale 1Hz
    // render would keep firing after the page is gone.
    if (clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
    // Forget the dedupe cache so a future re-mount of the same screen
    // doesn't accidentally short-circuit its first render.
    lastRenderedHeader = null;
    lastRenderedBody = null;
    lastRenderedBodyRight = null;
    lastRenderedFooter = null;
    lastRenderedClock = null;
    try {
      unsubscribe();
    } catch (err) {
      console.warn(`[glasses-host] unsubscribe threw:`, err);
    }
    // Optional: side-effect teardown tied to the screen's lifetime.
    // Runs BEFORE `shutDownPageContainer` so the screen can flush any
    // in-flight resources (e.g. closing the STT socket) while the page
    // is still around.
    if (screen.onUnmount) {
      try {
        await screen.onUnmount(bridge);
      } catch (err) {
        console.warn(`[glasses-host] onUnmount threw:`, err);
      }
    }
    try {
      await bridge.shutDownPageContainer(0);
    } catch (err) {
      console.warn(`[glasses-host] shutDownPageContainer threw:`, err);
    }
  };

  return unmount;
}
