import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, type ExtensionState } from "../src/core/types";

const browserMock = vi.hoisted(() => ({
  alarms: {
    clear: vi.fn(async () => true),
    create: vi.fn(async () => undefined)
  },
  notifications: {
    create: vi.fn(async () => "notification")
  },
  runtime: { getURL: vi.fn((path: string) => `extension://${path}`) }
}));

const storageMock = vi.hoisted(() => ({
  state: undefined as ExtensionState | undefined,
  getState: vi.fn(async () => storageMock.state!),
  patchState: vi.fn(async (patch: Partial<ExtensionState>) => {
    storageMock.state = { ...storageMock.state!, ...patch };
    return storageMock.state;
  })
}));

const googleMock = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  listManaged: vi.fn(),
  apply: vi.fn(),
  disconnect: vi.fn()
}));

vi.mock("webextension-polyfill", () => ({ default: browserMock }));
vi.mock("../src/core/storage", () => ({
  getState: storageMock.getState,
  patchState: storageMock.patchState
}));
vi.mock("../src/core/google-calendar", () => {
  class GoogleApiError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
      this.name = "GoogleApiError";
    }
  }
  return {
    GoogleApiError,
    GoogleCalendarAdapter: class {
      ensureConnected = googleMock.ensureConnected;
      listManaged = googleMock.listManaged;
      apply = googleMock.apply;
      disconnect = googleMock.disconnect;
    }
  };
});
vi.mock("../src/core/safari-calendar", () => ({ SafariCalendarAdapter: class {} }));

import { GoogleApiError } from "../src/core/google-calendar";
import { connectCalendar, runSync, scheduleNextSync } from "../src/core/sync-engine";

let scheduleHtml: string;
let emptyHtml: string;
let loginHtml: string;
let activityDetailHtml: string;

function state(overrides: Partial<ExtensionState> = {}): ExtensionState {
  return {
    ...DEFAULT_STATE,
    settings: { ...DEFAULT_STATE.settings, horizonWeeks: 2 },
    lectioAccount: { schoolId: "23", studentId: "42", connectedAt: "2026-08-01T00:00:00Z" },
    googleCalendarId: "calendar",
    googleCalendarName: "Lectio",
    ...overrides
  };
}

function htmlResponse(html: string, status = 200): Response {
  const response = new Response(html, { status, headers: { "Content-Type": "text/html" } });
  Object.defineProperty(response, "url", {
    value: "https://www.lectio.dk/lectio/23/SkemaNy.aspx?type=elev&elevid=42"
  });
  return response;
}

