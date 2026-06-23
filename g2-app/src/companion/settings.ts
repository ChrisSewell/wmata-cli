/// <reference types="vite/client" />

// Companion settings screen — the phone-side WebView UI for configuration.
// Typing on a HUD would be miserable, so all setup happens here; the glasses
// only render glanceable transit info. Two cards: WMATA API key, and favorite
// stations. The glasses auto-transition from the "finish setup" placeholder to
// the live Home screen the moment a key + a favorite are saved (a watcher in
// host/main.ts) — no reload, no button.
//
// Pure DOM (no framework). Scoped re-renders: each card owns a mount node and
// rebuilds only itself, so the API-key input never loses focus when the
// favorites card changes.

import "./settings.css";

import { WmataClient, WmataError, searchStations, type Station, type LineCode } from "../data/wmata";
import {
  loadSettings,
  saveApiKey,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  clearSettings,
  MAX_FAVORITES,
  type FavoriteStation,
} from "../storage/settings";

interface ScreenState {
  apiKey: string;
  /** True once a key validated this session (or a saved key exists at mount). Gates the favorites card. */
  keyAccepted: boolean;
  favorites: FavoriteStation[];
  searchTimer: ReturnType<typeof setTimeout> | null;
  searchResults: Station[];
  searchError: string | null;
  searchQuery: string;
  favoritesNotice: string | null;
  favoritesNoticeTimer: ReturnType<typeof setTimeout> | null;
  /** favorites count at the previous render — detects the 0→1 transition for the live-banner pulse. */
  favoritesCountAtLastRender: number;
}

// --- DOM helpers ----------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function formatLines(station: Station): string {
  return stationLineCodes(station).join(", ");
}

function stationLineCodes(station: Station): LineCode[] {
  const codes: LineCode[] = [];
  for (const c of [station.LineCode1, station.LineCode2, station.LineCode3, station.LineCode4]) {
    if (c) codes.push(c);
  }
  return codes;
}

