// Typed settings + favorites store for the G2 companion app.
//
// Persists two pieces of user state to the browser's `localStorage`:
//   1. The WMATA developer API key (`wmata.g2.apiKey`).
//   2. An ordered list of up to MAX_FAVORITES pinned stations
//      (`wmata.g2.favorites`).
//
// Why localStorage and not the SDK bridge?
//   The Even Realities SDK does expose `bridge.setLocalStorage` /
//   `bridge.getLocalStorage` (see
//   node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts lines 1132-1157),
//   but those calls are async (`Promise<...>`) and require waiting for
//   `appBridgeReady`. This module is required by the spec to be pure
//   (no SDK imports) and fully synchronous so it can be called from
//   anywhere — including before the bridge is ready, and from tests.
//   The companion settings screen runs inside the host phone app's WebView
//   where `window.localStorage` is reliable, so we use it directly here.
//
// Schema
//   Every stored object is stamped with `schemaVersion: 1`. On load, a
//   mismatched (or missing) version causes us to return defaults rather
//   than attempt to interpret unknown shapes. This gives us a clean upgrade
//   path: bump the constant, add a migration branch, done.
//
// Failure modes
//   `localStorage` can throw synchronously in two real-world cases we care
//   about:
//     - SecurityError when the WebView is in a cross-origin iframe or the
//       user has disabled site data (some private-browsing modes).
//     - QuotaExceededError on writes when storage is full.
//   Both are caught and logged via `console.warn`. Reads degrade to
//   defaults; writes degrade to a no-op. The app continues to function,
//   it just won't remember anything across reloads. We do NOT keep an
//   in-memory fallback — callers that need that should layer it on top.

import type { LineCode } from "../wmata";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

/** A station the user pinned to their glasses Home screen. */
export type FavoriteStation = {
  code: string;
  name: string;
  lines: LineCode[];
};

/** Public shape returned by `loadSettings`. */
export interface Settings {
  apiKey: string;
  favorites: FavoriteStation[];
  /**
   * Deepgram streaming-STT API key. Empty string is the documented
   * "no STT" state (same convention as `apiKey`). With no key the
   * VOICE LOOKUP row on the glasses will fail with a clear error and
   * bounce back to Home.
   */
  sttApiKey: string;
  /**
   * True once the user has seen the first-launch gesture cheat sheet.
   *
   * Migration rule (rather than bumping SCHEMA_VERSION, which would
   * invalidate every v1 user's stored value): when the
   * `wmata.g2.tutorialSeen` key is absent, infer `true` if the user
   * has any prior stored state (an `apiKey` was set) and `false`
   * otherwise. Net effect: existing v1.1 users do NOT see the
   * tutorial on upgrade (they're already configured), and only
   * genuine first-launchers do.
   */
  tutorialSeen: boolean;
}

/** Maximum number of favorite stations a user can pin. */
export const MAX_FAVORITES = 5;

/** Bumped whenever the on-disk schema changes incompatibly. */
const SCHEMA_VERSION = 1;

/** Namespaced storage keys so we don't collide with the host app. */
const KEY_API_KEY = "wmata.g2.apiKey";
const KEY_FAVORITES = "wmata.g2.favorites";
const KEY_STT_API_KEY = "wmata.g2.sttApiKey";
const KEY_TUTORIAL_SEEN = "wmata.g2.tutorialSeen";

/** Set of valid LineCode literals, for runtime narrowing of parsed JSON. */
const VALID_LINE_CODES: ReadonlySet<string> = new Set<string>([
  "RD",
  "BL",
  "YL",
  "OR",
  "GR",
  "SV",
]);

/** Envelope written to localStorage. Strings & arrays are stored wrapped. */
interface Envelope<T> {
  schemaVersion: number;
  value: T;
}

// ---------------------------------------------------------------------------
// Safe localStorage wrappers
// ---------------------------------------------------------------------------

/**
 * Read a raw string from localStorage. Returns `null` on any error
 * (SecurityError in private browsing, no `window`, etc.) so the caller
 * can fall through to defaults.
 */
