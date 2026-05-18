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
  addFavorite,
  removeFavorite,
  reorderFavorites,
  clearSettings,
  MAX_FAVORITES,
  type FavoriteStation,
} from '../storage/settings';

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
}

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
    favorites: initial.favorites,
    searchTimer: null,
    searchResults: [],
    searchError: null,
    searchQuery: '',
    favoritesNotice: null,
    favoritesNoticeTimer: null,
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
  container.appendChild(apiKeyMount);
  container.appendChild(favoritesMount);

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
    state.favorites = [];
    state.searchResults = [];
    state.searchError = null;
    state.searchQuery = '';
    state.favoritesNotice = null;
    renderApiKeyCard();
    renderFavoritesCard();
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
          // Favorites card was disabled — re-render so it activates.
          renderFavoritesCard();
        } else {
          state.keyAccepted = false;
          setStatus('✕ Key rejected — check the value or your network.', 'bad');
          // Re-render the favorites card so it shows as disabled if it
          // was previously enabled.
          renderFavoritesCard();
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

    // Favorites list -----------------------------------------------------
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
  }

  // Initial render --------------------------------------------------------
  renderApiKeyCard();
  renderFavoritesCard();

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
    // replaceChildren() detaches every node, which also detaches the
    // listeners they own (they live on the elements, not the document),
    // so we don't need to explicitly removeEventListener for each one.
    root.replaceChildren();
  };
}
