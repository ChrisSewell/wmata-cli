/// <reference types="vite/client" />

// Companion settings screen.
//
// This module renders the WMATA-key-entry and favorites-management UI on the
// phone's WebView. The glasses HUD is not involved here — typing on a HUD
// would be miserable, so we do all configuration on the phone. The glasses
// only render glanceable transit info; that is a separate work-package.
//
// Design constraints (per the WP4 brief):
//   - Pure DOM. No React/Vue/etc. The host page is plain Vite + TypeScript.
//   - Mountable into any HTMLElement, returns an unmount function so a
//     future router can swap screens cleanly.
//   - Scoped re-renders. The API-key input must not lose focus mid-validation
//     just because the favorites card was rebuilt, so each card has its own
//     mount node and we wipe-and-rebuild only the card that changed.
//   - All buttons are <button>, all inputs have <label>, the validation
//     result text has aria-live="polite". Strict TS, no `any`.
//
// Persistence layer notes (forwarded from the storage WP):
//   - `saveApiKey("")` is the canonical "clear key" path; we do NOT call
//     `clearSettings()` for that (clearSettings nukes favorites too).
//   - `addFavorite` silently refuses past MAX_FAVORITES and on duplicates,
//     returning the same-length array. We compare lengths to disambiguate
//     "limit reached" vs. "already a favorite" by checking codes first.
//   - `reorderFavorites` THROWS when length > MAX_FAVORITES. We guard with
//     try/catch and surface an error toast on the (shouldn't-happen) path.
//   - In private-browsing / sandboxed-iframe contexts, localStorage writes
//     are silent no-ops. We probe at mount and show a warning banner.

import './settings.css';

import {
  WmataClient,
  WmataError,
  searchStations,
  type Station,
  type LineCode,
} from '../wmata';

import {
  loadSettings,
  saveApiKey,
  saveSttApiKey,
  saveSchedule,
  saveVoiceTargets,
  saveJourneyPlan,
  saveGeofenceEnabled,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  clearSettings,
  MAX_FAVORITES,
  type FavoriteStation,
  type JourneyPlan,
  type VoiceTargets,
} from '../storage/settings';
import {
  WEEKDAYS,
  type AutoRotateRule,
  type ScheduleRule,
} from '../schedule/rules';
import { loadHistory } from '../storage/history';
import { suggestReorder } from '../storage/history';
import { estimateTravelMinutes } from './journey';
import {
  buildPathUrl,
  type PathResponse,
} from '../wmata';
import {
  MAX_SCHEDULE_RULES,
  changeRuleKind,
  defaultAutoRotateRule,
  toggleDay,
  validateScheduleRule,
} from './settings-helpers';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Module-local mutable state. Lives inside a single `mountSettingsScreen`
 * invocation; nothing leaks across mounts because the state is created
 * fresh in the function scope each call.
 */
interface ScreenState {
  apiKey: string;
  /**
   * `true` once a key has been successfully validated in this session.
   * Gates the favorites card. We re-set this from `loadSettings()` at
   * mount: if there's a saved key, we treat it as previously-validated
   * so the favorites card is usable on reload. The "Validate" button
   * also flips this on success.
   */
  keyAccepted: boolean;
  /** Deepgram STT API key (optional). */
  sttApiKey: string;
  favorites: FavoriteStation[];
  /** Debounce timer id for the search input. */
  searchTimer: ReturnType<typeof setTimeout> | null;
  /** Latest search results to render. */
  searchResults: Station[];
  /** Inline error under the search box, if any. */
  searchError: string | null;
  /** Latest non-empty query, used when we re-render after a favorite change. */
  searchQuery: string;
  /**
   * Transient message shown after an add-favorite attempt that did not
   * change the list length (duplicate or cap-hit). Cleared after 3s.
   */
  favoritesNotice: string | null;
  favoritesNoticeTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Tracks `state.favorites.length` from the *previous* render of the
   * favorites card. Used to detect the 0 -> 1 transition so we can give
   * the "Done — launch on glasses" button a brief attention-grabbing
   * class on the render right after the user adds their first favorite.
   *
   * Initialised to the loaded favorites count so the highlight does NOT
   * fire on the very first render (the user didn't just add a favorite —
   * they reloaded the page).
   */
  favoritesCountAtLastRender: number;
  // WP-H additions ----------------------------------------------------
  /** Schedule rules (auto-rotate + quiet hours). */
  schedule: ScheduleRule[];
  /** Labelled voice-target stations. */
  voiceTargets: VoiceTargets;
  /** Saved origin → destination commute. */
  journeyPlan: JourneyPlan;
  /** Boot-time geofence enable. */
  geofenceEnabled: boolean;
  /** Transient: hide the reorder banner until next mount. */
  reorderDismissed: boolean;
  /** Debounced re-render of the journey-preview row. */
  journeyPreviewTimer: ReturnType<typeof setTimeout> | null;
  /** Latest preview text for the journey card (resolved path summary). */
  journeyPreviewText: string;
}

/** Day-button labels (M T W T F S S). Indexed by `WEEKDAYS`. */
const DAY_LABELS: readonly string[] = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an element with optional attributes/children. Avoids the
 * `document.createElement` + manual `setAttribute` + manual `appendChild`
 * boilerplate that would otherwise pollute the render functions.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') {
      node.className = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

/**
 * Format a station's lines as a comma-separated string. Empty if the
 * station somehow has no LineCode1 (should not happen per WMATA, but we
 * don't want a stray ", " on screen if it does).
 */
function formatLines(station: Station): string {
  const codes: string[] = [];
  if (station.LineCode1) codes.push(station.LineCode1);
  if (station.LineCode2) codes.push(station.LineCode2);
  if (station.LineCode3) codes.push(station.LineCode3);
  if (station.LineCode4) codes.push(station.LineCode4);
  return codes.join(', ');
}

/** Extract just the LineCode array (without nulls) for FavoriteStation. */
function stationLineCodes(station: Station): LineCode[] {
  const codes: LineCode[] = [];
  if (station.LineCode1) codes.push(station.LineCode1);
  if (station.LineCode2) codes.push(station.LineCode2);
  if (station.LineCode3) codes.push(station.LineCode3);
  if (station.LineCode4) codes.push(station.LineCode4);
  return codes;
}

