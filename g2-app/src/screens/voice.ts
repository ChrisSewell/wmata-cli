// Voice (ASR) screen — fuzzy-match a spoken station name and jump to
// the Predictions screen for it.
//
// User journey:
//   1. Tap VOICE LOOKUP on Home  -> land here, mic auto-enables.
//   2. Speak a station name; partial transcripts stream in and render
//      live on the screen.
//   3. On a silence boundary (or a TAP confirm) the live transcript is
//      handed to the injected `searchFn`, which returns up to 3
//      candidate stations.
//   4. Unique match    -> emit `{ to: 'predictions', stationCode }`.
//      Multiple match  -> show all candidates; SCROLL_UP / SCROLL_DOWN
//                         cycle the highlight, TAP confirms the
//                         highlighted candidate.
//      No match        -> show "No match.", TAP retries (re-enters
//                         `listening`).
//   5. DOUBLE_TAP from any phase returns to Home (the non-root
//      convention).
//
// Architecture (mirrors Predictions / Incidents — pure-view + reducer):
//
//   - `view` and `reduce` are total, deterministic functions of
//     `(snapshot, nav, event)`. They have no SDK imports, no
//     `setTimeout`, no DOM, no `Date.now()`. The reducer is allowed to
//     return a new `snapshot` (via `ReduceResult.snapshot`) but never
//     performs side effects.
//   - The asynchronous moving parts — the microphone, the STT stream,
//     the silence detector, the search call — all live in `onMount`,
//     which the host invokes after page creation. The host hands
//     `onMount` a `dispatch(event)` function; the STT subscriber turns
//     each callback into a `ScreenEvent` (`TRANSCRIPT`,
//     `TRANSCRIPT_SILENCE`, `RESOLVE_RESULT`, `RESOLVE_ERROR`) which
//     flows through `screen.reduce` like any touchpad gesture.
//
// Search side-effect:
//
//   The reducer transitions to `'resolving'` on `TRANSCRIPT_SILENCE`
//   (or on TAP confirm in `listening`) but does NOT call `searchFn` —
//   the reducer is pure. Instead, `onMount` keeps a small closure-
//   local mirror of the last transcript and runs `searchFn` itself in
//   the STT callback right after dispatching the silence event,
//   dispatching the result as `RESOLVE_RESULT` (or `RESOLVE_ERROR`)
//   when it settles.
//
// STT engine boundary:
//
//   The `SttEngine` interface is the seam between this screen and any
//   real cloud-speech provider. For tests we ship `MockSttEngine`; for
//   production we expose `createSttEngine()`, which is intentionally
//   wired to throw a clear "Not yet configured" error so the failure
//   message tells the next developer exactly where to plug in their
//   preferred provider.

import type { Station } from "../wmata";
import type { VoiceTargets } from "../storage/settings";
import { LINE_WIDTH, padRight, truncate } from "../ui/render";
import { abbreviateStation, lineGlyph } from "../ui/format";
import type {
  NavIntent,
  ReduceResult,
  Screen,
  ScreenEvent,
  ViewContext,
} from "./router";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DeepgramSttEngine } from "../stt/deepgram";

// ---------------------------------------------------------------------------
// Intent resolver — keyword pre-pass before fuzzy station match
// ---------------------------------------------------------------------------

/**
 * Result of intent resolution. Either we recognized a navigation
 * keyword (in which case the screen shortcut-navigates) or we fall
 * through to the existing fuzzy-station search.
 */
export type VoiceIntent =
  | { kind: "navigate"; intent: NavIntent }
  | { kind: "station-match"; query: string };

/**
 * Strip common verbal prefixes ("go ", "take me ", "show me ", etc.)
 * so phrasings like "take me home" map to the same intent as "home".
 * The list is exact-stem only — no fuzzy matching, since STT noise
 * is already lossy enough.
 */
const VERBAL_PREFIXES: readonly string[] = [
  "take me ",
  "take me to ",
  "go to ",
  "go ",
  "show me ",
  "show ",
  "what's ",
  "what is ",
  "when is ",
  "open ",
];

