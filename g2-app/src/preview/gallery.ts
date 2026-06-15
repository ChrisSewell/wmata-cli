// Screens-gallery composer. Imports each Screen factory, builds it
// against its fixture snapshot, calls `view()`, and renders the
// resulting 24-col rows into a styled monospace HTML block.
//
// Each card includes:
//   - Title + caption describing the state
//   - The rendered output verbatim (preserving every space)
//   - Optional `nav` highlight overlay for cursor-sensitive states
//
// The composer runs entirely in the browser — no SDK bridge needed.
// `npm run dev` then visit `/preview.html`.

import {
  flattenSections,
  initialNav,
  type NavState,
  type Screen,
  type ViewContext,
} from '../screens/router';
import { LINE_WIDTH, USABLE_ROWS } from '../ui/render';

import { makeHomeScreen } from '../screens/home';
import { makePredictionsScreen } from '../screens/predictions';
import { makeIncidentsScreen } from '../screens/incidents';
import { makeElevatorScreen } from '../screens/elevator';
import { makeJourneyScreen } from '../screens/journey';
import { makeVoiceScreen, MockSttEngine } from '../screens/voice';
import { makeTutorialScreen } from '../screens/tutorial';

import * as F from './fixtures';

export interface ScreenCard<S> {
  title: string;
  caption: string;
  screen: Screen<S>;
  snapshot: S;
  nav: NavState;
  ctx: ViewContext;
}

/**
 * Build every gallery card. Each entry pairs a screen factory with
 * its snapshot fixture + the right `nav` and `nowMs` to surface the
 * intended state.
 */
