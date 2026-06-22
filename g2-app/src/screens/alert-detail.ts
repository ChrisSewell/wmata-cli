// Alert detail — the full text of one incident/outage, paginated to fill the
// body. Reached by pressing a row on the Alerts screen. Pages are pre-split
// (pure) at construction so page bounds are known; swipe flips pages, press
// returns to Alerts.

import { paginateBody } from "../ui/layout";
import { HINTS } from "../nav/affordances";
import type { Layout, NavState, ReduceResult, Screen } from "./router";

export interface AlertDetailSnapshot {
  title: string;
  pages: string[];
  pageIndex: number;
}

export function makeAlertDetailScreen(item: { title: string; detail: string }): Screen<AlertDetailSnapshot> {
  const pages = paginateBody(item.detail);
  return {
    name: "alertDetail",
    mode: "text",
    init: () => ({ title: item.title, pages, pageIndex: 0 }),
    view(s: AlertDetailSnapshot, _nav: NavState): Layout {
      const multi = s.pages.length > 1;
      return {
        header: { title: s.title, marker: multi ? `${s.pageIndex + 1}/${s.pages.length}` : undefined },
        body: { kind: "paged", pages: s.pages, pageIndex: s.pageIndex },
        hints: multi ? [HINTS.page, HINTS.back] : [HINTS.back],
      };
    },
    reduce(s: AlertDetailSnapshot, nav: NavState, event): ReduceResult<AlertDetailSnapshot> {
      switch (event.type) {
        case "SCROLL_DOWN":
          return { nav, snapshot: { ...s, pageIndex: Math.min(s.pages.length - 1, s.pageIndex + 1) } };
        case "SCROLL_UP":
          return { nav, snapshot: { ...s, pageIndex: Math.max(0, s.pageIndex - 1) } };
        case "TAP":
        case "DOUBLE_TAP":
          return { nav, navigate: { to: "alerts" } };
      }
    },
  };
}
