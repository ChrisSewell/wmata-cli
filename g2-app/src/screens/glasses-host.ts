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
//   2. Event routing. Single taps may arrive in either `textEvent`
//      (when a TextContainer with `isEventCapture: 1` is hit) or
//      `sysEvent` (as a global touchpad event). Scrolls arrive in
//      `listEvent`. Lifecycle (FOREGROUND_*, SYSTEM_EXIT) arrives in
//      `sysEvent`. We never assume only one envelope is populated.
//   3. ListContainer dependency for scrolls. Per the SDK docs only
//      LIST containers emit SCROLL_TOP/SCROLL_BOTTOM events. We mount
//      a lightweight, off-screen ListContainerProperty (0-pixel) just
//      to act as a scroll-event source, alongside the visible
//      TextContainer. The list never renders; the OS still pipes
//      touchpad swipes to it because it has `isEventCapture: 1`.
//      If the simulator does not behave this way, swipes will arrive
//      as `textEvent` clicks anyway, and the user can still tap.
//   4. `createStartUpPageContainer` returns a `StartUpPageCreateResult`
//      enum. Any value other than `success (0)` is logged but does
//      NOT throw — we still wire up event handlers so a USER can
//      double-tap to exit. (If we threw, the user would be stuck on
//      whatever blank page the OS leaves up.)

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

import {
  SCREEN_HEIGHT_PX,
  SCREEN_WIDTH_PX,
} from "../ui/render";

import type {
  NavState,
  Router,
  Screen,
  ScreenEvent,
} from "./router";
import { initialNav } from "./router";

/** Container ID for the visible text container. */
const TEXT_CONTAINER_ID = 1;

/**
 * Container ID for the hidden list container we use to harvest
 * SCROLL_TOP/SCROLL_BOTTOM swipe events. The OS-side list never
 * renders any items; it exists only as an event source.
 */
const LIST_CONTAINER_ID = 2;

/** Map a raw SDK eventType to `OsEventTypeList`, defaulting to CLICK_EVENT (0). */
function normalizeEventType(raw: OsEventTypeList | undefined): OsEventTypeList {
  // Protobuf strips zero-value fields on the wire, so `CLICK_EVENT = 0`
  // arrives as `undefined`. Coalescing with the enum's zero member
  // restores the intended semantics.
  return raw ?? OsEventTypeList.CLICK_EVENT;
}

/**
 * Convert an `EvenHubEvent` into our normalised `ScreenEvent`, or
 * `null` if the envelope doesn't correspond to a user input.
 *
 * Lifecycle events (FOREGROUND_*, SYSTEM_EXIT, IMU) are reported
 * separately by the caller — this function only deals with
 * navigation gestures.
 */
export function eventToScreenEvent(event: EvenHubEvent): ScreenEvent | null {
  const list = event.listEvent;
  if (list) {
    const t = normalizeEventType(list.eventType);
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) return { type: "SCROLL_UP" };
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return { type: "SCROLL_DOWN" };
    if (t === OsEventTypeList.CLICK_EVENT) return { type: "TAP" };
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: "DOUBLE_TAP" };
  }
  const text = event.textEvent;
  if (text) {
    const t = normalizeEventType(text.eventType);
    if (t === OsEventTypeList.CLICK_EVENT) return { type: "TAP" };
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: "DOUBLE_TAP" };
  }
  const sys = event.sysEvent;
  if (sys) {
    const t = normalizeEventType(sys.eventType);
    if (t === OsEventTypeList.CLICK_EVENT) return { type: "TAP" };
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: "DOUBLE_TAP" };
  }
  return null;
}

/** True if the event is a system-exit (the page is being torn down by the OS). */
export function isSystemExit(event: EvenHubEvent): boolean {
  const sys = event.sysEvent;
  if (!sys) return false;
  const t = normalizeEventType(sys.eventType);
  return (
    t === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    t === OsEventTypeList.ABNORMAL_EXIT_EVENT
  );
}