describe("sync engine", () => {
  beforeAll(async () => {
    [scheduleHtml, emptyHtml, loginHtml, activityDetailHtml] = await Promise.all([
      readFile("tests/fixtures/schedule.html", "utf8"),
      readFile("tests/fixtures/empty-schedule.html", "utf8"),
      readFile("tests/fixtures/login.html", "utf8"),
      readFile("tests/fixtures/activity-detail.html", "utf8")
    ]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    storageMock.state = state();
    googleMock.ensureConnected.mockResolvedValue({ calendarId: "calendar", calendarName: "Lectio" });
    googleMock.listManaged.mockResolvedValue([]);
    googleMock.apply.mockResolvedValue({
      inserted: 1, updated: 0, deleted: 0, unchanged: 0, fetched: 1, completedAt: "2026-08-07T12:00:00Z"
    });
  });

  it("parses every requested page before applying calendar changes", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(htmlResponse(scheduleHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(activityDetailHtml)));

    await expect(runSync()).resolves.toMatchObject({ inserted: 1 });
    expect(googleMock.listManaged).toHaveBeenCalledOnce();
    const operations = googleMock.apply.mock.calls[0]![1];
    expect(operations).toHaveLength(3);
    expect(operations[0]).toMatchObject({
      kind: "insert",
      event: {
        summary: "Oldtidskundskab – Hvad er det?",
        description: expect.stringContaining("Kære 3x så er det blevet tid old!")
      }
    });
    expect(storageMock.state).toMatchObject({ status: "healthy", rotationCursor: 0 });
    expect(browserMock.alarms.create).toHaveBeenCalledWith("lectio-sync-periodic", { periodInMinutes: 10 });
    expect(browserMock.notifications.create).not.toHaveBeenCalled();
  });

  it("notifies once when a previously synced module becomes cancelled", async () => {
    storageMock.state = state({
      lastSuccessAt: "2026-08-01T00:00:00Z",
      sourceSnapshots: {
        "aftaleid:2002": {
          fingerprint: "previous-confirmed-version",
          missingStreak: 0,
          lastSeenAt: "2026-08-01T00:00:00Z",
          lectioStatus: "confirmed"
        }
      }
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(htmlResponse(scheduleHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(activityDetailHtml)));

    await runSync();

    expect(browserMock.notifications.create).toHaveBeenCalledOnce();
    expect(browserMock.notifications.create).toHaveBeenCalledWith(
      expect.stringMatching(/^lectio-cancelled-/),
      expect.objectContaining({
        title: "Module cancelled",
        message: expect.stringContaining("English")
      })
    );
    expect(storageMock.state?.sourceSnapshots["aftaleid:2002"]?.lectioStatus).toBe("cancelled");
  });

  it("does no calendar reads or writes when Lectio redirects to login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(loginHtml)));
    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_AUTH_REQUIRED" });
    expect(googleMock.listManaged).not.toHaveBeenCalled();
    expect(googleMock.apply).not.toHaveBeenCalled();
    expect(storageMock.state).toMatchObject({ status: "lectio_expired" });
    expect(browserMock.notifications.create).toHaveBeenCalled();
  });

  it("pauses safely on a network error without touching Google", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline with private detail"); }));
    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_NETWORK", message: "Lectio could not be reached." });
    expect(googleMock.apply).not.toHaveBeenCalled();
    expect(storageMock.state).toMatchObject({ status: "safe_error", nextSyncAt: undefined });
  });

  it("does not touch Google if an activity detail page requires login", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(htmlResponse(scheduleHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(loginHtml)));

    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_AUTH_REQUIRED" });
    expect(googleMock.listManaged).not.toHaveBeenCalled();
    expect(googleMock.apply).not.toHaveBeenCalled();
  });

  it("falls back to schedule data if an activity detail page is unrecognized", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(htmlResponse(scheduleHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse("<html><body>Maintenance</body></html>")));

    await expect(runSync()).resolves.toMatchObject({ inserted: 1 });
    expect(googleMock.listManaged).toHaveBeenCalledOnce();
    expect(googleMock.apply.mock.calls[0]![1][0]).toMatchObject({
      kind: "insert",
      event: { summary: "3x Mathematics" }
    });
  });

  it("classifies a rejected Google token and leaves snapshots unchanged", async () => {
    storageMock.state = state({ sourceSnapshots: {
      keep: { fingerprint: "old", missingStreak: 0, lastSeenAt: "2026-08-01T00:00:00Z" }
    } });
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.listManaged.mockRejectedValueOnce(new GoogleApiError(401, "expired token"));
    await expect(runSync()).rejects.toMatchObject({ code: "GOOGLE_AUTH_REQUIRED" });
    expect(googleMock.apply).not.toHaveBeenCalled();
    expect(storageMock.state).toMatchObject({
      status: "google_disconnected",
      sourceSnapshots: { keep: { fingerprint: "old" } }
    });
  });

  it("checks disjoint week windows and deduplicates provider events", async () => {
    storageMock.state = state({
      lastSuccessAt: "2026-08-01T00:00:00Z",
      rotationCursor: 1,
      settings: { ...DEFAULT_STATE.settings, horizonWeeks: 8 }
    });
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.listManaged.mockResolvedValue([
      { id: "provider-id", sourceId: "old", fingerprint: "same" }
    ]);

    await runSync();
    expect(googleMock.listManaged).toHaveBeenCalledTimes(2);
    expect(googleMock.apply.mock.calls[0]![1]).toHaveLength(1);
    expect(storageMock.state?.rotationCursor).toBe(2);
  });

  it("connects the dedicated calendar and schedules the chosen interval", async () => {
    storageMock.state = state({ googleCalendarId: undefined, googleCalendarName: undefined, status: "not_configured" });
    googleMock.ensureConnected.mockResolvedValueOnce({ calendarId: "new", calendarName: "Lectio" });
    await expect(connectCalendar(true)).resolves.toMatchObject({ googleCalendarId: "new", status: "ready" });
    expect(googleMock.ensureConnected).toHaveBeenCalledWith(true, undefined);

    storageMock.state!.settings.intervalMinutes = 5;
    await scheduleNextSync(storageMock.state);
    expect(browserMock.alarms.clear).toHaveBeenCalledWith("lectio-sync-periodic");
    expect(browserMock.alarms.create).toHaveBeenCalledWith("lectio-sync-periodic", { periodInMinutes: 5 });
  });

  it("requires both connections before fetching", async () => {
    storageMock.state = state({ lectioAccount: undefined });
    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_AUTH_REQUIRED" });
    storageMock.state = state({ googleCalendarId: undefined });
    await expect(runSync()).rejects.toMatchObject({ code: "GOOGLE_AUTH_REQUIRED" });
  });
});