/**
 * Probe localStorage for actual write availability. The storage wrapper
 * swallows errors silently, so we have to do a real round-trip here to
 * know whether to show the banner.
 */
function storageIsAvailable(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probeKey = 'wmata.g2.probe';
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountSettingsScreen(root: HTMLElement): () => void {
  // Clear any prior content. The caller (router) is responsible for not
  // re-mounting on top of itself, but we defensively reset anyway.
  root.replaceChildren();

  const initial = loadSettings();
  const state: ScreenState = {
    apiKey: initial.apiKey,
    // A saved key is treated as previously-accepted; otherwise the user
    // could never reach the favorites card after a reload without
    // re-validating, which would be hostile UX.
    keyAccepted: initial.apiKey.length > 0,
    sttApiKey: initial.sttApiKey,
    favorites: initial.favorites,
    searchTimer: null,
    searchResults: [],
    searchError: null,
    searchQuery: '',
    favoritesNotice: null,
    favoritesNoticeTimer: null,
    favoritesCountAtLastRender: initial.favorites.length,
    // WP-H state — hydrated from the same `loadSettings()` call.
    schedule: initial.schedule.slice(),
    voiceTargets: { ...initial.voiceTargets },
    journeyPlan: { ...initial.journeyPlan },
    geofenceEnabled: initial.geofenceEnabled,
    reorderDismissed: false,
    journeyPreviewTimer: null,
    journeyPreviewText: '',
  };

  // Container & layout shell ------------------------------------------------
  const container = el('div', { class: 'wmata-settings' });
  root.appendChild(container);

  // Header
  container.appendChild(
    el('header', { class: 'wmata-settings__header' }, [
      el('h1', { class: 'wmata-settings__title' }, ['WMATA Transit']),
      el('p', { class: 'wmata-settings__tagline' }, [
        'Real-time DC Metro on your G2 glasses.',
      ]),
    ]),
  );

  // Storage banner (conditional)
  if (!storageIsAvailable()) {
    container.appendChild(
      el('div', { class: 'wmata-settings__banner', role: 'status' }, [
        "Browser storage is unavailable — settings won't be saved between sessions.",
      ]),
    );
  }

  // Card mount points: each card is rebuilt independently to keep
  // re-renders scoped (so e.g. the favorites card doesn't blow away the
  // API-key input's focus).
  const apiKeyMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-apikey-title',
  });
  const favoritesMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-favs-title',
  });
  const sttMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-stt-title',
  });
  const scheduleMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-schedule-title',
  });
  const voiceTargetsMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-voice-title',
  });
  const journeyMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-journey-title',
  });
  const geofenceMount = el('section', {
    class: 'wmata-settings__card',
    'aria-labelledby': 'wmata-settings-geofence-title',
  });
  container.appendChild(apiKeyMount);
  container.appendChild(favoritesMount);
  container.appendChild(sttMount);
  container.appendChild(scheduleMount);
  container.appendChild(voiceTargetsMount);
  container.appendChild(journeyMount);
  container.appendChild(geofenceMount);

  // Footer
  const footerResetBtn = el(
    'button',
    {
      type: 'button',
      class: 'wmata-settings__button wmata-settings__button--danger',
    },
    ['Reset all settings'],
  );
  const onReset = (): void => {
    if (!window.confirm('Reset all settings? This clears your API key and favorites.')) {
      return;
    }
    clearSettings();
    // Full re-init: easiest way to reset every card's local DOM state.
    state.apiKey = '';
    state.keyAccepted = false;
    state.sttApiKey = '';
    state.favorites = [];
    state.searchResults = [];
    state.searchError = null;
    state.searchQuery = '';
    state.favoritesNotice = null;
    state.favoritesCountAtLastRender = 0;
    state.schedule = [];
    state.voiceTargets = { home: '', work: '' };
    state.journeyPlan = { origin: '', destination: '' };
    state.geofenceEnabled = false;
    state.reorderDismissed = false;
    state.journeyPreviewText = '';
    renderApiKeyCard();
    renderFavoritesCard();
    renderSttCard();
    renderScheduleCard();
    renderVoiceTargetsCard();
    renderJourneyCard();
    renderGeofenceCard();
  };
  footerResetBtn.addEventListener('click', onReset);
  container.appendChild(
    el('footer', { class: 'wmata-settings__footer' }, [footerResetBtn]),
  );

  // -----------------------------------------------------------------------
  // API key card
  // -----------------------------------------------------------------------

  /**
   * Render (or re-render) the API key card. Called once at mount and again
   * after a successful validation (so the favorites card gating updates).
   * Note we ONLY re-render this card on hard state changes — not while the
   * user is mid-typing — so input focus is preserved.
   */
  function renderApiKeyCard(): void {
    apiKeyMount.replaceChildren();

    const title = el(
      'h2',
      {
        id: 'wmata-settings-apikey-title',
        class: 'wmata-settings__card-title',
      },
      ['WMATA API key'],
    );
    const help = el('p', { class: 'wmata-settings__card-help' }, [
      'Get a free developer key from developer.wmata.com. We store it locally on this device only.',
    ]);

    const label = el(
      'label',
      { class: 'wmata-settings__label', for: 'wmata-settings-apikey' },
      ['Key'],
    );

    const input = el('input', {
      id: 'wmata-settings-apikey',
      class: 'wmata-settings__input',
      type: 'password',
      inputmode: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'Paste your 32-character key',
      value: state.apiKey,
    });
    // setAttribute('value', ...) sets only the default attribute; for the
    // live property (important on re-renders), set it explicitly too.
    input.value = state.apiKey;

    const showToggle = el(
      'button',
      {
        type: 'button',
        class: 'wmata-settings__button wmata-settings__button--ghost wmata-settings__button--small',
        'aria-pressed': 'false',
      },
      ['Show'],
    );

    let revealed = false;
    const onToggleShow = (): void => {
      revealed = !revealed;
      input.type = revealed ? 'text' : 'password';
      showToggle.textContent = revealed ? 'Hide' : 'Show';
      showToggle.setAttribute('aria-pressed', revealed ? 'true' : 'false');
    };
    showToggle.addEventListener('click', onToggleShow);

    const inputRow = el('div', { class: 'wmata-settings__input-row' }, [
      input,
      showToggle,
    ]);

    // Keep state.apiKey in sync as the user types. We do NOT auto-save here;
    // saving happens only when Validate succeeds (or Clear is pressed). This
    // matches the brief and avoids persisting half-typed garbage.
    const onInput = (): void => {
      state.apiKey = input.value;
    };
    input.addEventListener('input', onInput);

    const status = el('div', {
      class: 'wmata-settings__status wmata-settings__status--info',
      'aria-live': 'polite',
      role: 'status',
    });

    const validateBtn = el(
      'button',
      { type: 'button', class: 'wmata-settings__button wmata-settings__button--primary' },
      ['Validate'],
    );
    const clearBtn = el(
      'button',
      { type: 'button', class: 'wmata-settings__button wmata-settings__button--ghost' },
      ['Clear'],
    );

    const setStatus = (text: string, kind: 'ok' | 'bad' | 'info'): void => {
      status.textContent = text;
      status.className = `wmata-settings__status wmata-settings__status--${kind}`;
    };

    const onValidate = async (): Promise<void> => {
      const trimmed = input.value.trim();
      if (trimmed.length === 0) {
        setStatus('Enter a key first.', 'bad');
        return;
      }
      validateBtn.disabled = true;
      clearBtn.disabled = true;
      const originalLabel = validateBtn.textContent;
      validateBtn.textContent = 'Validating…';
      setStatus('Validating…', 'info');
      try {
        const client = new WmataClient(trimmed);
        const ok = await client.validate();
        if (ok) {
          saveApiKey(trimmed);
          state.apiKey = trimmed;
          state.keyAccepted = true;
          setStatus('✓ Key accepted', 'ok');
          // Favorites + STT cards were disabled — re-render so they
          // activate. The STT card shares the favorites-card gating.
          renderFavoritesCard();
          renderSttCard();
        } else {
          state.keyAccepted = false;
          setStatus('✕ Key rejected — check the value or your network.', 'bad');
          // Re-render so the gated cards show as disabled if they
          // were previously enabled.
          renderFavoritesCard();
          renderSttCard();
        }
      } finally {
        validateBtn.disabled = false;
        clearBtn.disabled = false;
        validateBtn.textContent = originalLabel ?? 'Validate';
      }
    };
    validateBtn.addEventListener('click', () => {
      void onValidate();
    });

    const onClear = (): void => {
      saveApiKey('');
      state.apiKey = '';
      state.keyAccepted = false;
      input.value = '';
      setStatus('', 'info');
      renderFavoritesCard();
      renderSttCard();
    };
    clearBtn.addEventListener('click', onClear);

    const buttons = el('div', { class: 'wmata-settings__button-row' }, [
      validateBtn,
      clearBtn,
    ]);

    const field = el('div', { class: 'wmata-settings__field' }, [
      label,
      inputRow,
    ]);

    apiKeyMount.appendChild(title);
    apiKeyMount.appendChild(help);
    apiKeyMount.appendChild(field);
    apiKeyMount.appendChild(buttons);
    apiKeyMount.appendChild(status);

    // On re-render where a key is already validated, hint at it.
    if (state.keyAccepted && state.apiKey.length > 0) {
      setStatus('✓ Key saved', 'ok');
    }
  }

  // -----------------------------------------------------------------------
  // Favorites card
  // -----------------------------------------------------------------------

  /**
   * Run a search through the WMATA client. Errors are surfaced as inline
   * messages and never escape as unhandled rejections.
   */
  async function runSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    state.searchQuery = trimmed;
    if (trimmed.length === 0) {
      state.searchResults = [];
      state.searchError = null;
      renderFavoritesCard();
      return;
    }
    try {
      const client = new WmataClient(state.apiKey);
      const results = await searchStations(client, trimmed);
      state.searchResults = results.slice(0, 8);
      state.searchError = null;
    } catch (err) {
      state.searchResults = [];
      if (err instanceof WmataError) {
        state.searchError =
          "Couldn't load stations — check your key and try again.";
      } else {
        // Non-WMATA errors (e.g. coding bugs) shouldn't be silenced. We
        // log them and show the same user-facing message rather than
        // letting them become an unhandled promise rejection.
        console.error('[settings] unexpected search error:', err);
        state.searchError = 'Unexpected error while searching.';
      }
    }
    renderFavoritesCard();
  }

  function showFavoritesNotice(message: string): void {
    state.favoritesNotice = message;
    if (state.favoritesNoticeTimer !== null) {
      clearTimeout(state.favoritesNoticeTimer);
    }
    state.favoritesNoticeTimer = setTimeout(() => {
      state.favoritesNotice = null;
      state.favoritesNoticeTimer = null;
      renderFavoritesCard();
    }, 3000);
  }

  /**
   * Show a transient toast (used for the impossible-but-defensive
   * reorder-throws path). Renders into the screen container, removes
   * itself after 3s.
   */
  function showErrorToast(message: string): void {
    const toast = el('div', { class: 'wmata-settings__toast', role: 'alert' }, [
      message,
    ]);
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 3000);
  }

  function renderFavoritesCard(): void {
    favoritesMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    favoritesMount.setAttribute('aria-disabled', gated ? 'true' : 'false');

    const title = el(
      'h2',
      {
        id: 'wmata-settings-favs-title',
        class: 'wmata-settings__card-title',
      },
      ['Favorite stations'],
    );
    favoritesMount.appendChild(title);

    if (gated) {
      favoritesMount.appendChild(
        el('p', { class: 'wmata-settings__card-help' }, [
          'Validate your API key above to start adding favorites.',
        ]),
      );
      return;
    }

    favoritesMount.appendChild(
      el('p', { class: 'wmata-settings__card-help' }, [
        `Pin up to ${String(MAX_FAVORITES)} stations. They will show on the glasses Home screen.`,
      ]),
    );

    // Search field --------------------------------------------------------
    const searchLabel = el(
      'label',
      { class: 'wmata-settings__label', for: 'wmata-settings-search' },
      ['Find a station'],
    );
    const searchInput = el('input', {
      id: 'wmata-settings-search',
      class: 'wmata-settings__input',
      type: 'search',
      inputmode: 'search',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'e.g. Metro Center',
      value: state.searchQuery,
    });
    searchInput.value = state.searchQuery;

    const onSearchInput = (): void => {
      const value = searchInput.value;
      if (state.searchTimer !== null) {
        clearTimeout(state.searchTimer);
      }
      state.searchTimer = setTimeout(() => {
        state.searchTimer = null;
        void runSearch(value);
      }, 200);
    };
    searchInput.addEventListener('input', onSearchInput);

    favoritesMount.appendChild(
      el('div', { class: 'wmata-settings__field' }, [searchLabel, searchInput]),
    );

    // Search error / notice ----------------------------------------------
    if (state.searchError !== null) {
      favoritesMount.appendChild(
        el(
          'div',
          {
            class: 'wmata-settings__status wmata-settings__status--bad',
            role: 'alert',
          },
          [state.searchError],
        ),
      );
    }
    if (state.favoritesNotice !== null) {
      favoritesMount.appendChild(
        el(
          'div',
          {
            class: 'wmata-settings__status wmata-settings__status--info',
            role: 'status',
            'aria-live': 'polite',
          },
          [state.favoritesNotice],
        ),
      );
    }

    // Search results -----------------------------------------------------
    const atCap = state.favorites.length >= MAX_FAVORITES;
    if (state.searchResults.length > 0) {
      const list = el('ul', { class: 'wmata-settings__list' });
      for (const station of state.searchResults) {
        const alreadyPinned = state.favorites.some(
          (f) => f.code === station.Code,
        );
        const addBtn = el(
          'button',
          {
            type: 'button',
            class: 'wmata-settings__button wmata-settings__button--small wmata-settings__button--primary',
            'aria-label': `Add ${station.Name} to favorites`,
          },
          [atCap ? 'Limit reached (5)' : alreadyPinned ? 'Added' : '+ Add'],
        );
        if (atCap || alreadyPinned) {
          addBtn.disabled = true;
        }
        addBtn.addEventListener('click', () => {
          const before = state.favorites.length;
          const next = addFavorite({
            code: station.Code,
            name: station.Name,
            lines: stationLineCodes(station),
            // Capture geo-coords at add-time so the WP-G geofence
            // boot path can match against them. Field is optional
            // in the storage schema for backward-compat with v1.1
            // favorites (which were saved without coords).
            lat: station.Lat,
            lon: station.Lon,
          });
          state.favorites = next;
          if (next.length === before) {
            // Either duplicate or cap. Disambiguate by checking codes.
            if (next.some((f) => f.code === station.Code)) {
              showFavoritesNotice('Already a favorite.');
            } else {
              showFavoritesNotice('Limit reached (5).');
            }
          }
          renderFavoritesCard();
        });

        const row = el('li', { class: 'wmata-settings__row' }, [
          el('div', { class: 'wmata-settings__row-main' }, [
            el('div', { class: 'wmata-settings__row-name' }, [station.Name]),
            el('div', { class: 'wmata-settings__row-meta' }, [
              el('span', { class: 'wmata-settings__row-code' }, [station.Code]),
              '  ',
              formatLines(station),
            ]),
          ]),
          el('div', { class: 'wmata-settings__row-actions' }, [addBtn]),
        ]);
        list.appendChild(row);
      }
      favoritesMount.appendChild(list);
    } else if (state.searchQuery.length > 0 && state.searchError === null) {
      favoritesMount.appendChild(
        el('div', { class: 'wmata-settings__empty' }, [
          'No stations match that query.',
        ]),
      );
    }

    // Reorder hint (WP-H/H5) ---------------------------------------------
    //
    // Surface a "your most-tapped stations differ from this order"
    // suggestion when the travel-history log has enough signal. The
    // pure `suggestReorder` helper returns null in every "don't
    // surface" case (sparse history, already-matches-current, etc),
    // so we just check truthiness here.
    if (!state.reorderDismissed && state.favorites.length >= 2) {
      const history = loadHistory();
      const suggested = suggestReorder(state.favorites, history);
      if (suggested !== null) {
        const top = suggested
          .slice(0, 3)
          .map((f) => f.name)
          .join(', ');
        const applyBtn = el(
          'button',
          {
            type: 'button',
            class:
              'wmata-settings__button wmata-settings__button--small wmata-settings__button--primary',
            'data-testid': 'wmata-settings-reorder-apply',
          },
          ['Apply suggested order'],
        );
        const dismissBtn = el(
          'button',
          {
            type: 'button',
            class:
              'wmata-settings__button wmata-settings__button--small wmata-settings__button--ghost',
            'data-testid': 'wmata-settings-reorder-dismiss',
          },
          ['Dismiss'],
        );
        applyBtn.addEventListener('click', () => {
          try {
            state.favorites = reorderFavorites(suggested);
          } catch (err) {
            console.error('[settings] reorderFavorites threw:', err);
            showErrorToast("Couldn't apply suggested order.");
            return;
          }
          renderFavoritesCard();
        });
        dismissBtn.addEventListener('click', () => {
          state.reorderDismissed = true;
          renderFavoritesCard();
        });
        favoritesMount.appendChild(
          el(
            'div',
            {
              class: 'wmata-settings__status wmata-settings__status--info',
              role: 'status',
              'aria-live': 'polite',
            },
            [`Your most-tapped: ${top}.`],
          ),
        );
        favoritesMount.appendChild(
          el('div', { class: 'wmata-settings__button-row' }, [
            applyBtn,
            dismissBtn,
          ]),
        );
      }
    }

    // Favorites list -----------------------------------------------------
    const previousCount = state.favoritesCountAtLastRender;
    favoritesMount.appendChild(
      el('h3', { class: 'wmata-settings__card-title' }, [
        `Your favorites (${String(state.favorites.length)}/${String(MAX_FAVORITES)})`,
      ]),
    );

    if (state.favorites.length === 0) {
      favoritesMount.appendChild(
        el('div', { class: 'wmata-settings__empty' }, [
          'No favorites yet. Use the search above to pin a station.',
        ]),
      );
    } else {
      const favList = el('ul', { class: 'wmata-settings__list' });
      state.favorites.forEach((fav, idx) => {
        const upBtn = el(
          'button',
          {
            type: 'button',
            class: 'wmata-settings__button wmata-settings__button--icon',
            'aria-label': `Move ${fav.name} up`,
            title: 'Move up',
          },
          ['▲'],
        );
        const downBtn = el(
          'button',
          {
            type: 'button',
            class: 'wmata-settings__button wmata-settings__button--icon',
            'aria-label': `Move ${fav.name} down`,
            title: 'Move down',
          },
          ['▼'],
        );
        if (idx === 0) upBtn.disabled = true;
        if (idx === state.favorites.length - 1) downBtn.disabled = true;

        const moveBy = (delta: -1 | 1): void => {
          const j = idx + delta;
          if (j < 0 || j >= state.favorites.length) return;
          const newOrder = [...state.favorites];
          const a = newOrder[idx];
          const b = newOrder[j];
          if (a === undefined || b === undefined) return;
          newOrder[idx] = b;
          newOrder[j] = a;
          try {
            state.favorites = reorderFavorites(newOrder);
          } catch (err) {
            // Brief said this is "impossible-by-construction" — we built
            // newOrder by swapping inside a list that is already ≤ cap.
            // Still, the storage module promised to throw on overflow,
            // so we honor the contract.
            console.error('[settings] reorderFavorites threw:', err);
            showErrorToast("Couldn't reorder favorites.");
            return;
          }
          renderFavoritesCard();
        };
        upBtn.addEventListener('click', () => moveBy(-1));
        downBtn.addEventListener('click', () => moveBy(1));

        const removeBtn = el(
          'button',
          {
            type: 'button',
            class: 'wmata-settings__button wmata-settings__button--small wmata-settings__button--ghost',
            'aria-label': `Remove ${fav.name} from favorites`,
          },
          ['Remove'],
        );
        removeBtn.addEventListener('click', () => {
          state.favorites = removeFavorite(fav.code);
          renderFavoritesCard();
        });

        const row = el('li', { class: 'wmata-settings__row' }, [
          el('div', { class: 'wmata-settings__row-main' }, [
            el('div', { class: 'wmata-settings__row-name' }, [fav.name]),
            el('div', { class: 'wmata-settings__row-meta' }, [
              el('span', { class: 'wmata-settings__row-code' }, [fav.code]),
              '  ',
              fav.lines.join(', '),
            ]),
          ]),
          el('div', { class: 'wmata-settings__row-actions' }, [
            upBtn,
            downBtn,
            removeBtn,
          ]),
        ]);
        favList.appendChild(row);
      });
      favoritesMount.appendChild(favList);
    }

    // Done — launch on glasses --------------------------------------------
    //
    // Surface a prominent action at the bottom of the favorites card so
    // the user has an obvious way to "finish here and move to the
    // glasses HUD" without manually reloading the page. The handoff is
    // intentionally a `window.location.reload()` — simple and reliable;
    // the boot logic in `main.ts` re-evaluates the settings on every
    // start and routes to the glasses Home screen when a key is saved
    // and favorites are present.
    //
    // The button is hidden when either prerequisite is missing (no key
    // accepted OR zero favorites), because the glasses route would be a
    // dead-end in that state.
    //
    // The 0 -> 1 favorites transition triggers a brief class toggle
    // (`wmata-settings__button--attention`) so the button visually
    // announces itself on the same render where it first appears.
    // The class is cleared on the next render to avoid the highlight
    // becoming permanent.
    if (state.keyAccepted && state.favorites.length > 0) {
      const justGotFirstFavorite =
        previousCount === 0 && state.favorites.length >= 1;
      const doneBtn = el(
        'button',
        {
          type: 'button',
          class: justGotFirstFavorite
            ? 'wmata-settings__button wmata-settings__button--primary wmata-settings__button--done wmata-settings__button--attention'
            : 'wmata-settings__button wmata-settings__button--primary wmata-settings__button--done',
          'data-testid': 'wmata-settings-done',
          'aria-label': 'Done. Launch on glasses.',
        },
        ['Done — launch on glasses'],
      );
      doneBtn.addEventListener('click', () => {
        window.location.reload();
      });
      favoritesMount.appendChild(
        el('div', { class: 'wmata-settings__done-row' }, [doneBtn]),
      );
    }

    // Update the previous-count tracker AFTER this render so the next
    // render compares against this one.
    state.favoritesCountAtLastRender = state.favorites.length;
  }

  // -----------------------------------------------------------------------
  // STT (Deepgram) card
  // -----------------------------------------------------------------------
  //
  // The card is gated by the same condition as the favorites card
  // (`keyAccepted && apiKey.length > 0`). It is intentionally
  // optional — without a Deepgram key the VOICE LOOKUP row on the
  // glasses fails with a clear "Voice unavailable" message and
  // bounces back to Home (see `main.ts` → router → 'voice' case).
  //
  // There is no validate / probe button. Deepgram doesn't have a
  // cheap "is this key valid?" endpoint — the cheapest validation is
  // opening a real streaming WebSocket, which would burn a couple of
  // hundred ms of audio quota every time the user hits a button.
  // We rely on implicit validation: if the user's key is wrong, the
  // first voice attempt will surface a "WebSocket error" on the HUD,
  // which is sufficient signal to send them back here.
  function renderSttCard(): void {
    sttMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    sttMount.setAttribute('aria-disabled', gated ? 'true' : 'false');

    const title = el(
      'h2',
      {
        id: 'wmata-settings-stt-title',
        class: 'wmata-settings__card-title',
      },
      ['Voice (Deepgram STT) — optional'],
    );
    sttMount.appendChild(title);

    if (gated) {
      // Same gating as the favorites card: hide everything but the
      // title row until the WMATA key is accepted. The user's mental
      // model is "settings unlock in order" — the STT key is useless
      // without the WMATA key (no station list to search against),
      // so deferring it is no worse than the existing favorites flow.
      sttMount.appendChild(
        el('p', { class: 'wmata-settings__card-help' }, [
          'Validate your WMATA API key above to configure voice.',
        ]),
      );
      return;
    }

    sttMount.appendChild(
      el('p', { class: 'wmata-settings__card-help' }, [
        'Optional. Without a key, the VOICE LOOKUP row on the glasses will ' +
          'fail with a clear error. Get a key from console.deepgram.com.',
      ]),
    );

    const label = el(
      'label',
      { class: 'wmata-settings__label', for: 'wmata-settings-stt-key' },
      ['Deepgram API key'],
    );

    const input = el('input', {
      id: 'wmata-settings-stt-key',
      class: 'wmata-settings__input',
      type: 'password',
      inputmode: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'Paste your Deepgram key',
      value: state.sttApiKey,
    });
    input.value = state.sttApiKey;

    const onInput = (): void => {
      state.sttApiKey = input.value;
    };
    input.addEventListener('input', onInput);

    const status = el('div', {
      class: 'wmata-settings__status wmata-settings__status--info',
      'aria-live': 'polite',
      role: 'status',
    });

    const setStatus = (text: string, kind: 'ok' | 'bad' | 'info'): void => {
      status.textContent = text;
      status.className = `wmata-settings__status wmata-settings__status--${kind}`;
    };

    const saveBtn = el(
      'button',
      {
        type: 'button',
        class:
          'wmata-settings__button wmata-settings__button--primary',
      },
      ['Save'],
    );

    const onSave = (): void => {
      const trimmed = input.value.trim();
      // Empty is the documented "no STT" state — we intentionally
      // allow it so the user can clear a previously-saved key by
      // emptying the input and hitting Save.
      saveSttApiKey(trimmed);
      state.sttApiKey = trimmed;
      setStatus(trimmed.length === 0 ? 'Cleared.' : 'Saved.', 'ok');
    };
    saveBtn.addEventListener('click', onSave);

    sttMount.appendChild(
      el('div', { class: 'wmata-settings__field' }, [label, input]),
    );
    sttMount.appendChild(
      el('div', { class: 'wmata-settings__button-row' }, [saveBtn]),
    );
    sttMount.appendChild(status);

    if (state.sttApiKey.length > 0) {
      setStatus('✓ Key saved', 'ok');
    }
  }

  // -----------------------------------------------------------------------
  // Schedule editor card (WP-H/H1)
  // -----------------------------------------------------------------------
  //
  // Edits the user's `ScheduleRule[]` — a mix of auto-rotate + quiet-
  // hours windows. Up to MAX_SCHEDULE_RULES rules. Each row in the
  // list has a kind picker, 7 day toggles, two HH:MM inputs, and
  // (for auto-rotate) a target picker populated from favorites.
  //
  // Persistence pattern: on EVERY field edit, validate the whole
  // rule set, drop invalid rules from what we persist, and call
  // `saveSchedule(rules)`. Invalid rules stay in the editor but are
  // surfaced with an inline error. The runtime never sees a malformed
  // rule because the storage parser also drops them on load.
  function renderScheduleCard(): void {
    scheduleMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    scheduleMount.setAttribute('aria-disabled', gated ? 'true' : 'false');

    scheduleMount.appendChild(
      el(
        'h2',
        {
          id: 'wmata-settings-schedule-title',
          class: 'wmata-settings__card-title',
        },
        ['Auto-rotate + Quiet hours — optional'],
      ),
    );
    if (gated) {
      scheduleMount.appendChild(
        el('p', { class: 'wmata-settings__card-help' }, [
          'Validate your WMATA API key above to configure schedule rules.',
        ]),
      );
      return;
    }
    scheduleMount.appendChild(
      el('p', { class: 'wmata-settings__card-help' }, [
        'Auto-rotate boots the glasses straight to a station instead of Home during the window. ' +
          'Quiet hours hides ALERTS / ACCESS rows so nothing blinks at you.',
      ]),
    );

    const persist = (): void => {
      // Validate each rule before persisting. Invalid rules are
      // omitted from what `saveSchedule` writes; the runtime never
      // sees them. The editor still keeps them in `state.schedule`
      // so the user sees their work.
      const valid: ScheduleRule[] = [];
      for (const rule of state.schedule) {
        const v = validateScheduleRule(rule);
        if (typeof v !== 'string') valid.push(v);
      }
      saveSchedule(valid);
    };

    const list = el('ul', { class: 'wmata-settings__list' });
    state.schedule.forEach((rule, idx) => {
      const row = renderScheduleRuleRow(rule, idx, () => {
        // Field-edit callback: re-render this card so derived UI
        // (validation messages, kind-dependent fields) stays in sync.
        persist();
        renderScheduleCard();
      });
      list.appendChild(row);
    });
    scheduleMount.appendChild(list);

    if (state.schedule.length < MAX_SCHEDULE_RULES) {
      const addBtn = el(
        'button',
        {
          type: 'button',
          class:
            'wmata-settings__button wmata-settings__button--small wmata-settings__button--ghost',
        },
        ['+ Add rule'],
      );
      addBtn.addEventListener('click', () => {
        state.schedule.push(defaultAutoRotateRule());
        persist();
        renderScheduleCard();
      });
      scheduleMount.appendChild(
        el('div', { class: 'wmata-settings__button-row' }, [addBtn]),
      );
    }
  }

  /**
   * Render a single rule row. The `onChange` callback fires on any
   * field edit; the parent persists + re-renders to keep validation
   * messages and kind-dependent fields fresh.
   */
  function renderScheduleRuleRow(
    rule: ScheduleRule,
    idx: number,
    onChange: () => void,
  ): HTMLLIElement {
    const li = el('li', { class: 'wmata-settings__rule-row' });

    // Kind picker -----------------------------------------------------
    const kindSelect = el('select', {
      class: 'wmata-settings__select',
      'aria-label': 'Rule kind',
    });
    for (const k of ['auto-rotate', 'quiet-hours'] as const) {
      const opt = el('option', { value: k }, [
        k === 'auto-rotate' ? 'Auto-rotate' : 'Quiet hours',
      ]);
      if (rule.kind === k) opt.setAttribute('selected', 'selected');
      kindSelect.appendChild(opt);
    }
    kindSelect.addEventListener('change', () => {
      const nextKind = kindSelect.value as ScheduleRule['kind'];
      state.schedule[idx] = changeRuleKind(rule, nextKind);
      onChange();
    });

    // Day toggles -----------------------------------------------------
    const dayRow = el('div', { class: 'wmata-settings__day-row' });
    WEEKDAYS.forEach((wd, i) => {
      const on = rule.days.includes(wd);
      const btn = el(
        'button',
        {
          type: 'button',
          class:
            'wmata-settings__day-btn' +
            (on ? ' wmata-settings__day-btn--on' : ''),
          'aria-pressed': on ? 'true' : 'false',
          'aria-label': wd,
        },
        [DAY_LABELS[i] ?? '?'],
      );
      btn.addEventListener('click', () => {
        const days = toggleDay(rule.days, wd);
        state.schedule[idx] = { ...rule, days };
        onChange();
      });
      dayRow.appendChild(btn);
    });

    // Time pickers ----------------------------------------------------
    const startInput = el('input', {
      type: 'time',
      class: 'wmata-settings__input wmata-settings__input--time',
      value: rule.startHHMM,
      'aria-label': 'Start time',
    });
    startInput.addEventListener('change', () => {
      state.schedule[idx] = { ...rule, startHHMM: startInput.value };
      onChange();
    });
    const endInput = el('input', {
      type: 'time',
      class: 'wmata-settings__input wmata-settings__input--time',
      value: rule.endHHMM,
      'aria-label': 'End time',
    });
    endInput.addEventListener('change', () => {
      state.schedule[idx] = { ...rule, endHHMM: endInput.value };
      onChange();
    });
    const timesRow = el('div', { class: 'wmata-settings__times-row' }, [
      startInput,
      el('span', { class: 'wmata-settings__times-sep' }, ['→']),
      endInput,
    ]);

    // Target picker (auto-rotate only) -------------------------------
    const targetWrap = el('div', { class: 'wmata-settings__target-wrap' });
    if (rule.kind === 'auto-rotate') {
      const targetSelect = el('select', {
        class: 'wmata-settings__select',
        'aria-label': 'Target screen',
      });
      const homeOpt = el('option', { value: '__home__' }, ['Home']);
      if (rule.target.kind === 'home') {
        homeOpt.setAttribute('selected', 'selected');
      }
      targetSelect.appendChild(homeOpt);
      for (const fav of state.favorites) {
        const opt = el('option', { value: fav.code }, [
          `${fav.name} (${fav.code})`,
        ]);
        if (
          rule.target.kind === 'predictions' &&
          rule.target.stationCode === fav.code
        ) {
          opt.setAttribute('selected', 'selected');
        }
        targetSelect.appendChild(opt);
      }
      targetSelect.addEventListener('change', () => {
        const v = targetSelect.value;
        const next: AutoRotateRule = {
          ...rule,
          target:
            v === '__home__'
              ? { kind: 'home' }
              : { kind: 'predictions', stationCode: v },
        };
        state.schedule[idx] = next;
        onChange();
      });
      targetWrap.appendChild(targetSelect);
    }

    // Remove ----------------------------------------------------------
    const removeBtn = el(
      'button',
      {
        type: 'button',
        class:
          'wmata-settings__button wmata-settings__button--icon wmata-settings__button--ghost',
        'aria-label': 'Remove rule',
        title: 'Remove rule',
      },
      ['✕'],
    );
    removeBtn.addEventListener('click', () => {
      state.schedule.splice(idx, 1);
      onChange();
    });

    li.appendChild(kindSelect);
    li.appendChild(dayRow);
    li.appendChild(timesRow);
    li.appendChild(targetWrap);
    li.appendChild(removeBtn);

    // Validation message (inline, below the row) ---------------------
    const valid = validateScheduleRule(rule);
    if (typeof valid === 'string') {
      li.appendChild(
        el(
          'div',
          {
            class: 'wmata-settings__status wmata-settings__status--bad',
            role: 'alert',
          },
          [valid],
        ),
      );
    }
    return li;
  }

  // -----------------------------------------------------------------------
  // Voice targets card (WP-H/H2)
  // -----------------------------------------------------------------------
  function renderVoiceTargetsCard(): void {
    voiceTargetsMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    voiceTargetsMount.setAttribute('aria-disabled', gated ? 'true' : 'false');

    voiceTargetsMount.appendChild(
      el(
        'h2',
        {
          id: 'wmata-settings-voice-title',
          class: 'wmata-settings__card-title',
        },
        ['Voice keyword shortcuts — optional'],
      ),
    );
    if (gated) {
      voiceTargetsMount.appendChild(
        el('p', { class: 'wmata-settings__card-help' }, [
          'Validate your WMATA API key above to configure voice shortcuts.',
        ]),
      );
      return;
    }
    voiceTargetsMount.appendChild(
      el('p', { class: 'wmata-settings__card-help' }, [
        'Say "home" or "work" on the VOICE LOOKUP screen to jump straight to ' +
          'predictions for the linked station. Empty = keyword falls through to the fuzzy station search.',
      ]),
    );

    const dataListId = 'wmata-settings-voice-favs';
    const dataList = el('datalist', { id: dataListId });
    for (const fav of state.favorites) {
      const opt = el('option', { value: fav.code }, [
        `${fav.code} — ${fav.name}`,
      ]);
      dataList.appendChild(opt);
    }
    voiceTargetsMount.appendChild(dataList);

    const persist = (): void => {
      saveVoiceTargets(state.voiceTargets);
    };

    const makeField = (
      label: string,
      key: keyof VoiceTargets,
    ): HTMLElement => {
      const id = `wmata-settings-voice-${key}`;
      const labelEl = el(
        'label',
        { class: 'wmata-settings__label', for: id },
        [label],
      );
      const input = el('input', {
        id,
        class: 'wmata-settings__input',
        type: 'text',
        list: dataListId,
        placeholder: 'Station code (e.g. C01) — or empty to clear',
        value: state.voiceTargets[key],
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
      });
      input.value = state.voiceTargets[key];
      input.addEventListener('change', () => {
        state.voiceTargets = {
          ...state.voiceTargets,
          [key]: input.value.trim().toUpperCase(),
        };
        persist();
      });
      return el('div', { class: 'wmata-settings__field' }, [labelEl, input]);
    };

    voiceTargetsMount.appendChild(makeField('Home station', 'home'));
    voiceTargetsMount.appendChild(makeField('Work station', 'work'));
  }

  // -----------------------------------------------------------------------
  // Journey plan card (WP-H/H3)
  // -----------------------------------------------------------------------
  function renderJourneyCard(): void {
    journeyMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    journeyMount.setAttribute('aria-disabled', gated ? 'true' : 'false');

    journeyMount.appendChild(
      el(
        'h2',
        {
          id: 'wmata-settings-journey-title',
          class: 'wmata-settings__card-title',
        },
        ['Journey / Commute — optional'],
      ),
    );
    if (gated) {
      journeyMount.appendChild(
        el('p', { class: 'wmata-settings__card-help' }, [
          'Validate your WMATA API key above to save a commute.',
        ]),
      );
      return;
    }
    journeyMount.appendChild(
      el('p', { class: 'wmata-settings__card-help' }, [
        'Origin → Destination shows on the Journey screen with a stop count ' +
          'and estimated travel time. Same-line routes only for v1.2; transfers come later.',
      ]),
    );

    const dataListId = 'wmata-settings-journey-favs';
    const dataList = el('datalist', { id: dataListId });
    for (const fav of state.favorites) {
      dataList.appendChild(
        el('option', { value: fav.code }, [`${fav.code} — ${fav.name}`]),
      );
    }
    journeyMount.appendChild(dataList);

    const previewRow = el(
      'div',
      {
        class: 'wmata-settings__status wmata-settings__status--info',
        role: 'status',
        'aria-live': 'polite',
      },
      [state.journeyPreviewText || '—'],
    );

    const refreshPreview = (): void => {
      const { origin, destination } = state.journeyPlan;
      if (origin.length === 0 || destination.length === 0) {
        state.journeyPreviewText = '';
        previewRow.textContent = '—';
        return;
      }
      // Debounced — give the user a beat to finish typing before
      // we burn a request on jPath.
      if (state.journeyPreviewTimer !== null) {
        clearTimeout(state.journeyPreviewTimer);
      }
      state.journeyPreviewTimer = setTimeout(() => {
        state.journeyPreviewTimer = null;
        void runJourneyPreview();
      }, 300);
    };

    const runJourneyPreview = async (): Promise<void> => {
      const { origin, destination } = state.journeyPlan;
      const client = new WmataClient(state.apiKey);
      try {
        const data = await client.get<PathResponse>(
          buildPathUrl(origin, destination),
        );
        const path = data.Path ?? [];
        if (path.length === 0) {
          state.journeyPreviewText = 'Cross-line route — transfer required (WP-K).';
        } else {
          const line = path[0]?.LineCode ?? '?';
          const stops = Math.max(0, path.length - 1);
          const mins = estimateTravelMinutes(path);
          state.journeyPreviewText = `${line} line · ${stops} stops · ~${mins} min`;
        }
      } catch (err) {
        if (err instanceof WmataError) {
          state.journeyPreviewText = "Couldn't preview path — check codes.";
        } else {
          state.journeyPreviewText = 'Preview failed.';
        }
      }
      previewRow.textContent = state.journeyPreviewText;
    };

    const persist = (): void => {
      saveJourneyPlan(state.journeyPlan);
      refreshPreview();
    };

    const makeField = (
      label: string,
      key: keyof JourneyPlan,
    ): HTMLElement => {
      const id = `wmata-settings-journey-${key}`;
      const labelEl = el(
        'label',
        { class: 'wmata-settings__label', for: id },
        [label],
      );
      const input = el('input', {
        id,
        class: 'wmata-settings__input',
        type: 'text',
        list: dataListId,
        placeholder: 'Station code',
        value: state.journeyPlan[key],
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
      });
      input.value = state.journeyPlan[key];
      input.addEventListener('change', () => {
        state.journeyPlan = {
          ...state.journeyPlan,
          [key]: input.value.trim().toUpperCase(),
        };
        persist();
      });
      return el('div', { class: 'wmata-settings__field' }, [labelEl, input]);
    };

    journeyMount.appendChild(makeField('Origin station', 'origin'));
    journeyMount.appendChild(makeField('Destination station', 'destination'));
    journeyMount.appendChild(previewRow);

    // Kick off a preview on initial render if both fields are set.
    refreshPreview();
  }

  // -----------------------------------------------------------------------
  // Geofence toggle (WP-H/H4)
  // -----------------------------------------------------------------------
  function renderGeofenceCard(): void {
    geofenceMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    geofenceMount.setAttribute('aria-disabled', gated ? 'true' : 'false');

    geofenceMount.appendChild(
      el(
        'h2',
        {
          id: 'wmata-settings-geofence-title',
          class: 'wmata-settings__card-title',
        },
        ['Geofence auto-mount — optional'],
      ),
    );
    if (gated) {
      geofenceMount.appendChild(
        el('p', { class: 'wmata-settings__card-help' }, [
          'Validate your WMATA API key above to configure geofencing.',
        ]),
      );
      return;
    }
    geofenceMount.appendChild(
      el('p', { class: 'wmata-settings__card-help' }, [
        'When enabled, the glasses HUD boots straight to predictions for the nearest ' +
          'favorite within 250 m of your phone. Requires location permission. ' +
          'Favorites added before v1.2 need to be re-added once to capture coordinates.',
      ]),
    );

    const id = 'wmata-settings-geofence-toggle';
    const labelEl = el(
      'label',
      { class: 'wmata-settings__label', for: id },
      ['Auto-mount predictions when near a favorite'],
    );
    const input = el('input', {
      id,
      class: 'wmata-settings__toggle',
      type: 'checkbox',
    }) as HTMLInputElement;
    input.checked = state.geofenceEnabled;
    input.addEventListener('change', () => {
      state.geofenceEnabled = input.checked;
      saveGeofenceEnabled(state.geofenceEnabled);
    });

    geofenceMount.appendChild(
      el(
        'div',
        { class: 'wmata-settings__field wmata-settings__field--inline' },
        [input, labelEl],
      ),
    );
  }

  // Initial render --------------------------------------------------------
  renderApiKeyCard();
  renderFavoritesCard();
  renderSttCard();
  renderScheduleCard();
  renderVoiceTargetsCard();
  renderJourneyCard();
  renderGeofenceCard();

  // -----------------------------------------------------------------------
  // Unmount
  // -----------------------------------------------------------------------
  return function unmount(): void {
    if (state.searchTimer !== null) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
    if (state.favoritesNoticeTimer !== null) {
      clearTimeout(state.favoritesNoticeTimer);
      state.favoritesNoticeTimer = null;
    }
    if (state.journeyPreviewTimer !== null) {
      clearTimeout(state.journeyPreviewTimer);
      state.journeyPreviewTimer = null;
    }
    // replaceChildren() detaches every node, which also detaches the
    // listeners they own (they live on the elements, not the document),
    // so we don't need to explicitly removeEventListener for each one.
    root.replaceChildren();
  };
}
