import { describe, it, expect } from "vitest";
import { OsEventTypeList, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { eventToScreenEvent, lifecycleEvent } from "./glasses-host";

const ev = (e: unknown): EvenHubEvent => e as EvenHubEvent;

describe("eventToScreenEvent", () => {
  it("maps swipes (textEvent) to move", () => {
    expect(eventToScreenEvent(ev({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }))).toEqual({
      type: "SCROLL_UP",
    });
    expect(eventToScreenEvent(ev({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }))).toEqual({
      type: "SCROLL_DOWN",
    });
  });

  it("treats an undefined-type sysEvent as a single press (simulator click, protobuf zero-value)", () => {
    expect(eventToScreenEvent(ev({ sysEvent: {} }))).toEqual({ type: "TAP" });
  });

  it("maps double-press on either envelope", () => {
    expect(eventToScreenEvent(ev({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }))).toEqual({
      type: "DOUBLE_TAP",
    });
    expect(eventToScreenEvent(ev({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }))).toEqual({
      type: "DOUBLE_TAP",
    });
  });

  it("does not turn a lifecycle sysEvent into a gesture", () => {
    expect(eventToScreenEvent(ev({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } }))).toBeNull();
  });
});

describe("lifecycleEvent", () => {
  it("recognizes foreground enter/exit and the exit codes", () => {
    expect(lifecycleEvent(ev({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } }))).toBe("FOREGROUND_ENTER");
    expect(lifecycleEvent(ev({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } }))).toBe("FOREGROUND_EXIT");
    expect(lifecycleEvent(ev({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } }))).toBe("EXIT");
    expect(lifecycleEvent(ev({ sysEvent: { eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT } }))).toBe("EXIT");
  });
  it("returns null for a gesture / undefined", () => {
    expect(lifecycleEvent(ev({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } }))).toBeNull();
    expect(lifecycleEvent(ev({ sysEvent: {} }))).toBeNull();
  });
});