/**
 * Build the page container spec. Exposed for tests / future reuse.
 *
 * We mount two containers per page: a TextContainer that fills the
 * 576x288 panel, and a 1x1 ListContainer parked at (0,0) that exists
 * only to receive SCROLL_TOP/SCROLL_BOTTOM swipes. The text is drawn
 * over the (invisible) list, so the user sees only the text.
 */
function buildPage(initialContent: string): CreateStartUpPageContainer {
  const text = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_WIDTH_PX,
    height: SCREEN_HEIGHT_PX,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: TEXT_CONTAINER_ID,
    containerName: "wmata.main",
    isEventCapture: 1,
    content: initialContent,
  });
  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 1,
    height: 1,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: LIST_CONTAINER_ID,
    containerName: "wmata.scroll",
    isEventCapture: 1,
  });
  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [text],
    listObject: [list],
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

  // Render-loop guard: ignore events that arrive after unmount.
  const render = async (): Promise<void> => {
    if (!active) return;
    const lines = screen.view(snapshot, nav);
    const update = new TextContainerUpgrade({
      containerID: TEXT_CONTAINER_ID,
      content: joinForRender(lines),
    });
    try {
      await bridge.textContainerUpgrade(update);
    } catch (err) {
      console.warn(`[glasses-host] textContainerUpgrade failed:`, err);
    }
  };

  // Mount the page. A non-success result still leaves event handlers
  // wired so the user can double-tap out.
  const initialContent = joinForRender(screen.view(snapshot, nav));
  try {
    const result = await bridge.createStartUpPageContainer(
      buildPage(initialContent),
    );
    if (result !== StartUpPageCreateResult.success) {
      console.warn(
        `[glasses-host] createStartUpPageContainer returned non-success: ${String(result)}`,
      );
    }
  } catch (err) {
    console.warn(`[glasses-host] createStartUpPageContainer threw:`, err);
  }

  // Run one tick (fetch + re-render). Defensive try/catch: a screen's
  // `tick` is contracted not to throw, but we treat the contract as
  // best-effort so a buggy screen can't take down the page.
  const runTick = async (): Promise<void> => {
    if (!active || !screen.tick) return;
    try {
      const next = await screen.tick(snapshot);
      if (!active) return;
      snapshot = next;
      await render();
    } catch (err) {
      console.warn(`[glasses-host] tick threw:`, err);
    }
  };

  // Wire up auto-refresh if the screen opted in. We deliberately fire
  // the first tick AFTER the initial mount-render, so the user sees
  // whatever the snapshot's `init()` produced (e.g. "Loading…") rather
  // than a blank container during the network round-trip.
  if (screen.tick && screen.tickIntervalMs && screen.tickIntervalMs > 0) {
    void runTick();
    tickTimer = setInterval(() => {
      void runTick();
    }, screen.tickIntervalMs);
  }

  const unsubscribe = bridge.onEvenHubEvent((event: EvenHubEvent) => {
    if (!active) return;

    // Lifecycle first — a SYSTEM_EXIT means the page is going away and
    // we should clean up regardless of what screen owns it.
    if (isSystemExit(event)) {
      void unmount();
      return;
    }

    const screenEvent = eventToScreenEvent(event);
    if (!screenEvent) return;

    const result = screen.reduce(snapshot, nav, screenEvent);
    nav = result.nav;

    const intent = result.navigate;
    if (intent) {
      // We re-render BEFORE the router decides what to do, so the user
      // sees an immediate "Loading…"-style transition if the router is
      // slow. The router itself is in charge of replacing/keeping us.
      void render().then(() => router.navigate(intent));
      return;
    }
    void render();
  });

  const unmount = async (): Promise<void> => {
    if (!active) return;
    active = false;
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    try {
      unsubscribe();
    } catch (err) {
      console.warn(`[glasses-host] unsubscribe threw:`, err);
    }
    try {
      await bridge.shutDownPageContainer(0);
    } catch (err) {
      console.warn(`[glasses-host] shutDownPageContainer threw:`, err);
    }
  };

  return unmount;
}
