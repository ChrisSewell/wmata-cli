// Field-level formatters that turn WMATA wire values into glanceable
// strings for the G2 HUD. Pure functions; no SDK, no I/O.
//
// These are the TypeScript counterparts to wmata/utils/formatting.py
// `format_min` and similar helpers used by rail_predictions.py. The
// glasses surface has even tighter width constraints than the CLI, so
// `abbreviateStation` is also defined here.

import type { LineCode } from "../wmata";
import { ELLIPSIS, truncate } from "./render";

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
  "Federal Triangle": "Fed Triangle",
  "Federal Center SW": "Fed Center",
  "Capitol South": "Capitol S",
  "Eastern Market": "Eastern Mkt",
  "Stadium-Armory": "Stadium",
  Smithsonian: "Smithsonian",
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
  "Virginia Sq-GMU": "Virginia Sq",
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
  "Morgan Boulevard": "Morgan Blvd",
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
 * Abbreviate a station name to fit `maxLen` columns.
 *
 * Strategy:
 *   1. If the canonical name fits, return it unchanged.
 *   2. If the name has a hand-tuned abbreviation that fits, use it.
 *   3. Otherwise, truncate with an ellipsis.
 *
 * The map is consulted whether or not the canonical name fits, because
 * a known short form is almost always more readable than a truncated
 * long one (e.g., "Vienna" beats "Vienna/Fai…" at 11 cols).
 */
export function abbreviateStation(name: string, maxLen: number): string {
  if (!name) return "";
  if (maxLen <= 0) return "";
  const abbr = STATION_ABBREVIATIONS[name];
  // Prefer the canonical name when it already fits AND there's no
  // shorter abbrev that would be tidier. Practically: if the abbrev
  // fits, use it for names longer than maxLen; otherwise keep the full
  // name.
  if (name.length <= maxLen) return name;
  if (abbr && abbr.length <= maxLen) return abbr;
  // Fall back to truncation. If even the abbrev is too long, prefer
  // truncating the abbrev (shorter source = less information loss).
  const source = abbr ?? name;
  return source.length <= maxLen ? source : truncate(source, maxLen);
}

// Re-export ELLIPSIS so screens can match the rendering layer without a
// second import.
export { ELLIPSIS };