export function buildCards(): ScreenCard<unknown>[] {
  const dayCtx: ViewContext = { nowMs: F.NOW };
  const eveningCtx: ViewContext = { nowMs: F.EVENING };
  const noopHomeFetcher = () => Promise.resolve([]);

  const cards: ScreenCard<unknown>[] = [];

  // Home -------------------------------------------------------------
  cards.push({
    title: 'Home — empty',
    caption: 'First boot, no favorites yet. Empty-state line count is locked at 4.',
    screen: makeHomeScreen(() => F.HOME_EMPTY) as Screen<unknown>,
    snapshot: F.HOME_EMPTY,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Home — 3 favorites',
    caption: 'No alerts. Cursor on the first favorite.',
    screen: makeHomeScreen(() => F.HOME_THREE_FAVS) as Screen<unknown>,
    snapshot: F.HOME_THREE_FAVS,
    nav: { highlightedIndex: 0 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Home — status glyph row',
    caption: 'Active alerts on RD + OR. Glyph row sits above the favorites.',
    screen: makeHomeScreen(() => F.HOME_WITH_ALERTS) as Screen<unknown>,
    snapshot: F.HOME_WITH_ALERTS,
    nav: { highlightedIndex: 0 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Home — alerts + ACCESS',
    caption:
      'Both synthetic rows: line-glyph alerts on top, ACCESS (2) for elevator outages just below.',
    screen: makeHomeScreen(() => F.HOME_WITH_ALERTS_AND_ACCESS) as Screen<unknown>,
    snapshot: F.HOME_WITH_ALERTS_AND_ACCESS,
    nav: { highlightedIndex: 0 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Home — quiet hours',
    caption:
      'Quiet hours active — both synthetic alert rows suppress even with active alerts. Data still refreshes in the background.',
    screen: makeHomeScreen(() => F.HOME_QUIET_HOURS) as Screen<unknown>,
    snapshot: F.HOME_QUIET_HOURS,
    nav: { highlightedIndex: 0 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Home — 5 favorites (cap)',
    caption: 'Maximum favorites. Header reads "5/5".',
    screen: makeHomeScreen(() => F.HOME_FIVE_FAVS) as Screen<unknown>,
    snapshot: F.HOME_FIVE_FAVS,
    nav: { highlightedIndex: 0 },
    ctx: dayCtx,
  });

  void noopHomeFetcher; // reserved for future tick-driven previews

  // Predictions ------------------------------------------------------
  const noopPred = () =>
    Promise.resolve({
      trains: [],
      incidentHeadline: null,
      lastTrainToday: null,
      pinnedPosition: null,
    });
  cards.push({
    title: 'Predictions — loading',
    caption: 'First mount, no fetch yet. Shows the Loading… cue + exit hint.',
    screen: makePredictionsScreen(noopPred, F.PRED_LOADING) as Screen<unknown>,
    snapshot: F.PRED_LOADING,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — three trains (default)',
    caption: 'Standard glance. Cursor hidden (WP-M opt-in).',
    screen: makePredictionsScreen(noopPred, F.PRED_THREE_TRAINS) as Screen<unknown>,
    snapshot: F.PRED_THREE_TRAINS,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — cursor visible',
    caption:
      'After the user scrolls or taps once. The `>` glyph replaces the second character of the line code on the highlighted row.',
    screen: makePredictionsScreen(noopPred, F.PRED_WITH_CURSOR) as Screen<unknown>,
    snapshot: F.PRED_WITH_CURSOR,
    nav: { highlightedIndex: 1 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — pinned train',
    caption:
      'The user TAP-pinned RD Glenmont. Summary row at top; `*` replaces the second glyph char on the pinned body row.',
    screen: makePredictionsScreen(noopPred, F.PRED_PINNED) as Screen<unknown>,
    snapshot: F.PRED_PINNED,
    nav: { highlightedIndex: 1 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — pinned + live position',
    caption:
      'WP-I: the pin carries a "N stops away" label + an ASCII line schematic with `*` on the user station and `@` on the train.',
    screen: makePredictionsScreen(noopPred, F.PRED_PINNED_WITH_POSITION) as Screen<unknown>,
    snapshot: F.PRED_PINNED_WITH_POSITION,
    nav: { highlightedIndex: 1 },
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — pinned train (gone)',
    caption:
      'WP-M: pinned train rolled off the predictions list. Renders "(gone)" for one tick before auto-clearing the pin.',
    screen: makePredictionsScreen(noopPred, F.PRED_PINNED_GONE) as Screen<unknown>,
    snapshot: F.PRED_PINNED_GONE,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — with incident footer',
    caption:
      'Truncated incident headline shows in a "! " footer row below the trains.',
    screen: makePredictionsScreen(noopPred, F.PRED_WITH_INCIDENT) as Screen<unknown>,
    snapshot: F.PRED_WITH_INCIDENT,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — stale marker (**)',
    caption: 'Two consecutive fetch failures. WP-A 3-state escalation.',
    screen: makePredictionsScreen(noopPred, F.PRED_STALE_TWO_FAILURES) as Screen<unknown>,
    snapshot: F.PRED_STALE_TWO_FAILURES,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — no data + error',
    caption:
      'First load failed and no prior data on hand. `?` clock marker + `? <error>` footer.',
    screen: makePredictionsScreen(noopPred, F.PRED_FETCH_ERROR_NO_DATA) as Screen<unknown>,
    snapshot: F.PRED_FETCH_ERROR_NO_DATA,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Predictions — late night (per-line)',
    caption:
      'WP-J: after 21:00 local, the per-line last-train row shows the earliest-out line first.',
    screen: makePredictionsScreen(noopPred, F.PRED_LATE_NIGHT) as Screen<unknown>,
    snapshot: F.PRED_LATE_NIGHT,
    nav: initialNav(),
    ctx: eveningCtx,
  });

  // Incidents --------------------------------------------------------
  const noopIncidents = () =>
    Promise.resolve({
      incidents: [],
      fetchedAt: F.NOW,
      fetchError: null,
    });
  cards.push({
    title: 'Incidents — empty',
    caption: 'No active alerts on the user\'s lines. Empty-state copy.',
    screen: makeIncidentsScreen(noopIncidents, F.INCIDENTS_EMPTY) as Screen<unknown>,
    snapshot: F.INCIDENTS_EMPTY,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Incidents — one alert',
    caption: 'Single incident with a multi-line wrapped description.',
    screen: makeIncidentsScreen(noopIncidents, F.INCIDENTS_ONE) as Screen<unknown>,
    snapshot: F.INCIDENTS_ONE,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Incidents — three alerts (scrollable)',
    caption:
      'Three alerts on different line sets. Scroll markers (`▾`) appear when content overflows the body budget.',
    screen: makeIncidentsScreen(noopIncidents, F.INCIDENTS_THREE) as Screen<unknown>,
    snapshot: F.INCIDENTS_THREE,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Incidents — fetch error',
    caption: "First-load failure. The `?` clock marker + dedicated error body.",
    screen: makeIncidentsScreen(noopIncidents, F.INCIDENTS_FETCH_ERROR) as Screen<unknown>,
    snapshot: F.INCIDENTS_FETCH_ERROR,
    nav: initialNav(),
    ctx: dayCtx,
  });

  // Elevator ---------------------------------------------------------
  const noopElev = () =>
    Promise.resolve({
      incidents: [],
      fetchedAt: F.NOW,
      fetchError: null,
    });
  cards.push({
    title: 'Elevator — empty',
    caption: 'No outages at the user\'s favorite stations.',
    screen: makeElevatorScreen(noopElev, F.ELEVATOR_EMPTY) as Screen<unknown>,
    snapshot: F.ELEVATOR_EMPTY,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Elevator — two outages',
    caption:
      'Mix of `E` (elevator) and `S` (escalator) per station. Multi-platform stations strip the entrance suffix.',
    screen: makeElevatorScreen(noopElev, F.ELEVATOR_TWO) as Screen<unknown>,
    snapshot: F.ELEVATOR_TWO,
    nav: initialNav(),
    ctx: dayCtx,
  });

  // Journey ----------------------------------------------------------
  const noopJourney = () =>
    Promise.resolve({
      legs: null,
      originName: '',
      destinationName: '',
      transferName: '',
      nextTrain: null,
    });
  cards.push({
    title: 'Journey — unconfigured',
    caption: "No origin / destination saved yet. Friendly empty state.",
    screen: makeJourneyScreen(noopJourney, F.JOURNEY_UNCONFIGURED) as Screen<unknown>,
    snapshot: F.JOURNEY_UNCONFIGURED,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Journey — loading',
    caption: 'First tick still pending. Shows the Loading cue.',
    screen: makeJourneyScreen(noopJourney, F.JOURNEY_LOADING) as Screen<unknown>,
    snapshot: F.JOURNEY_LOADING,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Journey — same-line + next train',
    caption:
      'Single-line route. Line summary + stop count + estimate + live next-train row.',
    screen: makeJourneyScreen(noopJourney, F.JOURNEY_SAME_LINE) as Screen<unknown>,
    snapshot: F.JOURNEY_SAME_LINE,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Journey — cross-line (two legs)',
    caption:
      'WP-K: OR → YL via L\'Enfant Plaza. Combined stops + dwell-aware travel estimate.',
    screen: makeJourneyScreen(noopJourney, F.JOURNEY_TWO_LEG) as Screen<unknown>,
    snapshot: F.JOURNEY_TWO_LEG,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Journey — not routable',
    caption:
      'Cross-line pair without a transfer. Prompts the user to pick one.',
    screen: makeJourneyScreen(noopJourney, F.JOURNEY_NOT_ROUTABLE) as Screen<unknown>,
    snapshot: F.JOURNEY_NOT_ROUTABLE,
    nav: initialNav(),
    ctx: dayCtx,
  });

  // Voice ------------------------------------------------------------
  const emptySearch = () => Promise.resolve([]);
  cards.push({
    title: 'Voice — listening',
    caption: 'Mic open, partial transcript streaming.',
    screen: makeVoiceScreen(
      new MockSttEngine(),
      emptySearch,
      F.VOICE_LISTENING,
    ) as Screen<unknown>,
    snapshot: F.VOICE_LISTENING,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Voice — resolving',
    caption: 'Silence detected, search in flight.',
    screen: makeVoiceScreen(
      new MockSttEngine(),
      emptySearch,
      F.VOICE_RESOLVING,
    ) as Screen<unknown>,
    snapshot: F.VOICE_RESOLVING,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Voice — matches (cycle)',
    caption: 'Two candidates. Scroll cycles `matchIndex`; TAP confirms.',
    screen: makeVoiceScreen(
      new MockSttEngine(),
      emptySearch,
      F.VOICE_MATCHES,
    ) as Screen<unknown>,
    snapshot: F.VOICE_MATCHES,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Voice — no match',
    caption: "Search returned no candidates. Quotes the user's query.",
    screen: makeVoiceScreen(
      new MockSttEngine(),
      emptySearch,
      F.VOICE_NO_MATCH,
    ) as Screen<unknown>,
    snapshot: F.VOICE_NO_MATCH,
    nav: initialNav(),
    ctx: dayCtx,
  });
  cards.push({
    title: 'Voice — error',
    caption: 'Mic permission denied or STT failure.',
    screen: makeVoiceScreen(
      new MockSttEngine(),
      emptySearch,
      F.VOICE_ERROR,
    ) as Screen<unknown>,
    snapshot: F.VOICE_ERROR,
    nav: initialNav(),
    ctx: dayCtx,
  });

  // Tutorial ---------------------------------------------------------
  cards.push({
    title: 'Tutorial — first-launch cheat sheet',
    caption: 'One-shot card. Any gesture dismisses and routes to Home.',
    screen: makeTutorialScreen() as Screen<unknown>,
    snapshot: {},
    nav: initialNav(),
    ctx: dayCtx,
  });

  return cards;
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

function renderCard(card: ScreenCard<unknown>): HTMLElement {
  const lines = flattenSections(
    card.screen.view(card.snapshot, card.nav, card.ctx),
  );
  const wrapper = el('section', { class: 'wmata-preview__card' });
  wrapper.appendChild(el('h2', { class: 'wmata-preview__title' }, [card.title]));
  wrapper.appendChild(
    el('p', { class: 'wmata-preview__caption' }, [card.caption]),
  );

  // The "panel" wrapper mimics the device frame; the inner <pre>
  // carries the actual rendered text in monospace.
  const panel = el('div', { class: 'wmata-preview__panel' });
  const pre = el('pre', { class: 'wmata-preview__pre' });
  // Pad each line to LINE_WIDTH so trailing-space differences are
  // visible (the device pads on the wire; this matches).
  const padded = lines.map((l) => l.padEnd(LINE_WIDTH, ' '));
  // Cap at USABLE_ROWS so the gallery's panels are uniform — any
  // overflow gets clipped, matching the real device's row budget.
  pre.textContent = padded.slice(0, USABLE_ROWS + 1).join('\n');
  panel.appendChild(pre);
  wrapper.appendChild(panel);

  // Footer line metadata: row count + max width assertion. Surfaces
  // any drift past the 24-col contract directly in the gallery.
  const overflow = padded.some((l) => l.length > LINE_WIDTH);
  const meta = el('p', { class: 'wmata-preview__meta' }, [
    `${String(lines.length)} rows · ${overflow ? '⚠ OVERFLOW' : 'fits LINE_WIDTH'}`,
  ]);
  wrapper.appendChild(meta);

  return wrapper;
}

export function mountGallery(root: HTMLElement): void {
  root.replaceChildren();
  root.appendChild(
    el('header', { class: 'wmata-preview__header' }, [
      el('h1', { class: 'wmata-preview__h1' }, ['WMATA G2 — Screens Gallery']),
      el('p', { class: 'wmata-preview__sub' }, [
        `Every screen state, rendered through its real \`view()\` function. 24×${String(
          USABLE_ROWS + 1,
        )} text grid on the device; this page captures every interesting fixture without the SDK simulator.`,
      ]),
    ]),
  );

  const grid = el('div', { class: 'wmata-preview__grid' });
  for (const card of buildCards()) grid.appendChild(renderCard(card));
  root.appendChild(grid);
}
