// Field-level formatters: WMATA wire values → glanceable HUD strings. Pure, no
// SDK/DOM. Where width matters, fit decisions use pixel measurement
// (`./measure`), never character counts.

import { truncateToPx } from "./measure";

/**
 * Format a soonest-train `Min` token for the value column:
 *   null / "" / "---" → ""        (no value — blank cell, kept aligned)
 *   "ARR" / "BRD"     → verbatim
 *   numeric           → "N min"
 */
export function formatEtaValue(min: string | null): string {
  if (min === null || min === "" || min === "---") return "";
  if (min === "ARR" || min === "BRD") return min;
  if (/^\d+$/.test(min)) return `${min} min`;
  return "";
}

/** 12-hour wall clock, e.g. "2:32p" / "12:05a". Invalid input → "--:--". */
export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "--:--";
  const d = new Date(epochMs);
  const h24 = d.getHours();
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${h12}:${mm}${h24 < 12 ? "a" : "p"}`;
}

/** 2-char line code, or `--` for unknown/non-revenue. */
export function lineGlyph(line: string): string {
  return new Set(["RD", "BL", "YL", "OR", "GR", "SV"]).has(line) ? line : "--";
}

/** Spelled-out line name (`RD` → `RED`); unknown codes pass through. */
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

/** Hand-tuned short forms for stations whose names overflow tight columns. */
export const STATION_ABBREVIATIONS: Record<string, string> = {
  "L'Enfant Plaza": "L'Enfant",
  "Largo Town Center": "Largo TC",
  "Vienna/Fairfax-GMU": "Vienna",
  "West Falls Church-VT/UVA": "W Falls Ch",
  "East Falls Church": "E Falls Ch",
  "Franconia-Springfield": "Franconia",
  "New Carrollton": "New Carrollton",
  "Gallery Pl-Chinatown": "Gallery Pl",
  "Mt Vernon Sq 7th St-Convention Center": "Mt Vernon Sq",
  "U Street/African-Amer Civil War Memorial/Cardozo": "U Street",
  "Foggy Bottom-GWU": "Foggy Bottom",
  "Federal Triangle": "Fed Triangle",
  "Federal Center SW": "Fed Center SW",
  "Eastern Market": "Eastern Mkt",
  "Metro Center": "Metro Center",
  "Union Station": "Union Stn",
  "Rhode Island Ave-Brentwood": "Rhode Island",
  "Fort Totten": "Fort Totten",
  "Silver Spring": "Silver Spring",
  "Shady Grove": "Shady Grove",
  "Grosvenor-Strathmore": "Grosvenor",
  "Medical Center": "Medical Ctr",
  "Friendship Heights": "Friendship Hts",
  "Tenleytown-AU": "Tenleytown",
  "Van Ness-UDC": "Van Ness",
  "Woodley Park-Zoo/Adams Morgan": "Woodley Park",
  "Wiehle-Reston East": "Wiehle-Reston",
  "Tysons Corner": "Tysons",
  "Court House": "Court House",
  "Virginia Sq-GMU": "Virginia Sq",
  "Ballston-MU": "Ballston",
  "Arlington Cemetery": "Arlington Cem",
  "Pentagon City": "Pentagon City",
  "Crystal City": "Crystal City",
  "Ronald Reagan Washington National Airport": "Reagan Airport",
  "King St-Old Town": "King St",
  "Eisenhower Ave": "Eisenhower",
  "Van Dorn St": "Van Dorn",
  "Naylor Rd": "Naylor Rd",
  "Southern Ave": "Southern Ave",
  "Congress Heights": "Congress Hts",
  "Navy Yard-Ballpark": "Navy Yard",
  "Archives-Navy Memorial-Penn Quarter": "Archives",
  "Minnesota Ave": "Minnesota",
  "Capitol Heights": "Capitol Hts",
  "Addison Rd-Seat Pleasant": "Addison Rd",
  "Morgan Boulevard": "Morgan Blvd",
  "College Park-U of Md": "College Park",
  "Prince George's Plaza": "Prince George's",
  "West Hyattsville": "W Hyattsville",
  "NoMa-Gallaudet U": "NoMa",
  "Shaw-Howard U": "Shaw-Howard",
  "Columbia Heights": "Columbia Hts",
  "Georgia Ave-Petworth": "Georgia Ave",
};

/**
 * Fit a station name into a pixel budget: return it if it fits; else the
 * hand-tuned short form if THAT fits; else a pixel-truncated form (preferring
 * the short form as the truncation source — less information lost).
 */
export function abbreviateStation(name: string, maxPx: number): string {
  if (!name || maxPx <= 0) return "";
  if (truncateToPx(name, maxPx) === name) return name; // fits whole
  const abbr = STATION_ABBREVIATIONS[name];
  if (abbr && truncateToPx(abbr, maxPx) === abbr) return abbr; // short form fits
  return truncateToPx(abbr ?? name, maxPx);
}

/** Title-case a strict-uppercase string ("SHADY GROVE" → "Shady Grove"); pass
 *  through anything already mixed-case, and short codes/hyphenated tokens. */
export function toTitleCase(text: string): string {
  if (!text) return "";
  if (/[a-z]/.test(text)) return text;
  if (!/\s/.test(text) && (text.length <= 3 || text.includes("-"))) return text;
  return text
    .split(/(\s+)/)
    .map((tok) => (tok.length === 0 || /^\s+$/.test(tok) ? tok : tok[0]!.toUpperCase() + tok.slice(1).toLowerCase()))
    .join("");
}
