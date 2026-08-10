import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({
  default: {
    storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
    identity: { getRedirectURL: vi.fn(), launchWebAuthFlow: vi.fn() }
  }
}));

import { GoogleApiError, GoogleCalendarAdapter } from "../src/core/google-calendar";
import type { CalendarEventInput } from "../src/core/types";

const getAuthToken = vi.fn(async (): Promise<{ token?: string }> => ({ token: "token" }));
const removeCachedAuthToken = vi.fn(async () => undefined);
const clearAllCachedAuthTokens = vi.fn(async () => undefined);

const event: CalendarEventInput = {
  id: "stable",
  sourceId: "absid:1",
  fingerprint: "new",
  lectioStatus: "confirmed",
  summary: "English",
  description: "",
  start: "2026-08-10T08:00:00",
  end: "2026-08-10T09:00:00",
  transparency: "opaque"
};

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" }
  });
}

function fetchCall(mock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] {
  return (mock.mock.calls as unknown as Array<[string, RequestInit]>)[index]!;
}

describe("GoogleCalendarAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getAuthToken.mockReset().mockResolvedValue({ token: "token" });
    removeCachedAuthToken.mockReset().mockResolvedValue(undefined);
    clearAllCachedAuthTokens.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { identity: { getAuthToken, removeCachedAuthToken, clearAllCachedAuthTokens } });
  });

  it("reuses a valid dedicated calendar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, { id: "existing" })));
    await expect(new GoogleCalendarAdapter().ensureConnected(false, "existing")).resolves.toEqual({
      calendarId: "existing", calendarName: "Lectio"
    });
  });

  it("creates a dedicated calendar when the stored one is gone", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, "missing"))
      .mockResolvedValueOnce(response(200, { id: "new-calendar" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GoogleCalendarAdapter().ensureConnected(true, "old-calendar")).resolves.toEqual({
      calendarId: "new-calendar", calendarName: "Lectio"
    });
    expect(JSON.parse(fetchCall(fetchMock, 1)[1].body as string)).toEqual({ summary: "Lectio", timeZone: "Europe/Copenhagen" });
  });

  it("lists only owned events across every result page", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(200, {
        items: [
          { id: "one", extendedProperties: { private: { sourceId: "a", fingerprint: "fa", lectioStatus: "confirmed" } } },
          { id: "foreign" }
        ],
        nextPageToken: "page-two"
      }))
      .mockResolvedValueOnce(response(200, {
        items: [{ id: "two", status: "cancelled", extendedProperties: { private: { sourceId: "b" } } }]
      })));
    const listed = await new GoogleCalendarAdapter().listManaged("calendar", { timeMin: "2026-08-01Z", timeMax: "2026-09-01Z" });
    expect(listed).toEqual([
      { id: "one", sourceId: "a", fingerprint: "fa", status: undefined, lectioStatus: "confirmed" },
      { id: "two", sourceId: "b", fingerprint: undefined, status: "cancelled", lectioStatus: undefined }
    ]);
  });

  it("applies inserts, updates, deletes, and noops with existing IDs", async () => {
    const fetchMock = vi.fn(async () => response(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const summary = await new GoogleCalendarAdapter().apply("calendar", [
      { kind: "noop", eventId: "no-change", sourceId: "a" },
      { kind: "insert", event },
      { kind: "update", event: { ...event, summary: "Moved" }, eventId: "provider-event-id" },
      { kind: "delete", eventId: "remove-me", sourceId: "c" }
    ]);
    expect(summary).toMatchObject({ inserted: 1, updated: 1, deleted: 1, unchanged: 1, fetched: 4 });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.some(([url, init]) => String(url).endsWith("/provider-event-id") && init.method === "PUT")).toBe(true);
  });

  it("turns an insert conflict into an update", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(409, "already exists"))
      .mockResolvedValueOnce(response(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GoogleCalendarAdapter().apply("calendar", [{ kind: "insert", event }])).resolves.toMatchObject({ updated: 1 });
    expect(fetchCall(fetchMock, 1)[1].method).toBe("PUT");
  });

  it("invalidates rejected OAuth tokens and returns a bounded API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(401, "x".repeat(800))));
    await expect(new GoogleCalendarAdapter().ensureConnected(false, "calendar")).rejects.toMatchObject({
      name: "GoogleApiError", status: 401
    });
    expect(removeCachedAuthToken).toHaveBeenCalledWith({ token: "token" });
    try {
      await new GoogleCalendarAdapter().ensureConnected(false, "calendar");
    } catch (error) {
      expect((error as GoogleApiError).message).toHaveLength(500);
    }
  });

  it("requires Chrome identity and can disconnect", async () => {
    vi.stubGlobal("chrome", { identity: { clearAllCachedAuthTokens } });
    await expect(new GoogleCalendarAdapter().ensureConnected(false)).rejects.toMatchObject({ status: 401 });
    await new GoogleCalendarAdapter().disconnect();
    expect(clearAllCachedAuthTokens).toHaveBeenCalled();
  });

  it("rejects a missing token", async () => {
    getAuthToken.mockResolvedValueOnce({});
    await expect(new GoogleCalendarAdapter().ensureConnected(false)).rejects.toMatchObject({ status: 401 });
  });
});