function stripVerbalPrefix(transcript: string): string {
  let s = transcript;
  for (const p of VERBAL_PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      // Don't loop — strip at most one prefix so "go take me home"
      // still falls through to station match.
      break;
    }
  }
  return s.trim();
}

/**
 * Map a transcript onto either a navigation intent (recognized
 * keyword) or a station-match fallback. Pure: no side effects, no
 * dependencies beyond the user's labelled `voiceTargets`.
 *
 * Keywords currently handled:
 *
 *   "home" / "office home" -> predictions(voiceTargets.home)
 *   "work" / "office"      -> predictions(voiceTargets.work)
 *   "alerts" / "incidents" / "delays"
 *                          -> incidents
 *   "elevators" / "outages" / "access"
 *                          -> elevator
 *   "last train"           -> predictions(voiceTargets.home)
 *
 * Anything else (including keywords whose target is unset) falls
 * through to the station-match path so the user's existing
 * fuzzy-search flow keeps working.
 */
export function resolveVoiceIntent(
  transcript: string,
  voiceTargets: VoiceTargets,
): VoiceIntent {
  const fallback: VoiceIntent = {
    kind: "station-match",
    query: transcript,
  };
  if (typeof transcript !== "string") return fallback;
  const normalised = stripVerbalPrefix(transcript.trim().toLowerCase());
  if (normalised.length === 0) return fallback;

  // Home / work shortcuts (gated on the target being configured).
  if (normalised === "home") {
    if (voiceTargets.home.length === 0) return fallback;
    return {
      kind: "navigate",
      intent: { to: "predictions", stationCode: voiceTargets.home },
    };
  }
  if (normalised === "work" || normalised === "office") {
    if (voiceTargets.work.length === 0) return fallback;
    return {
      kind: "navigate",
      intent: { to: "predictions", stationCode: voiceTargets.work },
    };
  }

  // Alerts / incidents.
  if (
    normalised === "alerts" ||
    normalised === "incidents" ||
    normalised === "delays"
  ) {
    return { kind: "navigate", intent: { to: "incidents" } };
  }

  // Elevator outages.
  if (
    normalised === "elevators" ||
    normalised === "escalators" ||
    normalised === "outages" ||
    normalised === "access"
  ) {
    return { kind: "navigate", intent: { to: "elevator" } };
  }

  // Journey / commute glance.
  if (
    normalised === "journey" ||
    normalised === "commute" ||
    normalised === "trip"
  ) {
    return { kind: "navigate", intent: { to: "journey" } };
  }

  // Last-train glance. Routes to predictions at the home station
  // because that's where the late-night row will surface; the
  // station context matters more than the keyword itself.
  if (normalised === "last train" && voiceTargets.home.length > 0) {
    return {
      kind: "navigate",
      intent: { to: "predictions", stationCode: voiceTargets.home },
    };
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Public contract: SttEngine
// ---------------------------------------------------------------------------

/**
 * Streaming speech-to-text adapter. Implementations stream partial /
 * final transcripts and report silence boundaries so the screen knows
 * when to attempt a match.
 *
 * The screen never sees raw PCM frames — those are buffered inside the
 * concrete engine. Keeping the interface narrow this way means we can
 * swap providers (Whisper / Deepgram / on-device) without touching the
 * reducer or the view.
 */
export interface SttEngine {
  /**
   * Open the stream. The caller writes 16-bit signed PCM frames
   * (16 kHz, mono) into the returned `write`. `close` shuts the stream
   * down — it MUST be safe to call multiple times (idempotent) so the
   * host can call it from `onUnmount` even after an internal `onError`
   * has already torn the stream down.
   *
   * Callback semantics:
   *   - `onTranscript(text, isFinal=false)` — partial transcript, may
   *     fire many times. `text` is the cumulative best-guess so far,
   *     not just the new tail.
   *   - `onTranscript(text, isFinal=true)` — the engine has committed
   *     to this transcript; further partials will start fresh.
   *   - `onSilence()` — the engine has detected an end-of-utterance
   *     pause. This is the cue to attempt a search.
   *   - `onError(err)` — the stream is dead. The engine should clean
   *     up internally; the screen will move to `phase: 'error'`.
   */
  start(callbacks: {
    onTranscript: (text: string, isFinal: boolean) => void;
    onSilence: () => void;
    onError: (err: Error) => void;
  }): {
    /** Forward a binary PCM frame to the underlying provider. */
    write(pcm: Uint8Array): void;
    /** Shut the stream down. Idempotent. */
    close(): void;
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Resolution phase of the screen.
 *
 *   - `listening`  : mic is on; transcript is streaming in.
 *   - `resolving`  : silence detected; awaiting the search call.
 *   - `matches`    : 2+ candidates; user cycles with TAP.
 *   - `noMatch`    : zero candidates; user retries with TAP.
 *   - `error`      : something blew up (STT or search). User can
 *                    double-tap home.
 *
 * Note: a unique-match transition does NOT live as a phase; the
 * reducer emits `navigate: { to: 'predictions', stationCode }`
 * directly on `RESOLVE_RESULT` when `matches.length === 1`, so the
 * screen never lingers on a "resolved" state.
 */
export type VoicePhase =
  | "listening"
  | "resolving"
  | "matches"
  | "noMatch"
  | "error";

/** Data the Voice screen renders against. */
export interface VoiceSnapshot {
  /** Current transcript, possibly partial. */
  transcript: string;
  /** Resolution state machine; see `VoicePhase`. */
  phase: VoicePhase;
  /** Candidate stations after a search; capped at MAX_MATCHES. */
  matches: Station[];
  /**
   * Index into `matches` for the cycle-select highlight. SCROLL_UP /
   * SCROLL_DOWN cycle this index; TAP confirms the highlighted match.
   */
  matchIndex: number;
  /** Error message if `phase === 'error'`. */
  errorMessage: string | null;
  /**
   * The last query we sent to `searchFn`. Held so the `noMatch` view
   * can quote it back to the user verbatim — they spoke it, they
   * deserve to see what we heard.
   */
  lastQuery: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of matches surfaced to the user. */
export const MAX_MATCHES = 3;

/**
 * Window of the live transcript we render in `listening` phase.
 *
 * We show the *tail* of the transcript so the user always sees the
 * most recent words they spoke. 22 chars leaves room for the
 * single-char highlight prefix ("> ") that introduces the transcript
 * line — prefix(2) + window(22) = LINE_WIDTH(24).
 */
export const TRANSCRIPT_WINDOW = 22;

/** Minimum chars in a transcript before we'll attempt a search. */
export const MIN_QUERY_LENGTH = 2;

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/**
 * Format an epoch-ms timestamp as a 12-hour clock string (` 9:05a` /
 * `12:32p`). Identical helper to the Predictions / Incidents /
 * Elevator / Journey screens. Duplicated here so the Voice module
 * has no cross-screen import.
 */
export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return " --:--";
  const d = new Date(epochMs);
  const h24 = d.getHours();
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  const hh = String(h12).padStart(2, " ");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ap = h24 < 12 ? "a" : "p";
  return `${hh}:${mm}${ap}`;
}

/**
 * Render the header row: `VOICE` + a right-aligned 12-hour clock.
 *
 * Always returns exactly `LINE_WIDTH` columns.
 */
export function renderHeader(nowMs: number): string {
  const left = "VOICE";
  const clock = formatClock(nowMs);
  // left(5) + spaces + clock(6) = LINE_WIDTH(24)  -> 13 spaces.
  const spaces = Math.max(1, LINE_WIDTH - left.length - clock.length);
  return truncate(left + " ".repeat(spaces) + clock, LINE_WIDTH);
}

/**
 * Squash whitespace and tail-slice the transcript so the last
 * `TRANSCRIPT_WINDOW` chars are visible. Long transcripts get an
 * `…` prefix to flag that text was clipped from the front.
 *
 * Always returns ≤ `TRANSCRIPT_WINDOW` chars.
 */
export function formatTranscriptWindow(transcript: string): string {
  const compact = transcript.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "";
  if (compact.length <= TRANSCRIPT_WINDOW) return compact;
  // Show the tail of the transcript so the user sees their most recent
  // words. Prefix with `…` to flag the clip.
  return "…" + compact.slice(compact.length - (TRANSCRIPT_WINDOW - 1));
}

/**
 * Render one match row for the `matches` phase.
 *
 * Width contract: returns a string of exactly `LINE_WIDTH` columns.
 * Cells: prefix(2) + name(10) + " "(1) + lines(11) = 24.
 */
export function renderMatchRow(
  station: Station,
  isHighlighted: boolean,
): string {
  const prefix = isHighlighted ? "> " : "  ";
  const name = padRight(abbreviateStation(station.Name, 10), 10);
  const lineCodes: string[] = [];
  for (const code of [
    station.LineCode1,
    station.LineCode2,
    station.LineCode3,
    station.LineCode4,
  ]) {
    if (code && lineGlyph(code) !== "--") lineCodes.push(code);
  }
  // 11-col lines cell; truncate if a future malformed station has
  // more than 3 codes (would only show up if the wire shape changes).
  const lines = padRight(truncate(lineCodes.join(" "), 11), 11);
  return prefix + name + " " + lines;
}

/**
 * Build the initial snapshot. Public so `main.ts` and tests can
 * pre-seed any state if needed; production callers just take the
 * default ("listening" with an empty transcript).
 */
export function initialVoiceSnapshot(): VoiceSnapshot {
  return {
    transcript: "",
    phase: "listening",
    matches: [],
    matchIndex: 0,
    errorMessage: null,
    lastQuery: "",
  };
}

// ---------------------------------------------------------------------------
// Screen impl
// ---------------------------------------------------------------------------

/**
 * Build the Voice screen.
 *
 *   - `stt`      — streaming speech-to-text engine; called inside
 *                  `onMount`. Tests inject `MockSttEngine`; production
 *                  uses whatever `createSttEngine()` returns.
 *   - `searchFn` — fuzzy station search; in production wired to
 *                  `searchStations(client, q)`. Must reject only on
 *                  network errors — an empty match list is a normal
 *                  outcome ("no match").
 *   - `initial`  — optional snapshot overrides for tests that want to
 *                  pre-load a phase (e.g. start in `matches` to
 *                  exercise cycling).
 */
export function makeVoiceScreen(
  stt: SttEngine,
  searchFn: (query: string) => Promise<Station[]>,
  initial?: Partial<VoiceSnapshot>,
  /**
   * Optional pure intent resolver. When provided, `onMount` consults
   * it before calling `searchFn` and short-circuits to a direct
   * navigation when the resolver returns one. When omitted the
   * screen behaves exactly like v1.1 (always fuzzy-search).
   */
  intentResolver?: (transcript: string) => VoiceIntent,
): Screen<VoiceSnapshot> {
  const base = initialVoiceSnapshot();
  const seeded: VoiceSnapshot = { ...base, ...(initial ?? {}) };

  /**
   * Closure-local handle to the active STT pipe. Lives across
   * `onMount` / `onUnmount` calls; the host guarantees only one mount
   * per screen value. `null` between unmount and the next mount.
   */
  let activePipe: { write(pcm: Uint8Array): void; close(): void } | null =
    null;

  /**
   * Unsubscribe handle for the raw `bridge.onEvenHubEvent` audio
   * subscription. Wired up after the STT pipe is opened in `onMount`;
   * `onUnmount` calls it before tearing the pipe down.
   */
  let audioUnsub: (() => void) | null = null;

  /**
   * Bump the generation counter that gates in-flight `searchFn`
   * resolutions. Set by `onMount`, called by `onUnmount` so any
   * `searchFn` promise still pending after teardown becomes a no-op
   * when it settles. Null until `onMount` has wired the counter.
   */
  let bumpSearchGen: (() => void) | null = null;

  /**
   * Closure-local mirror of the latest transcript. Updated whenever an
   * `onTranscript` callback fires. We hold this here (rather than
   * reading it from the snapshot on each STT callback) because the
   * STT engine drives the read — there's no clean way for the
   * callback to grab a fresh snapshot reference without leaking the
   * host's mutable state. The mirror is purely an internal
   * optimisation; the canonical transcript still lives in the
   * snapshot via the reducer.
   */
  let liveTranscript = seeded.transcript;

  return {
    name: "voice",
    init: () => seeded,

    view(snapshot, _nav, ctx: ViewContext): string[] {
      const lines: string[] = [];
      lines.push(renderHeader(ctx.nowMs));

      switch (snapshot.phase) {
        case "listening": {
          lines.push(truncate("Listening...", LINE_WIDTH));
          lines.push("");
          const window = formatTranscriptWindow(snapshot.transcript);
          // Always render the transcript line, even when empty, so the
          // total line count is stable while the user is speaking and
          // the bridge dedupe doesn't oscillate the row height. The
          // `> ` prefix marks the live-input row visually.
          lines.push(truncate("> " + window, LINE_WIDTH));
          lines.push("");
          lines.push(truncate("(double-tap to cancel)", LINE_WIDTH));
          return lines;
        }
        case "resolving": {
          lines.push(truncate("Resolving...", LINE_WIDTH));
          lines.push("");
          const q = formatTranscriptWindow(snapshot.lastQuery);
          lines.push(truncate("> " + q, LINE_WIDTH));
          return lines;
        }
        case "matches": {
          lines.push(truncate("Did you mean:", LINE_WIDTH));
          lines.push("");
          for (let i = 0; i < snapshot.matches.length; i++) {
            const station = snapshot.matches[i]!;
            lines.push(renderMatchRow(station, i === snapshot.matchIndex));
          }
          lines.push("");
          lines.push(truncate("(scroll=pick, tap=ok)", LINE_WIDTH));
          return lines;
        }
        case "noMatch": {
          lines.push(truncate("No match.", LINE_WIDTH));
          lines.push("");
          // Quote the query verbatim so the user can tell whether the
          // STT misheard them or the station name is genuinely off.
          const q = formatTranscriptWindow(snapshot.lastQuery);
          lines.push(truncate('"' + q + '"', LINE_WIDTH));
          lines.push("");
          lines.push(truncate("(tap to retry)", LINE_WIDTH));
          return lines;
        }
        case "error": {
          lines.push(truncate("Error.", LINE_WIDTH));
          lines.push("");
          lines.push(
            truncate(snapshot.errorMessage ?? "Unknown error", LINE_WIDTH),
          );
          lines.push("");
          lines.push(truncate("(double-tap to exit)", LINE_WIDTH));
          return lines;
        }
      }
    },

    reduce(
      snapshot,
      nav,
      event: ScreenEvent,
    ): ReduceResult<VoiceSnapshot> {
      // DOUBLE_TAP always returns to Home (the non-root convention).
      // Carved out at the top so every phase shares one consistent
      // exit gesture.
      if (event.type === "DOUBLE_TAP") {
        return { nav, navigate: { to: "home" } };
      }

      switch (event.type) {
        case "TRANSCRIPT": {
          // Partial / final transcript update from the STT engine.
          // Only meaningful while we're listening; ignore stragglers
          // that arrive after we've moved into `resolving` / `matches`
          // / `noMatch`. The host glue stops the stream on those
          // transitions, but a callback already queued in the event
          // loop can still land here.
          if (snapshot.phase !== "listening") return { nav };
          return {
            nav,
            snapshot: { ...snapshot, transcript: event.text },
          };
        }
        case "TRANSCRIPT_SILENCE": {
          // End-of-utterance pause. Move into `resolving` so the view
          // can show a "Resolving..." cue while `searchFn` runs out
          // of band in `onMount`. If we don't have anything worth
          // searching for, stay in `listening` so the user can keep
          // speaking.
          if (snapshot.phase !== "listening") return { nav };
          const q = snapshot.transcript.trim();
          if (q.length < MIN_QUERY_LENGTH) return { nav };
          return {
            nav,
            snapshot: {
              ...snapshot,
              phase: "resolving",
              lastQuery: q,
            },
          };
        }
        case "RESOLVE_NAVIGATE": {
          // Voice intent shortcut — fire the requested navigation
          // immediately. The screen is about to be unmounted so we
          // don't bother updating the snapshot.
          return { nav, navigate: event.intent };
        }
        case "RESOLVE_RESULT": {
          // The host glue dispatched this after `searchFn` settled.
          // Three branches based on candidate count.
          if (event.matches.length === 1) {
            // Unique match → go straight to predictions. Don't
            // bother updating the snapshot; the screen is about to
            // be unmounted by the router.
            const station = event.matches[0]!;
            return {
              nav,
              navigate: { to: "predictions", stationCode: station.Code },
            };
          }
          if (event.matches.length === 0) {
            return {
              nav,
              snapshot: {
                ...snapshot,
                phase: "noMatch",
                matches: [],
                matchIndex: 0,
              },
            };
          }
          return {
            nav,
            snapshot: {
              ...snapshot,
              phase: "matches",
              matches: event.matches.slice(0, MAX_MATCHES),
              matchIndex: 0,
            },
          };
        }
        case "RESOLVE_ERROR": {
          return {
            nav,
            snapshot: {
              ...snapshot,
              phase: "error",
              errorMessage: event.message,
            },
          };
        }
        case "TAP": {
          if (snapshot.phase === "matches") {
            // TAP confirms the highlighted candidate. The user cycles
            // through candidates with SCROLL_UP / SCROLL_DOWN; TAP is
            // the commit gesture. An empty matches list shouldn't be
            // reachable from the reducer (the resolver routes 0-match
            // results to `noMatch`), but guard anyway so a malformed
            // snapshot can't navigate to a bogus station code.
            if (snapshot.matches.length === 0) return { nav };
            const idx = Math.min(
              Math.max(0, snapshot.matchIndex),
              snapshot.matches.length - 1,
            );
            return {
              nav,
              navigate: {
                to: "predictions",
                stationCode: snapshot.matches[idx]!.Code,
              },
            };
          }
          if (snapshot.phase === "noMatch") {
            // Retry — reset to listening with an empty transcript.
            return {
              nav,
              snapshot: {
                ...snapshot,
                phase: "listening",
                transcript: "",
                lastQuery: "",
                matches: [],
                matchIndex: 0,
              },
            };
          }
          if (snapshot.phase === "listening") {
            // User wants to commit the current transcript without
            // waiting for silence. Same effect as TRANSCRIPT_SILENCE.
            const q = snapshot.transcript.trim();
            if (q.length < MIN_QUERY_LENGTH) return { nav };
            return {
              nav,
              snapshot: {
                ...snapshot,
                phase: "resolving",
                lastQuery: q,
              },
            };
          }
          // No TAP action in `resolving` (in-flight) or `error`.
          return { nav };
        }
        case "SCROLL_UP":
        case "SCROLL_DOWN": {
          // Scroll is the cycle gesture in the `matches` phase: DOWN
          // advances the highlight, UP retreats it. In every other
          // phase scrolling is a no-op (the list-navigation idiom only
          // makes sense once we have a list of candidates on screen).
          if (snapshot.phase !== "matches") return { nav };
          const n = snapshot.matches.length;
          if (n <= 1) return { nav };
          const delta = event.type === "SCROLL_DOWN" ? 1 : -1;
          // `((x % n) + n) % n` keeps the result in [0, n) for both
          // forward and backward cycles regardless of the sign of `x`.
          const nextIdx = ((snapshot.matchIndex + delta) % n + n) % n;
          if (nextIdx === snapshot.matchIndex) return { nav };
          return {
            nav,
            snapshot: { ...snapshot, matchIndex: nextIdx },
          };
        }
        default:
          return { nav };
      }
    },

    /**
     * Side-effect setup: enable the microphone, start the STT stream,
     * and bridge STT callbacks → host `dispatch`. The async
     * `searchFn` is also driven from here: when the STT signals
     * silence, we dispatch `TRANSCRIPT_SILENCE` (moves the reducer
     * into `'resolving'`), kick off the search, then dispatch
     * `RESOLVE_RESULT` / `RESOLVE_ERROR` when it settles.
     *
     * Race-safety:
     *
     *   The STT can fire `onSilence` twice in quick succession (some
     *   engines do this on a long pause that crosses two windows). If
     *   the FIRST `searchFn` resolves AFTER the SECOND, a naive `.then`
     *   would let the older result clobber the newer one — flipping
     *   `noMatch` ↔ `matches` in user-visible ways. We use a closure-
     *   local `searchGen` counter (same pattern as the host's
     *   `tickGeneration`): each silence-driven search captures its own
     *   `myGen = ++searchGen`; on settle, if `myGen !== searchGen` we
     *   drop the result. `onUnmount` bumps the counter too, so any
     *   in-flight `searchFn` that settles after unmount becomes a
     *   no-op (belt-and-suspenders — the host's `dispatch` already
     *   short-circuits when `!active`).
     */
    async onMount(
      bridge: EvenAppBridge,
      dispatch: (event: ScreenEvent) => void,
    ): Promise<void> {
      // Generation counter for in-flight `searchFn` calls. Each
      // silence-triggered search captures its own value; only the
      // newest call may write its result back via dispatch.
      let searchGen = 0;

      try {
        // `audioControl` returns a `Promise<boolean>`: the SDK can
        // either reject (network / IPC failure) OR resolve to `false`
        // (the mic-permission gate denied us, or the device is
        // already in use). Both must surface as a `RESOLVE_ERROR` —
        // otherwise we'd start the STT stream over a dead mic and
        // leave the user staring at a permanently-empty
        // "Listening..." screen.
        const ok = await bridge.audioControl(true);
        if (!ok) {
          dispatch({
            type: "RESOLVE_ERROR",
            message: "Microphone unavailable.",
          });
          return;
        }
      } catch (err) {
        // If the mic can't open we can't do anything useful here.
        // Surface as an error phase so the user sees a clear message
        // rather than a permanently-empty "Listening..." screen.
        const message =
          err instanceof Error ? err.message : String(err ?? "audio failed");
        dispatch({ type: "RESOLVE_ERROR", message });
        return;
      }

      activePipe = stt.start({
        onTranscript: (text, isFinal) => {
          liveTranscript = text;
          dispatch({ type: "TRANSCRIPT", text, isFinal });
        },
        onSilence: () => {
          const q = liveTranscript.trim();
          dispatch({ type: "TRANSCRIPT_SILENCE" });
          // The reducer rejects too-short queries (stays in listening);
          // mirror that gate here so we don't waste a network round
          // trip.
          if (q.length < MIN_QUERY_LENGTH) return;

          // Intent resolution: keyword shortcuts (e.g. "home" /
          // "alerts") bypass the fuzzy search entirely. If the
          // resolver returns a navigation intent, dispatch it
          // straight away and skip `searchFn`.
          if (intentResolver) {
            const intent = intentResolver(q);
            if (intent.kind === "navigate") {
              dispatch({
                type: "RESOLVE_NAVIGATE",
                intent: intent.intent,
              });
              return;
            }
            // station-match — fall through to searchFn with the
            // possibly-rewritten query.
          }

          // Capture our generation BEFORE awaiting. If a second
          // silence event fires while this search is in flight, it
          // will bump `searchGen` and our `.then` / `.catch` below
          // will detect the mismatch and drop the stale result.
          const myGen = ++searchGen;
          void searchFn(q).then(
            (matches) => {
              if (myGen !== searchGen) return; // stale — newer search in flight
              dispatch({
                type: "RESOLVE_RESULT",
                matches: matches.slice(0, MAX_MATCHES),
              });
            },
            (err: unknown) => {
              if (myGen !== searchGen) return; // stale — drop the error too
              const message =
                err instanceof Error
                  ? err.message
                  : String(err ?? "search failed");
              dispatch({ type: "RESOLVE_ERROR", message });
            },
          );
        },
        onError: (err) => {
          dispatch({ type: "RESOLVE_ERROR", message: err.message });
        },
      });

      // Subscribe to raw EvenHub events so we can pluck `audioPcm`
      // frames off and forward them into the STT pipe. The host's
      // normalized subscription stays active in parallel — both can
      // co-exist; the SDK fans every event out to every subscriber.
      const pipe = activePipe;
      audioUnsub = bridge.onEvenHubEvent((event) => {
        const pcm = event.audioEvent?.audioPcm;
        if (pcm) pipe.write(pcm);
      });

      // Expose the generation bump for `onUnmount`. We stash it on
      // the closure-local `bumpSearchGen` so `onUnmount` doesn't need
      // to re-declare the counter (which would be a separate variable
      // and miss in-flight searches).
      bumpSearchGen = () => {
        searchGen += 1;
      };
    },

    async onUnmount(bridge: EvenAppBridge): Promise<void> {
      // Bump the generation FIRST so any `searchFn` already in flight
      // detects the mismatch when it settles and drops its result.
      // The host's `dispatch` early-returns on `!active`, but we keep
      // this gate local so future readers can see the intent at the
      // call site.
      if (bumpSearchGen) {
        bumpSearchGen();
        bumpSearchGen = null;
      }
      // Unsubscribe from raw audio events BEFORE closing the pipe so a
      // late frame doesn't sneak into a torn-down WebSocket.
      if (audioUnsub) {
        try {
          audioUnsub();
        } catch (err) {
          console.warn(`[voice] audio unsub threw:`, err);
        }
        audioUnsub = null;
      }
      if (activePipe) {
        try {
          activePipe.close();
        } catch (err) {
          console.warn(`[voice] pipe.close threw:`, err);
        }
        activePipe = null;
      }
      try {
        await bridge.audioControl(false);
      } catch (err) {
        // Swallow — there's nothing more we can do, and the page is
        // tearing down anyway.
        console.warn(`[voice] audioControl(false) failed:`, err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MockSttEngine — test helper, also exported as a starting point for
// production wiring (see `createSttEngine` below for the real-engine
// placeholder).
// ---------------------------------------------------------------------------

/**
 * In-memory `SttEngine` whose transcripts / silence / errors are
 * driven manually from tests. Useful as a starting reference for a
 * production engine: the surface a real provider needs to implement is
 * exactly the four `simulate*` triggers below.
 */
export class MockSttEngine implements SttEngine {
  private cb: {
    onTranscript: (text: string, isFinal: boolean) => void;
    onSilence: () => void;
    onError: (err: Error) => void;
  } | null = null;
  /** True once `start` has returned and before `close()` is called. */
  public active = false;
  /** Count of `close()` calls for assertions. */
  public stopCount = 0;
  /** Every PCM frame written through `pipe.write` (for assertions). */
  public writes: Uint8Array[] = [];

  start(callbacks: {
    onTranscript: (text: string, isFinal: boolean) => void;
    onSilence: () => void;
    onError: (err: Error) => void;
  }): { write(pcm: Uint8Array): void; close(): void } {
    this.cb = callbacks;
    this.active = true;
    return {
      write: (pcm: Uint8Array): void => {
        this.writes.push(pcm);
      },
      close: (): void => {
        this.active = false;
        this.cb = null;
        this.stopCount += 1;
      },
    };
  }

  /** Drive a partial transcript. */
  simulatePartial(text: string): void {
    this.cb?.onTranscript(text, false);
  }

  /** Drive a final transcript. */
  simulateFinal(text: string): void {
    this.cb?.onTranscript(text, true);
  }

  /** Drive an end-of-utterance silence boundary. */
  simulateSilence(): void {
    this.cb?.onSilence();
  }

  /** Drive a stream error. */
  simulateError(message: string): void {
    this.cb?.onError(new Error(message));
  }
}

// ---------------------------------------------------------------------------
// Production STT factory — wired to Deepgram.
// ---------------------------------------------------------------------------

/**
 * Build the production `SttEngine` from a Deepgram API key.
 *
 *   - Empty `apiKey` → throw a grep-able "STT provider not configured"
 *     error. The router catches this and bounces back to Home, so the
 *     user gets a clear "Voice unavailable" message rather than a
 *     half-broken Voice screen.
 *   - Non-empty `apiKey` → return a new `DeepgramSttEngine`. The audio
 *     pipe still has to be fed PCM frames by the screen's `onMount`;
 *     this factory only builds the provider object.
 *
 * The error message names this file (and the storage helper) so the
 * next developer's `grep` lands on the wire-up site, not the provider.
 */
export function createSttEngine(apiKey: string): SttEngine {
  if (apiKey.trim().length === 0) {
    throw new Error(
      "createSttEngine: STT provider not configured — see " +
        "src/screens/voice.ts and add a Deepgram API key via the " +
        "companion settings screen (storage key wmata.g2.sttApiKey).",
    );
  }
  return new DeepgramSttEngine(apiKey);
}
