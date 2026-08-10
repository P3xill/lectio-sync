import { beforeEach, describe, expect, it, vi } from "vitest";

const sendNativeMessage = vi.hoisted(() => vi.fn());
vi.mock("webextension-polyfill", () => ({
  default: { runtime: { sendNativeMessage } }
}));

import { SafariCalendarAdapter } from "../src/core/safari-calendar";

describe("SafariCalendarAdapter", () => {
  beforeEach(() => sendNativeMessage.mockReset());

  it("uses the native bridge for calendar lifecycle operations", async () => {
    sendNativeMessage
      .mockResolvedValueOnce({ ok: true, data: { calendarId: "calendar", calendarName: "Lectio" } })
      .mockResolvedValueOnce({ ok: true, data: [{ id: "event", sourceId: "source" }] })
      .mockResolvedValueOnce({ ok: true, data: { inserted: 0, updated: 0, deleted: 0, unchanged: 1, fetched: 1, completedAt: "now" } })
      .mockResolvedValueOnce({ ok: true, data: true });
    const adapter = new SafariCalendarAdapter();

    await expect(adapter.ensureConnected(true, "old")).resolves.toEqual({ calendarId: "calendar", calendarName: "Lectio" });
    await expect(adapter.listManaged("calendar", { timeMin: "a", timeMax: "b" })).resolves.toHaveLength(1);
    await expect(adapter.apply("calendar", [{ kind: "noop", eventId: "event", sourceId: "source" }])).resolves.toMatchObject({ unchanged: 1 });
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(sendNativeMessage).toHaveBeenNthCalledWith(1, "dk.lectiosync.extension", {
      type: "ENSURE_CALENDAR", interactive: true, currentCalendarId: "old"
    });
  });

  it("surfaces sanitized native bridge failures", async () => {
    sendNativeMessage.mockResolvedValueOnce({ ok: false, error: "Calendar permission denied" });
    await expect(new SafariCalendarAdapter().ensureConnected(false)).rejects.toThrow("Calendar permission denied");
  });

  it("handles an unavailable bridge without exposing internals", async () => {
    sendNativeMessage.mockResolvedValueOnce(undefined);
    await expect(new SafariCalendarAdapter().ensureConnected(false)).rejects.toThrow("calendar bridge is unavailable");
  });
});
