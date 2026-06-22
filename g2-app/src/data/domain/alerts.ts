// Folds rail incidents + elevator/escalator outages into one flat alert list
// (rail first, then access). Each item has a short headline for the list row
// and a full detail body for the paged detail view. Pure.

import type { RailIncident, ElevatorIncident } from "../wmata";
import { parseLinesAffected } from "../wmata";

export type AlertKind = "rail" | "access";

export interface AlertItem {
  kind: AlertKind;
  /** Short one-line summary for the list row. */
  headline: string;
  /** Full text for the paged detail view. */
  detail: string;
  /** Short screen title for the detail view. */
  title: string;
}

/** First sentence of a description (up to the first period), trimmed. */
function firstSentence(s: string): string {
  const i = s.indexOf(".");
  return (i > 0 ? s.slice(0, i) : s).trim();
}

/** Station name without an entrance suffix ("Dupont Circle, Q St Entrance" → "Dupont Circle"). */
export function stationNameOnly(fullName: string): string {
  const i = fullName.indexOf(",");
  return (i > 0 ? fullName.slice(0, i) : fullName).trim();
}

export function buildAlertItems(
  incidents: readonly RailIncident[],
  outages: readonly ElevatorIncident[],
): AlertItem[] {
  const items: AlertItem[] = [];

  for (const inc of incidents) {
    const lines = parseLinesAffected(inc.LinesAffected ?? "");
    const tag = lines.length ? `${lines.join(" ")} · ` : "";
    const desc = (inc.Description ?? "").trim();
    items.push({
      kind: "rail",
      headline: tag + firstSentence(desc),
      detail: desc || "No description provided.",
      title: lines.length ? `Alert · ${lines.join(" ")}` : "Service alert",
    });
  }

  for (const o of outages) {
    const station = stationNameOnly(o.StationName);
    const type =
      o.UnitType === "ELEVATOR" ? "Elevator" : o.UnitType === "ESCALATOR" ? "Escalator" : "Unit";
    const loc = (o.LocationDescription ?? "").trim();
    const eta = o.EstimatedReturnToService ? ` Est. return: ${o.EstimatedReturnToService}.` : "";
    items.push({
      kind: "access",
      headline: `${type} out · ${station}`,
      detail: `${type} out of service at ${station}.${loc ? ` ${loc}.` : ""}${eta}`,
      title: `${station} access`,
    });
  }

  return items;
}
