// The ONLY SDK consumer. Translates the pure `Screen<S>` + `Layout` contract
// into native containers and drives the event/lifecycle loop. Screen authors
// never learn the SDK's quirks — they live here.
//
// Robustness ported from the prior shipping host (proven on hardware):
//   - Protobuf zero-value: CLICK_EVENT (0) arrives with eventType `undefined`
//     on the textEvent envelope — coalesce there, but NEVER on sysEvent (where
//     lifecycle events ride; a coalesce would fire phantom presses).
//   - The body text container is the sole event capturer; taps/double-taps AND
//     swipes (SCROLL_TOP/BOTTOM, per-swipe) arrive as textEvent.
//   - Render coalescing + per-container de-dup so the 1Hz clock tick is ~free.
//   - Single-flight tick with a generation counter (a late fetch after unmount
//     never writes a torn-down snapshot).
//   - FOREGROUND_EXIT/ENTER pause/resume (don't burn the WMATA rate budget
//     while backgrounded; refresh immediately on return).
//   - Root double-press exits via shutDownPageContainer(1) (submission gate).

import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

import {
  pageRects,
  heroRects,
  BODY_PAD,
  HEADER_PAD,
  BODY_INSET,
  CLOCK_RESERVE_PX,
  type Rect,
} from "../ui/layout";
import { RADIUS, BORDER_W } from "../ui/geometry";
import { TIER } from "../ui/tokens";
import { columnGeom, composeText, type ColumnGeom } from "./compose";
import { encodeHero } from "./accent";
import { createSerial } from "./serial";
import { initialNav, type NavState, type Router, type Screen, type ScreenEvent, type ViewContext } from "../screens/router";

// Container IDs (text mode).
const ID_HEADER = 1;
const ID_BODY = 2;
const ID_CLOCK = 3;
const ID_VALUE = 4;
const ID_HINT = 5;
const ID_ACCENT = 6; // hero screens only — the one image accent

const CLOCK_TICK_MS = 1000;
// Ignore gestures for a beat right after a screen mounts. A navigation
// unsubscribes the old screen and (a)synchronously mounts + subscribes the new
// one; the simulator/firmware can route the still-pending click to whichever
// container just became the active capturer, which would otherwise bounce the
// new screen straight back. Imperceptible after a deliberate navigation.
const INPUT_COOLDOWN_MS = 250;

// --- Event normalization (exported for tests) -----------------------------

function mapGesture(t: OsEventTypeList): ScreenEvent | null {
  if (t === OsEventTypeList.CLICK_EVENT) return { type: "TAP" };
  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: "DOUBLE_TAP" };
  if (t === OsEventTypeList.SCROLL_TOP_EVENT) return { type: "SCROLL_UP" };
  if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return { type: "SCROLL_DOWN" };
  return null;
}

/**
 * A user gesture, or null for non-gesture envelopes. Both the textEvent
 * (hardware) and sysEvent (simulator) envelopes coalesce a missing eventType to
 * CLICK — protobuf omits the zero-value CLICK_EVENT (0). This is safe because
 * the caller checks `lifecycleEvent` FIRST: lifecycle events carry DEFINED
 * types (FOREGROUND_*, EXIT) and never reach here, so the only sysEvent that
 * arrives with an undefined type is a real single press. Non-gesture defined
 * sysEvents (e.g. IMU) map to null and fall through.
 */
export function eventToScreenEvent(event: EvenHubEvent): ScreenEvent | null {
  const text = event.textEvent;
  if (text) {
    const mapped = mapGesture(text.eventType ?? OsEventTypeList.CLICK_EVENT);
    if (mapped) return mapped;
  }
  const sys = event.sysEvent;
  if (sys) {
    const mapped = mapGesture(sys.eventType ?? OsEventTypeList.CLICK_EVENT);
    if (mapped) return mapped;
  }
  return null;
}

export type LifecycleEvent = "FOREGROUND_ENTER" | "FOREGROUND_EXIT" | "EXIT";

