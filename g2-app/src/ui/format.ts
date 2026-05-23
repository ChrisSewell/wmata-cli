// Field-level formatters that turn WMATA wire values into glanceable
// strings for the G2 HUD. Pure functions; no SDK, no I/O.
//
// These are the TypeScript counterparts to wmata/utils/formatting.py
// `format_min` and similar helpers used by rail_predictions.py. The
// glasses surface has even tighter width constraints than the CLI, so
// `abbreviateStation` is also defined here.
//
// Abbreviation budget:
//
//   Every value in `STATION_ABBREVIATIONS` must fit the narrowest column
//   it's rendered into (the predictions destination cell). Anything wider
//   is invisibly truncated with `…` at render time, defeating the purpose
//   of a hand-tuned abbreviation. These entries were shortened by hand so
//   they read cleanly rather than getting machine-truncated:
//
//     "Federal Triangle"  "Fed Triangle" -> "Fed Tri"
//     "Morgan Boulevard"  "Morgan Blvd"  -> "Morgan Bv"
//     "Virginia Sq-GMU"   "Virginia Sq"  -> "Virgnia Sq"
//     "Eastern Market"    "Eastern Mkt"  -> "Eastern Mk"
//     "Smithsonian"       "Smithsonian"  -> "Smithson"
//
//   A guard test in `format.test.ts` asserts every entry's PIXEL width
//   stays within that column budget so future entries can't drift.

import type { LineCode } from "../wmata";
import { ELLIPSIS, textWidth, truncate } from "./render";

/**
 * Map a WMATA `Min` string to its glasses-ready form.
 *
 *   ""    -> "—"     (no data)
 *   "---" -> "—"     (no prediction)
 *   "ARR" -> "ARR"
 *   "BRD" -> "BRD"
 *   "1"   -> "1 min"
 *   "12"  -> "12 min"
 *   else  -> the raw value (defensive — WMATA has surprised us before)
 */
export function formatEta(min: string): string {
  if (min === "" || min === "---") return "—";
  if (min === "ARR" || min === "BRD") return min;
  if (/^\d+$/.test(min)) return `${min} min`;
  return min;
}

/**
 * Format an epoch-millis wall clock as a 12-hour HUD label. Always
 * exactly 6 chars: 2-char hour (space-padded), ":", 2-char minute, and
 * a 1-char `a`/`p` suffix — e.g. " 2:32p", "12:05a". An invalid /
 * non-positive input renders " --:--" (also 6 chars) so the clock cell
 * stays a fixed width.
 *
 * This is the single source of truth for the HUD clock. The host
 * (`glasses-host.ts`) renders it into a dedicated top-right clock
 * container on every screen; screens no longer embed the clock in their
 * header string. The 12-hour convention matches `formatEta` and the
 * predictions/journey time labels.
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
 * Render a line code as a fixed-width 2-character glyph. Unknown,
 * blank, or non-revenue line codes collapse to `--` so the column stays
 * aligned in a `row(...)` composition.
 */
export function lineGlyph(line: string): string {
  const known: ReadonlySet<LineCode> = new Set<LineCode>([
    "RD",
    "BL",
    "YL",
    "OR",
    "GR",
    "SV",
  ]);
  if (known.has(line as LineCode)) return line;
  return "--";
}

/**
 * Map a WMATA line code (`RD` / `BL` / …) to its spelled-out
 * line name (`RED` / `BLUE` / …). Used wherever the glasses panel
 * has room for the full word — which, at LINE_WIDTH≥48, is most
 * places. Unknown codes collapse to the original input (so the
 * caller can fall back to truncation rather than getting "--").
 */
export function lineName(line: string): string {
  switch (line) {
    case "RD":
      return "RED";
    case "BL":
      return "BLUE";
    case "YL":
      return "YELLOW";
    case "OR":
      return "ORANGE";
    case "GR":
      return "GREEN";
    case "SV":
      return "SILVER";
    default:
      return line;
  }
}

/**
 * Hand-tuned abbreviations for stations whose canonical names overflow
 * any reasonable column budget on the glasses. Exact-string match only.
 * The map is the first lookup; truncation (via `truncate`) is the
 * fallback.
 *
 * Keep entries short enough to fit the *narrowest* expected column —
 * roughly 10-12 columns for the next-train list — but otherwise we let
 * `abbreviateStation`'s caller decide the column width.
 */
