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
  ListItemContainerProperty,
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
  ViewContext,
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
  // `itemContainer` is non-optional in the host-side (Rust simulator /
  // Dart glasses) deserialiser, even though the SDK's TypeScript model
  // marks it `?`. Omitting it makes the simulator reject the whole
  // `CreateStartUpPageContainer` with "missing field `itemContainer`",
  // after which container 1 doesn't exist and every subsequent
  // `textContainerUpgrade` fails with "container 1 not found". The
  // scroll list never actually renders any items, so we hand it a
  // zero-item descriptor purely to satisfy the schema.
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
    itemContainer: new ListItemContainerProperty({
      itemCount: 0,
      itemWidth: 0,
      isItemSelectBorderEn: 0,
      itemName: [],
    }),
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
  /**
   * Independent 1Hz timer that re-renders with a fresh wall clock.
   * Decoupled from `tickTimer` (the fetch cadence) so a hung fetch
   * cannot freeze the HUD clock or stall the stale-marker check.
   */
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Last content string we successfully pushed to the bridge. Used
   * to skip a redundant `textContainerUpgrade` when a clock tick
   * lands inside the same minute (i.e. the rendered string is byte-
   * identical to the previous one). Reset on unmount.
   */
  let lastRenderedContent: string | null = null;

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
    const lines = screen.view(snapshot, nav, makeCtx());
    const content = joinForRender(lines);
    if (content === lastRenderedContent) return;
    const update = new TextContainerUpgrade({
      containerID: TEXT_CONTAINER_ID,
      content,
    });
    try {
      await bridge.textContainerUpgrade(update);
      lastRenderedContent = content;
    } catch (err) {
      console.warn(`[glasses-host] textContainerUpgrade failed:`, err);
    }
  };

  // Mount the page. A non-success result still leaves event handlers
  // wired so the user can double-tap out.
  const initialContent = joinForRender(screen.view(snapshot, nav, makeCtx()));
  lastRenderedContent = initialContent;
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

  // Wire up the always-on 1Hz clock tick. This is independent of the
  // fetch interval (and runs whether or not the screen opted into a
  // `tick`/`tickIntervalMs`). It calls `render()` with a freshly
  // stamped `ctx.nowMs`; the de-dup cache means most ticks are no-ops
  // (HH:MM doesn't change inside the same minute). The whole point
  // is to keep the visible clock advancing even while a fetch is hung.
  clockTimer = setInterval(() => {
    if (!active) return;
    void render();
  }, CLOCK_TICK_MS);

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
    lastRenderedContent = null;
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