export function lifecycleEvent(event: EvenHubEvent): LifecycleEvent | null {
  const t = event.sysEvent?.eventType;
  if (t === undefined) return null;
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) return "FOREGROUND_ENTER";
  if (t === OsEventTypeList.FOREGROUND_EXIT_EVENT) return "FOREGROUND_EXIT";
  if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) return "EXIT";
  return null;
}

// --- Container builders ----------------------------------------------------

function box(
  id: number,
  name: string,
  rect: { x: number; y: number; w: number; h: number },
  borderColor: number,
  pad: number,
  content: string,
  capture: boolean,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: rect.x,
    yPosition: rect.y,
    width: rect.w,
    height: rect.h,
    borderWidth: BORDER_W,
    borderColor,
    borderRadius: RADIUS,
    paddingLength: pad,
    containerID: id,
    containerName: name,
    isEventCapture: capture ? 1 : 0,
    content,
  });
}

function borderless(
  id: number,
  name: string,
  rect: { x: number; y: number; w: number; h: number },
  content: string,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: rect.x,
    yPosition: rect.y,
    width: rect.w,
    height: rect.h,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: id,
    containerName: name,
    isEventCapture: 0,
    content,
  });
}

/** Geometry for the host-owned clock overlay (top-right of the header box).
 *  Borderless, so its height (30) is its inner height — ≥ 27 to avoid a
 *  scrollbar — and its top aligns with the header title's text top. */
function clockRect() {
  const { header } = pageRects();
  return {
    x: header.x + header.w - BORDER_W - HEADER_PAD - CLOCK_RESERVE_PX,
    y: header.y + BORDER_W + HEADER_PAD,
    w: CLOCK_RESERVE_PX,
    h: 30,
  };
}

/** Geometry for the value-overlay column (aligned to the body text). */
function valueRect(geom: ColumnGeom, body: Rect) {
  const x = geom.valueX ?? 0;
  return {
    x,
    y: body.y + BODY_INSET,
    w: body.x + body.w - BODY_INSET - x,
    h: body.h - BODY_INSET * 2,
  };
}

// --- Mount -----------------------------------------------------------------