function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch (err) {
    console.warn(`[settings] localStorage.getItem(${key}) failed:`, err);
    return null;
  }
}

/**
 * Write a raw string to localStorage. Swallows QuotaExceededError and
 * SecurityError — the app stays alive, but the value isn't persisted.
 */
function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[settings] localStorage.setItem(${key}) failed:`, err);
  }
}

/** Remove a key. Same swallow-and-warn semantics as `safeSet`. */
function safeRemove(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch (err) {
    console.warn(`[settings] localStorage.removeItem(${key}) failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// JSON parsing helpers (operate on `unknown`, never `any`)
// ---------------------------------------------------------------------------

/** Type guard: is this a non-null object we can index into? */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * Parse a localStorage string into an envelope of the expected version.
 * Returns `null` if anything is off: missing string, bad JSON, missing
 * schemaVersion, mismatched schemaVersion, or wrong-shaped envelope.
 */
function parseEnvelope(raw: string | null): unknown {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[settings] corrupt JSON in storage; ignoring:", err);
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed["schemaVersion"] !== SCHEMA_VERSION) return null;
  return parsed["value"];
}

/** Narrow an unknown value to a `LineCode`, or return null. */
function asLineCode(x: unknown): LineCode | null {
  return typeof x === "string" && VALID_LINE_CODES.has(x) ? (x as LineCode) : null;
}

/**
 * Narrow an unknown value to a `FavoriteStation`, dropping any malformed
 * `lines` entries. Returns null if `code`/`name` are missing.
 */
function asFavorite(x: unknown): FavoriteStation | null {
  if (!isRecord(x)) return null;
  const code = x["code"];
  const name = x["name"];
  const lines = x["lines"];
  if (typeof code !== "string" || typeof name !== "string") return null;
  if (!Array.isArray(lines)) return null;
  const cleanedLines: LineCode[] = [];
  for (const line of lines) {
    const lc = asLineCode(line);
    if (lc !== null) cleanedLines.push(lc);
  }
  return { code, name, lines: cleanedLines };
}

/** Narrow an unknown value to a `FavoriteStation[]`, dropping malformed rows. */
function asFavoritesArray(x: unknown): FavoriteStation[] {
  if (!Array.isArray(x)) return [];
  const out: FavoriteStation[] = [];
  for (const item of x) {
    const fav = asFavorite(item);
    if (fav !== null) out.push(fav);
  }
  return out.slice(0, MAX_FAVORITES);
}

// ---------------------------------------------------------------------------
// Read helpers (split so each key can fail independently)
// ---------------------------------------------------------------------------

function readApiKey(): string {
  const value = parseEnvelope(safeGet(KEY_API_KEY));
  return typeof value === "string" ? value : "";
}

function readSttApiKey(): string {
  const value = parseEnvelope(safeGet(KEY_STT_API_KEY));
  return typeof value === "string" ? value : "";
}

function readFavorites(): FavoriteStation[] {
  const value = parseEnvelope(safeGet(KEY_FAVORITES));
  return asFavoritesArray(value);
}

/**
 * Read the tutorial-seen flag.
 *
 *   - Explicit `true` / `false` stored under `KEY_TUTORIAL_SEEN`
 *     (schema-versioned envelope) wins.
 *   - Absent: infer `true` for existing users (any non-empty
 *     `KEY_API_KEY`), `false` for clean installs. This avoids
 *     bumping `SCHEMA_VERSION` (which would discard every v1 user's
 *     favorites + key on upgrade — see RISK #1 in the WP-A plan).
 */
function readTutorialSeen(): boolean {
  const raw = safeGet(KEY_TUTORIAL_SEEN);
  if (raw !== null) {
    const value = parseEnvelope(raw);
    if (typeof value === "boolean") return value;
  }
  // Inference path. `parseEnvelope` returns null for missing /
  // corrupt / version-mismatched envelopes; in any of those cases
  // we fall back to "existing user → seen, fresh install → unseen".
  const apiKey = parseEnvelope(safeGet(KEY_API_KEY));
  return typeof apiKey === "string" && apiKey.length > 0;
}