export const STATION_ABBREVIATIONS: Record<string, string> = {
  "L'Enfant Plaza": "L'Enfant",
  "Branch Ave": "Branch",
  "Largo Town Center": "Largo TC",
  "Vienna/Fairfax-GMU": "Vienna",
  "West Falls Church-VT/UVA": "W Falls Ch",
  "East Falls Church": "E Falls Ch",
  "Franconia-Springfield": "Franc-Spr",
  "New Carrollton": "New Carr",
  "Gallery Pl-Chinatown": "Gallery Pl",
  "Mt Vernon Sq 7th St-Convention Center": "Mt Vernon",
  "U Street/African-Amer Civil War Memorial/Cardozo": "U Street",
  "Dupont Circle": "Dupont",
  "Foggy Bottom-GWU": "Foggy Btm",
  "Federal Triangle": "Fed Tri",
  "Federal Center SW": "Fed Center",
  "Capitol South": "Capitol S",
  "Eastern Market": "Eastern Mk",
  "Stadium-Armory": "Stadium",
  Smithsonian: "Smithson",
  "McPherson Sq": "McPherson",
  "Metro Center": "Metro Ctr",
  "Judiciary Sq": "Judiciary",
  "Union Station": "Union Stn",
  "Rhode Island Ave-Brentwood": "Rhode Is",
  "Brookland-CUA": "Brookland",
  "Fort Totten": "Ft Totten",
  Takoma: "Takoma",
  "Silver Spring": "Silver Spr",
  "Forest Glen": "Forest Gln",
  Wheaton: "Wheaton",
  Glenmont: "Glenmont",
  "Shady Grove": "Shady Grv",
  Rockville: "Rockville",
  Twinbrook: "Twinbrook",
  "White Flint": "White Flnt",
  "Grosvenor-Strathmore": "Grosvenor",
  "Medical Center": "Med Ctr",
  Bethesda: "Bethesda",
  "Friendship Heights": "Friend Hts",
  "Tenleytown-AU": "Tenleytown",
  "Van Ness-UDC": "Van Ness",
  "Cleveland Park": "Cleveland",
  "Woodley Park-Zoo/Adams Morgan": "Woodley Pk",
  "Wiehle-Reston East": "Wiehle",
  "Spring Hill": "Spring Hl",
  Greensboro: "Greensboro",
  "Tysons Corner": "Tysons",
  McLean: "McLean",
  "Court House": "Court Hse",
  Clarendon: "Clarendon",
  "Virginia Sq-GMU": "Virgnia Sq",
  "Ballston-MU": "Ballston",
  Rosslyn: "Rosslyn",
  "Arlington Cemetery": "Arlington",
  Pentagon: "Pentagon",
  "Pentagon City": "Pentagon C",
  "Crystal City": "Crystal C",
  "Ronald Reagan Washington National Airport": "DCA",
  "Braddock Rd": "Braddock",
  "King St-Old Town": "King St",
  "Eisenhower Ave": "Eisenhower",
  Huntington: "Huntington",
  "Van Dorn St": "Van Dorn",
  Suitland: "Suitland",
  "Naylor Rd": "Naylor",
  "Southern Ave": "Southern",
  "Congress Heights": "Congress H",
  Anacostia: "Anacostia",
  "Navy Yard-Ballpark": "Navy Yard",
  Waterfront: "Waterfront",
  "Archives-Navy Memorial-Penn Quarter": "Archives",
  Cheverly: "Cheverly",
  Landover: "Landover",
  Deanwood: "Deanwood",
  "Minnesota Ave": "Minnesota",
  "Benning Rd": "Benning",
  "Capitol Heights": "Capitol H",
  "Addison Rd-Seat Pleasant": "Addison Rd",
  "Morgan Boulevard": "Morgan Bv",
  Greenbelt: "Greenbelt",
  "College Park-U of Md": "College Pk",
  "Prince George's Plaza": "Prince Geo",
  "West Hyattsville": "W Hyatts",
  "NoMa-Gallaudet U": "NoMa",
  "Shaw-Howard U": "Shaw",
  "Columbia Heights": "Columbia H",
  Petworth: "Petworth",
  "Georgia Ave-Petworth": "Georgia Av",
};

/**
 * Abbreviate a station name to fit `maxPx` pixels (measured in the
 * firmware font, kerning included).
 *
 * Strategy:
 *   1. If the canonical name fits, return it unchanged.
 *   2. If the name has a hand-tuned abbreviation that fits, use it.
 *   3. Otherwise, truncate with an ellipsis.
 *
 * The map is consulted whether or not the canonical name fits, because
 * a known short form is almost always more readable than a truncated
 * long one (e.g., "Vienna" beats "Vienna/Fai…").
 */
export function abbreviateStation(name: string, maxPx: number): string {
  if (!name) return "";
  if (maxPx <= 0) return "";
  const abbr = STATION_ABBREVIATIONS[name];
  // Prefer the canonical name when it already fits; otherwise reach for a
  // hand-tuned abbreviation that fits before falling back to truncation.
  if (textWidth(name) <= maxPx) return name;
  if (abbr && textWidth(abbr) <= maxPx) return abbr;
  // Fall back to truncation. If even the abbrev is too wide, prefer
  // truncating the abbrev (shorter source = less information loss).
  const source = abbr ?? name;
  return textWidth(source) <= maxPx ? source : truncate(source, maxPx);
}

/**
 * Title-case a strict-uppercase string. Used to normalise WMATA's
 * all-caps destination strings ("SHADY GROVE") into readable Title
 * Case ("Shady Grove") without mangling mixed-case input.
 *
 * Behaviour:
 *   - Input containing any lowercase letter is returned unchanged —
 *     "Vienna/Fairfax-GMU", "Foggy Bottom-GWU", "L'Enfant Plaza" all
 *     pass through verbatim. This is the typical case for the
 *     `DestinationName` field.
 *   - Input that is entirely uppercase (or has no letters at all)
 *     gets first-letter-of-each-word capitalisation — "SHADY
 *     GROVE" → "Shady Grove".
 *   - Word boundaries are whitespace only; in-word punctuation like
 *     `-` and `/` is preserved (so "WIEHLE-RESTON EAST" becomes
 *     "Wiehle-reston East" — the inner-token capitalisation is
 *     left to the caller / fixture data).
 *   - Empty or null-ish input returns "".
 */
export function toTitleCase(text: string): string {
  if (!text) return "";
  // Already has lowercase → trust the source casing and pass through.
  if (/[a-z]/.test(text)) return text;
  // A single all-caps token that's either short (≤3 chars) or
  // contains a hyphen reads as a status code or abbreviation
  // ("VN", "ARR", "T-BRD"). Preserve verbatim.
  if (!/\s/.test(text) && (text.length <= 3 || text.includes("-"))) {
    return text;
  }
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (token.length === 0 || /^\s+$/.test(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join("");
}

// Re-export ELLIPSIS so screens can match the rendering layer without a
// second import.
export { ELLIPSIS };