export async function mountGlassesScreen<S>(
  screen: Screen<S>,
  bridge: EvenAppBridge,
  router: Router,
): Promise<() => Promise<void>> {
  if (screen.mode !== "text") {
    // List-mode lands in M5; no list screen exists yet.
    console.error(`[host] screen "${screen.name}" mode "${screen.mode}" not yet supported`);
  }

  let snapshot = screen.init();
  let nav: NavState = initialNav();
  let active = true;
  let hintsVisible = true;
  let mountedAtMs = 0; // set when the event subscription goes live

  const hero = screen.hero === true;
  const rects = pageRects();
  const bodyRect = hero ? heroRects().body : rects.body;
  const geom = columnGeom(screen.valueReserve, bodyRect);
  const hasValue = geom.valueX !== null;
  const serial = createSerial();

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  let inFlightTick = false;
  let tickGeneration = 0;
  let renderInFlight = false;
  let renderPending = false;

  // Per-container de-dup cache.
  let lastHeader: string | null = null;
  let lastBody: string | null = null;
  let lastClock: string | null = null;
  let lastValue: string | null = null;
  let lastHint: string | null = null;
  // Hero image accent: cache the encoded PNG so a rebuild / FOREGROUND_ENTER
  // can re-push it without re-encoding (image buffers don't survive lock/sleep).
  let lastNumeral: string | null = null;
  let accentBytes: Uint8Array | null = null;

  const makeCtx = (): ViewContext => ({ nowMs: Date.now() });

  const pushAccent = async (numeral: string): Promise<void> => {
    if (!hero || numeral === lastNumeral) return;
    try {
      const a = heroRects().accent;
      accentBytes = await encodeHero(numeral, a.w, a.h);
      await serial(() =>
        bridge.updateImageRawData(
          new ImageRawDataUpdate({ containerID: ID_ACCENT, containerName: "wmata.accent", imageData: accentBytes! }),
        ),
      );
      lastNumeral = numeral;
    } catch (err) {
      console.warn("[host] accent push failed:", err);
    }
  };

  const repushAccent = async (): Promise<void> => {
    if (!hero || !accentBytes) return;
    try {
      await serial(() =>
        bridge.updateImageRawData(
          new ImageRawDataUpdate({ containerID: ID_ACCENT, containerName: "wmata.accent", imageData: accentBytes! }),
        ),
      );
    } catch (err) {
      console.warn("[host] accent re-push failed:", err);
    }
  };

  const pushIfChanged = async (id: number, content: string, last: string | null): Promise<string | null> => {
    if (content === last) return last;
    try {
      await serial(() => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, content })));
      return content;
    } catch (err) {
      console.warn(`[host] textContainerUpgrade(${id}) failed:`, err);
      return last;
    }
  };

  const render = async (): Promise<void> => {
    if (!active) return;
    if (renderInFlight) {
      renderPending = true;
      return;
    }
    renderInFlight = true;
    try {
      do {
        renderPending = false;
        if (!active) break;
        const r = composeText(screen.view(snapshot, nav, makeCtx()), geom, Date.now(), hintsVisible);
        lastHeader = await pushIfChanged(ID_HEADER, r.title, lastHeader);
        lastBody = await pushIfChanged(ID_BODY, r.bodyContent, lastBody);
        lastClock = await pushIfChanged(ID_CLOCK, r.clock, lastClock);
        if (hasValue) lastValue = await pushIfChanged(ID_VALUE, r.valueContent, lastValue);
        lastHint = await pushIfChanged(ID_HINT, r.hint, lastHint);
        if (hero) await pushAccent(r.numeral);
      } while (renderPending && active);
    } finally {
      renderInFlight = false;
    }
  };

  // Build the initial page.
  const initial = composeText(screen.view(snapshot, nav, makeCtx()), geom, Date.now(), hintsVisible);
  const containers: TextContainerProperty[] = [
    box(ID_HEADER, "wmata.header", rects.header, TIER.STRONG, HEADER_PAD, initial.title, false),
    box(ID_BODY, "wmata.body", bodyRect, TIER.MUTED, BODY_PAD, initial.bodyContent, true),
    borderless(ID_CLOCK, "wmata.clock", clockRect(), initial.clock),
  ];
  if (hasValue) containers.push(borderless(ID_VALUE, "wmata.value", valueRect(geom, bodyRect), initial.valueContent));
  containers.push(borderless(ID_HINT, "wmata.hint", rects.hint, initial.hint));
  lastHeader = initial.title;
  lastBody = initial.bodyContent;
  lastClock = initial.clock;
  lastValue = hasValue ? initial.valueContent : null;
  lastHint = initial.hint;

  // The image accent can't be sent during page creation — create an empty
  // placeholder, then push pixels with updateImageRawData once the page is up.
  const imageObject: ImageContainerProperty[] = [];
  if (hero) {
    const a = heroRects().accent;
    imageObject.push(
      new ImageContainerProperty({
        xPosition: a.x,
        yPosition: a.y,
        width: a.w,
        height: a.h,
        containerID: ID_ACCENT,
        containerName: "wmata.accent",
      }),
    );
  }

  try {
    const result = await serial(() =>
      bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: containers.length + imageObject.length,
          textObject: containers,
          imageObject: hero ? imageObject : undefined,
        }),
      ),
    );
    if (result !== StartUpPageCreateResult.success) {
      console.warn(`[host] createStartUpPageContainer non-success: ${String(result)}`);
    }
  } catch (err) {
    console.warn(`[host] createStartUpPageContainer threw:`, err);
  }

  // Push the accent now that the page exists.
  if (hero) await pushAccent(initial.numeral);

  if (screen.onMount) {
    try {
      await screen.onMount(bridge);
    } catch (err) {
      console.warn(`[host] onMount threw:`, err);
    }
  }

  const runTick = async (): Promise<void> => {
    if (!active || !screen.tick || inFlightTick) return;
    inFlightTick = true;
    const myGen = tickGeneration;
    try {
      const next = await screen.tick(snapshot);
      if (!active || myGen !== tickGeneration) return;
      snapshot = next;
      await render();
    } catch (err) {
      console.warn(`[host] tick threw:`, err);
    } finally {
      inFlightTick = false;
    }
  };

  const fetchEnabled = Boolean(screen.tick && screen.tickIntervalMs && screen.tickIntervalMs > 0);

  const startTimers = (): void => {
    if (fetchEnabled) {
      if (tickTimer !== null) clearInterval(tickTimer);
      tickTimer = setInterval(() => void runTick(), screen.tickIntervalMs);
    }
    if (clockTimer !== null) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      if (active) void render();
    }, CLOCK_TICK_MS);
  };
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

  const dispatch = (event: ScreenEvent): void => {
    if (!active) return;
    // First input dismisses the hint line (re-show on re-entry / re-mount).
    if (hintsVisible) hintsVisible = false;
    const result = screen.reduce(snapshot, nav, event);
    nav = result.nav;
    if (result.snapshot !== undefined) snapshot = result.snapshot;
    if (result.navigate) {
      // Root exit: the OS app-exit (system dialog). Distinct from a page
      // teardown for navigation (shutDown 0); using 0 at root is a
      // submission auto-reject.
      if (result.navigate.to === "exit") {
        void exitApp();
        // Let the owning router clean up too (e.g. the reconcile watcher stops
        // polling). A no-op for the in-app router.
        void router.navigate(result.navigate);
        return;
      }
      void render().then(() => router.navigate(result.navigate!));
      return;
    }
    void render();
    if (result.requestTick) void runTick();
  };

  mountedAtMs = Date.now();
  const unsubscribe = bridge.onEvenHubEvent((event: EvenHubEvent) => {
    if (!active) return;
    const lifecycle = lifecycleEvent(event);
    if (lifecycle === "EXIT") {
      void unmount();
      return;
    }
    if (lifecycle === "FOREGROUND_EXIT") {
      if (!paused) {
        paused = true;
        stopTimers();
      }
      return;
    }
    if (lifecycle === "FOREGROUND_ENTER") {
      if (paused) {
        paused = false;
        startTimers();
        void render();
        void repushAccent(); // image buffers drop on lock/sleep — re-push from cache
        if (fetchEnabled) void runTick();
      }
      return;
    }
    const gesture = eventToScreenEvent(event);
    if (!gesture) return;
    // Swallow a stray input that lands in the mount cooldown (see above).
    if (Date.now() - mountedAtMs < INPUT_COOLDOWN_MS) return;
    dispatch(gesture);
  });

  if (fetchEnabled) void runTick();
  startTimers();

  // Shared teardown (timers, subscription, onUnmount). `exitMode` selects the
  // shutDown semantics: 0 = page teardown for navigation; 1 = OS app exit.
  const teardown = async (exitMode: 0 | 1): Promise<void> => {
    if (!active) return;
    active = false;
    tickGeneration += 1;
    stopTimers();
    lastHeader = lastBody = lastClock = lastValue = lastHint = null;
    try {
      unsubscribe();
    } catch (err) {
      console.warn(`[host] unsubscribe threw:`, err);
    }
    if (screen.onUnmount) {
      try {
        await screen.onUnmount(bridge);
      } catch (err) {
        console.warn(`[host] onUnmount threw:`, err);
      }
    }
    try {
      await serial(() => bridge.shutDownPageContainer(exitMode));
    } catch (err) {
      console.warn(`[host] shutDownPageContainer threw:`, err);
    }
  };

  // Page teardown for screen-to-screen navigation (the router calls this).
  const unmount = (): Promise<void> => teardown(0);
  // Root app exit (double-press at root) — the required system exit dialog.
  const exitApp = (): Promise<void> => teardown(1);

  return unmount;
}