function writeFavorites(favorites: FavoriteStation[]): void {
  const envelope: Envelope<FavoriteStation[]> = {
    schemaVersion: SCHEMA_VERSION,
    value: favorites,
  };
  safeSet(KEY_FAVORITES, JSON.stringify(envelope));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current settings. Returns defaults (empty key, empty list) if
 * nothing is stored, the schema version doesn't match, or the stored JSON
 * is corrupt. Never throws.
 */
export function loadSettings(): Settings {
  return {
    apiKey: readApiKey(),
    favorites: readFavorites(),
    sttApiKey: readSttApiKey(),
    tutorialSeen: readTutorialSeen(),
  };
}

/**
 * Mark the first-launch gesture cheat sheet as seen. Called by the
 * Tutorial screen's `onUnmount` exactly once.
 */
export function markTutorialSeen(): void {
  const envelope: Envelope<boolean> = {
    schemaVersion: SCHEMA_VERSION,
    value: true,
  };
  safeSet(KEY_TUTORIAL_SEEN, JSON.stringify(envelope));
}

/**
 * Persist a new API key. Whitespace is trimmed. Passing `""` is allowed
 * and is the documented way to clear a previously saved key.
 */
export function saveApiKey(key: string): void {
  const trimmed = key.trim();
  const envelope: Envelope<string> = {
    schemaVersion: SCHEMA_VERSION,
    value: trimmed,
  };
  safeSet(KEY_API_KEY, JSON.stringify(envelope));
}

/**
 * Persist the Deepgram STT API key. Whitespace is trimmed. Passing
 * `""` is allowed and is the documented "no STT" state — the Voice
 * screen will then fail with a clear error and bounce back to Home,
 * matching the `saveApiKey("")` convention.
 */
export function saveSttApiKey(key: string): void {
  const trimmed = key.trim();
  const envelope: Envelope<string> = {
    schemaVersion: SCHEMA_VERSION,
    value: trimmed,
  };
  safeSet(KEY_STT_API_KEY, JSON.stringify(envelope));
}

/**
 * Append a favorite. No-op if a station with the same `code` is already
 * present. Enforces the `MAX_FAVORITES` cap by silently refusing to add
 * once the list is full (this lets the caller compare lengths before/after
 * to detect the cap was hit, without us throwing).
 *
 * Returns the updated list.
 */
export function addFavorite(station: FavoriteStation): FavoriteStation[] {
  const current = readFavorites();
  if (current.some((f) => f.code === station.code)) return current;
  if (current.length >= MAX_FAVORITES) return current;
  const next = [...current, station];
  writeFavorites(next);
  return next;
}

/** Remove a favorite by code. Returns the updated list. */
export function removeFavorite(code: string): FavoriteStation[] {
  const current = readFavorites();
  const next = current.filter((f) => f.code !== code);
  if (next.length === current.length) return current;
  writeFavorites(next);
  return next;
}

/**
 * Replace the favorites list with a new ordering. Throws if the supplied
 * list exceeds `MAX_FAVORITES`.
 *
 * The caller is trusted: codes that are not currently in storage are
 * accepted and written through as-is. (The settings screen builds this
 * list by reordering the existing array, so a foreign code would only
 * appear if the caller is intentionally seeding favorites — which is
 * a legitimate use, e.g. for an import/restore flow.)
 */
export function reorderFavorites(newOrder: FavoriteStation[]): FavoriteStation[] {
  if (newOrder.length > MAX_FAVORITES) {
    throw new Error(
      `reorderFavorites: ${newOrder.length} entries exceeds MAX_FAVORITES (${MAX_FAVORITES})`,
    );
  }
  // Defensive copy so external mutations don't change what we wrote.
  const snapshot = newOrder.map((f) => ({
    code: f.code,
    name: f.name,
    lines: [...f.lines],
  }));
  writeFavorites(snapshot);
  return snapshot;
}

/** Wipe all stored settings. Useful for tests and the "reset" flow. */
export function clearSettings(): void {
  safeRemove(KEY_API_KEY);
  safeRemove(KEY_FAVORITES);
  safeRemove(KEY_STT_API_KEY);
  safeRemove(KEY_TUTORIAL_SEEN);
}
