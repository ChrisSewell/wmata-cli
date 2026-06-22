// Typed settings + favorites store for the companion app. Synchronous and
// SDK-free so it can be called from anywhere (including before the bridge is
// ready, and from tests); the durable bridge mirror is bolted on via
// `setStorageMirror` (see `storage/bridge-sync.ts`).
//
// Persists two pieces of state to `localStorage`, each wrapped in a
// schema-versioned envelope:
//   1. The WMATA developer API key (`wmata.g2.apiKey`).
//   2. An ordered list of up to MAX_FAVORITES pinned stations
//      (`wmata.g2.favorites`).
//
// Reads degrade to defaults; writes degrade to a no-op (localStorage can throw
// SecurityError in private mode / QuotaExceededError when full). Never throws.

import type { LineCode } from "../data/wmata";
import type { FavoriteStation } from "../data/domain/lines";

export type { FavoriteStation };

/** Public shape returned by `loadSettings`. */
export interface Settings {
  apiKey: string;
  favorites: FavoriteStation[];
}

/** Maximum number of favorite stations a user can pin. */
export const MAX_FAVORITES = 5;

/** Bumped whenever the on-disk schema changes incompatibly. */
const SCHEMA_VERSION = 1;

const KEY_API_KEY = "wmata.g2.apiKey";
const KEY_FAVORITES = "wmata.g2.favorites";

/**
 * Every namespaced settings key, for the bridge-sync layer to hydrate from /
 * mirror to the Even Hub durable store. A key missing here won't survive an
 * app restart on hardware.
 */
export const STORAGE_KEYS: readonly string[] = [KEY_API_KEY, KEY_FAVORITES];

const VALID_LINE_CODES: ReadonlySet<string> = new Set<string>(["RD", "BL", "YL", "OR", "GR", "SV"]);

/** Envelope written to localStorage. */
interface Envelope<T> {
  schemaVersion: number;
  value: T;
}

// --- Durable-store mirror (Even Hub bridge) -------------------------------

let storageMirror: ((key: string, value: string) => void) | null = null;

/**
 * Register (or clear, with `null`) a sink that mirrors every settings write to
 * the durable Even Hub store. WebView `localStorage` may be cleared on app
 * restart; the bridge store is the cross-session source of truth. SDK-free
 * signature keeps this module pure.
 */
export function setStorageMirror(fn: ((key: string, value: string) => void) | null): void {
  storageMirror = fn;
}

// --- Safe localStorage wrappers -------------------------------------------

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch (err) {
    console.warn(`[settings] localStorage.getItem(${key}) failed:`, err);
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[settings] localStorage.setItem(${key}) failed:`, err);
  }
  // Mirror to the durable bridge store (best-effort). Runs even if the
  // localStorage write threw — the bridge copy survives an app restart.
  storageMirror?.(key, value);
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch (err) {
    console.warn(`[settings] localStorage.removeItem(${key}) failed:`, err);
  }
  storageMirror?.(key, ""); // empty string is the bridge store's "unset"
}

// --- JSON parsing helpers (operate on `unknown`) --------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Unwrap a schema-versioned envelope, or null on any mismatch / corruption. */
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

function asLineCode(x: unknown): LineCode | null {
  return typeof x === "string" && VALID_LINE_CODES.has(x) ? (x as LineCode) : null;
}

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

function asFavoritesArray(x: unknown): FavoriteStation[] {
  if (!Array.isArray(x)) return [];
  const out: FavoriteStation[] = [];
  for (const item of x) {
    const fav = asFavorite(item);
    if (fav !== null) out.push(fav);
  }
  return out.slice(0, MAX_FAVORITES);
}

function writeEnvelope<T>(key: string, value: T): void {
  const envelope: Envelope<T> = { schemaVersion: SCHEMA_VERSION, value };
  safeSet(key, JSON.stringify(envelope));
}

// --- Read helpers (each key fails independently) --------------------------

function readApiKey(): string {
  const value = parseEnvelope(safeGet(KEY_API_KEY));
  return typeof value === "string" ? value : "";
}

function readFavorites(): FavoriteStation[] {
  return asFavoritesArray(parseEnvelope(safeGet(KEY_FAVORITES)));
}

function writeFavorites(favorites: FavoriteStation[]): void {
  writeEnvelope(KEY_FAVORITES, favorites);
}

// --- Public API -----------------------------------------------------------

/** Read the current settings. Returns defaults on missing / corrupt / version-mismatched storage. Never throws. */
export function loadSettings(): Settings {
  return { apiKey: readApiKey(), favorites: readFavorites() };
}

/** Persist a new API key (trimmed). `""` clears it. */
export function saveApiKey(key: string): void {
  writeEnvelope(KEY_API_KEY, key.trim());
}

/**
 * Append a favorite. No-op if a station with the same `code` exists or the
 * list is full (`MAX_FAVORITES`). Returns the updated list.
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

/** Replace the favorites list with a new ordering. Throws if it exceeds the cap. */
export function reorderFavorites(newOrder: FavoriteStation[]): FavoriteStation[] {
  if (newOrder.length > MAX_FAVORITES) {
    throw new Error(`reorderFavorites: ${newOrder.length} exceeds MAX_FAVORITES (${MAX_FAVORITES})`);
  }
  const snapshot = newOrder.map((f) => ({ code: f.code, name: f.name, lines: [...f.lines] }));
  writeFavorites(snapshot);
  return snapshot;
}

/** Wipe all stored settings. */
export function clearSettings(): void {
  safeRemove(KEY_API_KEY);
  safeRemove(KEY_FAVORITES);
}