/** Real round-trip probe — the storage wrapper swallows errors silently. */
function storageIsAvailable(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const probe = "wmata.g2.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

// --- Mount ----------------------------------------------------------------

export function mountSettingsScreen(root: HTMLElement): () => void {
  root.replaceChildren();

  const initial = loadSettings();
  const state: ScreenState = {
    apiKey: initial.apiKey,
    keyAccepted: initial.apiKey.length > 0,
    favorites: initial.favorites,
    searchTimer: null,
    searchResults: [],
    searchError: null,
    searchQuery: "",
    favoritesNotice: null,
    favoritesNoticeTimer: null,
    favoritesCountAtLastRender: initial.favorites.length,
  };

  const container = el("div", { class: "wmata-settings" });
  root.appendChild(container);

  container.appendChild(
    el("header", { class: "wmata-settings__header" }, [
      el("h1", { class: "wmata-settings__title" }, ["WMATA Transit"]),
      el("p", { class: "wmata-settings__tagline" }, ["Real-time DC Metro on your G2 glasses."]),
      el("p", { class: "wmata-settings__version" }, [`v${__APP_VERSION__}`]),
    ]),
  );

  if (!storageIsAvailable()) {
    container.appendChild(
      el("div", { class: "wmata-settings__banner", role: "status" }, [
        "Browser storage is unavailable — settings won't be saved between sessions.",
      ]),
    );
  }

  const apiKeyMount = el("section", {
    class: "wmata-settings__card",
    "aria-labelledby": "wmata-settings-apikey-title",
  });
  const favoritesMount = el("section", {
    class: "wmata-settings__card",
    "aria-labelledby": "wmata-settings-favs-title",
  });
  container.appendChild(apiKeyMount);
  container.appendChild(favoritesMount);

  const footerResetBtn = el(
    "button",
    { type: "button", class: "wmata-settings__button wmata-settings__button--danger" },
    ["Reset all settings"],
  );
  footerResetBtn.addEventListener("click", () => {
    if (!window.confirm("Reset all settings? This clears your API key and favorites.")) return;
    clearSettings();
    state.apiKey = "";
    state.keyAccepted = false;
    state.favorites = [];
    state.searchResults = [];
    state.searchError = null;
    state.searchQuery = "";
    state.favoritesNotice = null;
    state.favoritesCountAtLastRender = 0;
    renderApiKeyCard();
    renderFavoritesCard();
  });
  container.appendChild(el("footer", { class: "wmata-settings__footer" }, [footerResetBtn]));

  // --- API key card -------------------------------------------------------

  function renderApiKeyCard(): void {
    apiKeyMount.replaceChildren();

    const input = el("input", {
      id: "wmata-settings-apikey",
      class: "wmata-settings__input",
      type: "password",
      inputmode: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: "Paste your 32-character key",
      value: state.apiKey,
    });
    input.value = state.apiKey;
    input.addEventListener("input", () => {
      state.apiKey = input.value;
    });

    const showToggle = el(
      "button",
      {
        type: "button",
        class:
          "wmata-settings__button wmata-settings__button--ghost wmata-settings__button--small",
        "aria-pressed": "false",
      },
      ["Show"],
    );
    let revealed = false;
    showToggle.addEventListener("click", () => {
      revealed = !revealed;
      input.type = revealed ? "text" : "password";
      showToggle.textContent = revealed ? "Hide" : "Show";
      showToggle.setAttribute("aria-pressed", revealed ? "true" : "false");
    });

    const status = el("div", {
      class: "wmata-settings__status wmata-settings__status--info",
      "aria-live": "polite",
      role: "status",
    });
    const setStatus = (text: string, kind: "ok" | "bad" | "info"): void => {
      status.textContent = text;
      status.className = `wmata-settings__status wmata-settings__status--${kind}`;
    };

    const validateBtn = el(
      "button",
      { type: "button", class: "wmata-settings__button wmata-settings__button--primary" },
      ["Validate"],
    );
    const clearBtn = el(
      "button",
      { type: "button", class: "wmata-settings__button wmata-settings__button--ghost" },
      ["Clear"],
    );

    const onValidate = async (): Promise<void> => {
      const trimmed = input.value.trim();
      if (trimmed.length === 0) {
        setStatus("Enter a key first.", "bad");
        return;
      }
      validateBtn.disabled = true;
      clearBtn.disabled = true;
      const original = validateBtn.textContent;
      validateBtn.textContent = "Validating…";
      setStatus("Validating…", "info");
      try {
        const ok = await new WmataClient(trimmed).validate();
        if (ok) {
          saveApiKey(trimmed);
          state.apiKey = trimmed;
          state.keyAccepted = true;
          setStatus("✓ Key accepted", "ok");
        } else {
          state.keyAccepted = false;
          setStatus("✕ Key rejected — check the value or your network.", "bad");
        }
        renderFavoritesCard();
      } finally {
        validateBtn.disabled = false;
        clearBtn.disabled = false;
        validateBtn.textContent = original ?? "Validate";
      }
    };
    validateBtn.addEventListener("click", () => void onValidate());

    clearBtn.addEventListener("click", () => {
      saveApiKey("");
      state.apiKey = "";
      state.keyAccepted = false;
      input.value = "";
      setStatus("", "info");
      renderFavoritesCard();
    });

    apiKeyMount.appendChild(
      el("h2", { id: "wmata-settings-apikey-title", class: "wmata-settings__card-title" }, [
        "WMATA API key",
      ]),
    );
    apiKeyMount.appendChild(
      el("p", { class: "wmata-settings__card-help" }, [
        "Get a free developer key from developer.wmata.com. We store it locally on this device only.",
      ]),
    );
    apiKeyMount.appendChild(
      el("div", { class: "wmata-settings__field" }, [
        el("label", { class: "wmata-settings__label", for: "wmata-settings-apikey" }, ["Key"]),
        el("div", { class: "wmata-settings__input-row" }, [input, showToggle]),
      ]),
    );
    apiKeyMount.appendChild(
      el("div", { class: "wmata-settings__button-row" }, [validateBtn, clearBtn]),
    );
    apiKeyMount.appendChild(status);

    if (state.keyAccepted && state.apiKey.length > 0) setStatus("✓ Key saved", "ok");
  }

  // --- Favorites card -----------------------------------------------------

  async function runSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    state.searchQuery = trimmed;
    if (trimmed.length === 0) {
      state.searchResults = [];
      state.searchError = null;
      renderFavoritesResults();
      return;
    }
    try {
      const results = await searchStations(new WmataClient(state.apiKey), trimmed);
      state.searchResults = results.slice(0, 8);
      state.searchError = null;
    } catch (err) {
      state.searchResults = [];
      if (err instanceof WmataError) {
        state.searchError = "Couldn't load stations — check your key and try again.";
      } else {
        console.error("[settings] unexpected search error:", err);
        state.searchError = "Unexpected error while searching.";
      }
    }
    renderFavoritesResults();
  }

  function showFavoritesNotice(message: string): void {
    state.favoritesNotice = message;
    if (state.favoritesNoticeTimer !== null) clearTimeout(state.favoritesNoticeTimer);
    state.favoritesNoticeTimer = setTimeout(() => {
      state.favoritesNotice = null;
      state.favoritesNoticeTimer = null;
      renderFavoritesResults();
    }, 3000);
  }

  function showErrorToast(message: string): void {
    const toast = el("div", { class: "wmata-settings__toast", role: "alert" }, [message]);
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode === container) container.removeChild(toast);
    }, 3000);
  }

  // Dynamic results sub-node of the favorites card; rebuilt by
  // renderFavoritesResults() WITHOUT recreating the search input above it.
  let favoritesResultsMount: HTMLElement | null = null;

  function renderFavoritesCard(): void {
    favoritesResultsMount = null;
    favoritesMount.replaceChildren();
    const gated = !state.keyAccepted || state.apiKey.length === 0;
    favoritesMount.setAttribute("aria-disabled", gated ? "true" : "false");

    favoritesMount.appendChild(
      el("h2", { id: "wmata-settings-favs-title", class: "wmata-settings__card-title" }, [
        "Favorite stations",
      ]),
    );

    if (gated) {
      favoritesMount.appendChild(
        el("p", { class: "wmata-settings__card-help" }, [
          "Validate your API key above to start adding favorites.",
        ]),
      );
      return;
    }

    favoritesMount.appendChild(
      el("p", { class: "wmata-settings__card-help" }, [
        `Pin up to ${String(MAX_FAVORITES)} stations. They show on the glasses Home screen.`,
      ]),
    );

    // Search field
    const searchInput = el("input", {
      id: "wmata-settings-search",
      class: "wmata-settings__input",
      type: "search",
      inputmode: "search",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: "e.g. Metro Center",
      value: state.searchQuery,
    });
    searchInput.value = state.searchQuery;
    searchInput.addEventListener("input", () => {
      const value = searchInput.value;
      if (state.searchTimer !== null) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.searchTimer = null;
        void runSearch(value);
      }, 200);
    });
    favoritesMount.appendChild(
      el("div", { class: "wmata-settings__field" }, [
        el("label", { class: "wmata-settings__label", for: "wmata-settings-search" }, [
          "Find a station",
        ]),
        searchInput,
      ]),
    );

    // The dynamic results region lives in its own mount so re-rendering matches
    // never recreates the search <input> above — recreating it would detach the
    // focused field and dismiss the mobile keyboard mid-typing.
    favoritesResultsMount = el("div", { class: "wmata-settings__results" });
    favoritesMount.appendChild(favoritesResultsMount);
    renderFavoritesResults();
  }

  /** Rebuilds ONLY the search-results + favorites-list region. The search input
   *  (in renderFavoritesCard) is left untouched, so typing keeps focus. */
  function renderFavoritesResults(): void {
    const mount = favoritesResultsMount;
    if (!mount) return; // gated — no search field rendered
    mount.replaceChildren();

    if (state.searchError !== null) {
      mount.appendChild(
        el("div", { class: "wmata-settings__status wmata-settings__status--bad", role: "alert" }, [
          state.searchError,
        ]),
      );
    }
    if (state.favoritesNotice !== null) {
      mount.appendChild(
        el(
          "div",
          {
            class: "wmata-settings__status wmata-settings__status--info",
            role: "status",
            "aria-live": "polite",
          },
          [state.favoritesNotice],
        ),
      );
    }

    // Search results
    const atCap = state.favorites.length >= MAX_FAVORITES;
    if (state.searchResults.length > 0) {
      const list = el("ul", { class: "wmata-settings__list" });
      for (const station of state.searchResults) {
        const alreadyPinned = state.favorites.some((f) => f.code === station.Code);
        const addBtn = el(
          "button",
          {
            type: "button",
            class:
              "wmata-settings__button wmata-settings__button--small wmata-settings__button--primary",
            "aria-label": `Add ${station.Name} to favorites`,
          },
          [atCap ? "Limit reached (5)" : alreadyPinned ? "Added" : "+ Add"],
        );
        if (atCap || alreadyPinned) addBtn.disabled = true;
        addBtn.addEventListener("click", () => {
          const before = state.favorites.length;
          const next = addFavorite({
            code: station.Code,
            name: station.Name,
            lines: stationLineCodes(station),
          });
          state.favorites = next;
          if (next.length === before) {
            showFavoritesNotice(
              next.some((f) => f.code === station.Code) ? "Already a favorite." : "Limit reached (5).",
            );
          }
          renderFavoritesResults();
        });
        list.appendChild(
          el("li", { class: "wmata-settings__row" }, [
            el("div", { class: "wmata-settings__row-main" }, [
              el("div", { class: "wmata-settings__row-name" }, [station.Name]),
              el("div", { class: "wmata-settings__row-meta" }, [
                el("span", { class: "wmata-settings__row-code" }, [station.Code]),
                "  ",
                formatLines(station),
              ]),
            ]),
            el("div", { class: "wmata-settings__row-actions" }, [addBtn]),
          ]),
        );
      }
      mount.appendChild(list);
    } else if (state.searchQuery.length > 0 && state.searchError === null) {
      mount.appendChild(
        el("div", { class: "wmata-settings__empty" }, ["No stations match that query."]),
      );
    }

    // Favorites list
    const previousCount = state.favoritesCountAtLastRender;
    mount.appendChild(
      el("h3", { class: "wmata-settings__card-title" }, [
        `Your favorites (${String(state.favorites.length)}/${String(MAX_FAVORITES)})`,
      ]),
    );

    if (state.favorites.length === 0) {
      mount.appendChild(
        el("div", { class: "wmata-settings__empty" }, [
          "No favorites yet. Use the search above to pin a station.",
        ]),
      );
    } else {
      const favList = el("ul", { class: "wmata-settings__list" });
      state.favorites.forEach((fav, idx) => {
        const upBtn = el(
          "button",
          {
            type: "button",
            class: "wmata-settings__button wmata-settings__button--icon",
            "aria-label": `Move ${fav.name} up`,
            title: "Move up",
          },
          ["▲"],
        );
        const downBtn = el(
          "button",
          {
            type: "button",
            class: "wmata-settings__button wmata-settings__button--icon",
            "aria-label": `Move ${fav.name} down`,
            title: "Move down",
          },
          ["▼"],
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
            console.error("[settings] reorderFavorites threw:", err);
            showErrorToast("Couldn't reorder favorites.");
            return;
          }
          renderFavoritesResults();
        };
        upBtn.addEventListener("click", () => moveBy(-1));
        downBtn.addEventListener("click", () => moveBy(1));

        const removeBtn = el(
          "button",
          {
            type: "button",
            class:
              "wmata-settings__button wmata-settings__button--small wmata-settings__button--ghost",
            "aria-label": `Remove ${fav.name} from favorites`,
          },
          ["Remove"],
        );
        removeBtn.addEventListener("click", () => {
          state.favorites = removeFavorite(fav.code);
          renderFavoritesResults();
        });

        favList.appendChild(
          el("li", { class: "wmata-settings__row" }, [
            el("div", { class: "wmata-settings__row-main" }, [
              el("div", { class: "wmata-settings__row-name" }, [fav.name]),
              el("div", { class: "wmata-settings__row-meta" }, [
                el("span", { class: "wmata-settings__row-code" }, [fav.code]),
                "  ",
                fav.lines.join(", "),
              ]),
            ]),
            el("div", { class: "wmata-settings__row-actions" }, [upBtn, downBtn, removeBtn]),
          ]),
        );
      });
      mount.appendChild(favList);
    }

    // Passive "live on your glasses" confirmation. The glasses auto-transition
    // from the setup placeholder to Home once key + ≥1 favorite are saved.
    if (state.keyAccepted && state.favorites.length > 0) {
      const justGotFirst = previousCount === 0 && state.favorites.length >= 1;
      mount.appendChild(
        el("div", { class: "wmata-settings__done-row" }, [
          el(
            "div",
            {
              class: justGotFirst
                ? "wmata-settings__status wmata-settings__status--ok wmata-settings__live wmata-settings__live--attention"
                : "wmata-settings__status wmata-settings__status--ok wmata-settings__live",
              "data-testid": "wmata-settings-live",
              role: "status",
              "aria-live": "polite",
            },
            ["✓ Live on your glasses — edits apply automatically"],
          ),
        ]),
      );
    }

    state.favoritesCountAtLastRender = state.favorites.length;
  }

  renderApiKeyCard();
  renderFavoritesCard();

  return function unmount(): void {
    if (state.searchTimer !== null) clearTimeout(state.searchTimer);
    if (state.favoritesNoticeTimer !== null) clearTimeout(state.favoritesNoticeTimer);
    root.replaceChildren();
  };
}
