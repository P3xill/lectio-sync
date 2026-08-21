import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({
  default: {
    storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
    identity: { getRedirectURL: vi.fn(), launchWebAuthFlow: vi.fn() }
  }
}));

import { GoogleApiError, GoogleCalendarAdapter, isValidGoogleOAuthClientId } from "../src/core/google-calendar";
import type { CalendarEventInput } from "../src/core/types";

const getAuthToken = vi.fn(async (): Promise<{ token?: string } | string> => ({ token: "token" }));
const removeCachedAuthToken = vi.fn(async () => undefined);
const clearAllCachedAuthTokens = vi.fn(async () => undefined);
const getManifest = vi.fn(() => ({
  oauth2: { client_id: "123456789012-unit-fixture.apps.googleusercontent.com" }
}));

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
    vi.stubGlobal("chrome", {
      identity: { getAuthToken, removeCachedAuthToken, clearAllCachedAuthTokens },
      runtime: { getManifest }
    });
  });

  it("rejects placeholder OAuth clients before opening Google", async () => {
    expect(isValidGoogleOAuthClientId("123456789012-real-client.apps.googleusercontent.com")).toBe(true);
    expect(isValidGoogleOAuthClientId("REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com")).toBe(false);
    getManifest.mockReturnValueOnce({
      oauth2: { client_id: "REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com" }
    });
    await expect(new GoogleCalendarAdapter().ensureConnected(true)).rejects.toMatchObject({
      code: "GOOGLE_AUTH_REQUIRED",
      status: 401
    });
    expect(getAuthToken).not.toHaveBeenCalled();
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

  it("recreates a stored calendar when Google reports that it was deleted", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(410, { error: { errors: [{ reason: "deleted" }], message: "Resource has been deleted" } }))
      .mockResolvedValueOnce(response(200, { id: "replacement-calendar" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GoogleCalendarAdapter().ensureConnected(false, "deleted-calendar")).resolves.toEqual({
      calendarId: "replacement-calendar", calendarName: "Lectio"
    });
    expect(fetchCall(fetchMock, 1)[1].method).toBe("POST");
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

  it("paces independent calendar writes", async () => {
    vi.useFakeTimers();
    try {
      const writeTimes: number[] = [];
      vi.stubGlobal("fetch", vi.fn(async () => {
        writeTimes.push(Date.now());
        return response(200, {});
      }));

      const pending = new GoogleCalendarAdapter().apply("calendar", Array.from({ length: 4 }, (_, index) => ({
        kind: "insert" as const,
        event: { ...event, id: `stable-${index}`, sourceId: `absid:${index}` }
      })));
      await vi.runAllTimersAsync();
      await pending;

      expect(writeTimes).toHaveLength(4);
      expect(writeTimes[1]! - writeTimes[0]!).toBeGreaterThanOrEqual(150);
    } finally {
      vi.useRealTimers();
    }
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

  it("backs off and retries a temporary Calendar rate limit", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }))
        .mockResolvedValueOnce(response(200, { id: "existing" }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = new GoogleCalendarAdapter().ensureConnected(false, "existing");
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual({ calendarId: "existing", calendarName: "Lectio" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires Chrome identity and can disconnect", async () => {
    vi.stubGlobal("chrome", { identity: { clearAllCachedAuthTokens }, runtime: { getManifest } });
    await expect(new GoogleCalendarAdapter().ensureConnected(false)).rejects.toMatchObject({ status: 401 });
    await new GoogleCalendarAdapter().disconnect();
    expect(clearAllCachedAuthTokens).toHaveBeenCalled();
  });

  it("rejects a missing token", async () => {
    getAuthToken.mockResolvedValueOnce({});
    await expect(new GoogleCalendarAdapter().ensureConnected(false)).rejects.toMatchObject({ status: 401 });
  });

  it("accepts Brave's legacy string token result", async () => {
    getAuthToken.mockResolvedValueOnce("brave-token");
    const fetchMock = vi.fn(async () => response(200, { id: "brave-calendar" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GoogleCalendarAdapter().ensureConnected(true)).resolves.toEqual({
      calendarId: "brave-calendar",
      calendarName: "Lectio"
    });
    expect(fetchCall(fetchMock, 0)[1].headers).toMatchObject({ Authorization: "Bearer brave-token" });
  });
});
