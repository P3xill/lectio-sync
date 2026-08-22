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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it("recovers from one transient malformed schedule response", async () => {
    const malformed = '<table class="s2skema"><tr><td data-date="2026-08-10"><a class="s2skemabrik">Loading</a></td></tr></table>';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(htmlResponse(malformed))
      .mockResolvedValueOnce(htmlResponse(scheduleHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(activityDetailHtml));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSync()).resolves.toMatchObject({ inserted: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(googleMock.listManaged).toHaveBeenCalledOnce();
    expect(googleMock.apply).toHaveBeenCalledOnce();
  });

  it("still fails closed when malformed schedule responses persist", async () => {
    const malformed = '<table class="s2skema"><tr><td data-date="2026-08-10"><a class="s2skemabrik">Broken</a></td></tr></table>';
    const fetchMock = vi.fn(async () => htmlResponse(malformed));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_UNEXPECTED_PAGE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(googleMock.listManaged).not.toHaveBeenCalled();
    expect(googleMock.apply).not.toHaveBeenCalled();
  });

  it("shares one in-flight sync across overlapping callers", async () => {
    const firstFetch = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockImplementation(async () => htmlResponse(emptyHtml));
    vi.stubGlobal("fetch", fetchMock);

    const first = runSync();
    const second = runSync();

    expect(second).toBe(first);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    firstFetch.resolve(htmlResponse(emptyHtml));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(googleMock.listManaged).toHaveBeenCalledOnce();
    expect(googleMock.apply).toHaveBeenCalledOnce();
    expect(browserMock.alarms.create).toHaveBeenCalledOnce();
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

  it("does not touch Google if an activity detail page is unrecognized", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(htmlResponse(scheduleHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse(emptyHtml))
      .mockResolvedValueOnce(htmlResponse("<html><body>Maintenance</body></html>")));

    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_UNEXPECTED_PAGE" });
    expect(googleMock.listManaged).not.toHaveBeenCalled();
    expect(googleMock.apply).not.toHaveBeenCalled();
  });

  it("rejects an oversized Lectio page before calendar access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("A".repeat(2_000_001))));
    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_UNEXPECTED_PAGE" });
    expect(googleMock.listManaged).not.toHaveBeenCalled();
    expect(googleMock.apply).not.toHaveBeenCalled();
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

  it("reports that a failed Google apply may have committed earlier operations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.apply.mockRejectedValueOnce(new GoogleApiError(500, "later operation failed"));

    await expect(runSync()).rejects.toMatchObject({
      code: "GOOGLE_API",
      calendarMayHaveChanged: true,
      message: expect.stringContaining("Some changes may have been applied"),
      technicalDetail: "later operation failed"
    });
    expect(storageMock.state?.lastError).toMatchObject({ calendarMayHaveChanged: true });
    expect(storageMock.state?.sourceSnapshots).toEqual({});
  });

  it("reports possible calendar changes when persistence fails after apply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    storageMock.patchState
      .mockImplementationOnce(async (patch: Partial<ExtensionState>) => {
        storageMock.state = { ...storageMock.state!, ...patch };
        return storageMock.state;
      })
      .mockRejectedValueOnce(new Error("storage unavailable after apply"));

    await expect(runSync()).rejects.toMatchObject({
      code: "UNKNOWN",
      calendarMayHaveChanged: true,
      message: expect.stringContaining("Some changes may have been applied"),
      technicalDetail: expect.stringContaining("storage unavailable after apply")
    });
    expect(googleMock.apply).toHaveBeenCalledOnce();
    expect(storageMock.state?.lastError).toMatchObject({ calendarMayHaveChanged: true });
    expect(storageMock.state?.lastError?.message).not.toContain("before changing your calendar");
  });

  it("reports possible calendar changes when alarm scheduling fails after apply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    browserMock.alarms.create.mockRejectedValueOnce(new Error("alarm unavailable after apply"));

    await expect(runSync()).rejects.toMatchObject({
      code: "UNKNOWN",
      calendarMayHaveChanged: true,
      message: expect.stringContaining("Some changes may have been applied"),
      technicalDetail: expect.stringContaining("alarm unavailable after apply")
    });
    expect(googleMock.apply).toHaveBeenCalledOnce();
    expect(storageMock.state?.lastError).toMatchObject({ calendarMayHaveChanged: true });
    expect(storageMock.state?.lastError?.message).not.toContain("before changing your calendar");
  });

  it("abandons stale work before apply when the connected account changes", async () => {
    const managed = deferred<never[]>();
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.listManaged.mockReturnValueOnce(managed.promise);

    const sync = runSync();
    await vi.waitFor(() => expect(googleMock.listManaged).toHaveBeenCalledOnce());
    const switched = state({
      status: "ready",
      lectioAccount: {
        schoolId: "99",
        studentId: "100",
        connectedAt: "2026-08-07T00:00:00Z"
      },
      sourceSnapshots: {
        fresh: { fingerprint: "fresh", missingStreak: 0, lastSeenAt: "2026-08-07T00:00:00Z" }
      }
    });
    storageMock.state = switched;
    managed.resolve([]);

    await expect(sync).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("before calendar updates began")
    });
    expect(googleMock.apply).not.toHaveBeenCalled();
    expect(storageMock.state).toBe(switched);
    expect(storageMock.state?.lastError).toBeUndefined();
  });

  it("does not overwrite a newly selected calendar when identity changes during apply", async () => {
    const applied = deferred<{
      inserted: number;
      updated: number;
      deleted: number;
      unchanged: number;
      fetched: number;
      completedAt: string;
    }>();
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.apply.mockReturnValueOnce(applied.promise);

    const sync = runSync();
    await vi.waitFor(() => expect(googleMock.apply).toHaveBeenCalledOnce());
    const switched = state({
      status: "ready",
      googleCalendarId: "new-calendar",
      googleCalendarName: "New Lectio Calendar",
      sourceSnapshots: {
        fresh: { fingerprint: "fresh", missingStreak: 0, lastSeenAt: "2026-08-07T00:00:00Z" }
      }
    });
    storageMock.state = switched;
    applied.resolve({
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      fetched: 0,
      completedAt: "2026-08-07T12:00:00Z"
    });

    await expect(sync).rejects.toMatchObject({
      code: "UNKNOWN",
      calendarMayHaveChanged: true,
      message: expect.stringContaining("previous calendar may have been updated")
    });
    expect(storageMock.state).toBe(switched);
    expect(storageMock.state?.lastError).toBeUndefined();
    expect(browserMock.alarms.create).not.toHaveBeenCalled();
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

    storageMock.state!.settings.intervalMinutes = 37;
    await scheduleNextSync(storageMock.state);
    expect(browserMock.alarms.clear).toHaveBeenCalledWith("lectio-sync-periodic");
    expect(browserMock.alarms.create).toHaveBeenCalledWith("lectio-sync-periodic", { periodInMinutes: 37 });
  });

  it("recreates a deleted calendar and continues the sync with its replacement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.ensureConnected.mockResolvedValueOnce({ calendarId: "replacement-calendar", calendarName: "Lectio" });

    await expect(runSync()).resolves.toMatchObject({ inserted: 1 });

    expect(googleMock.ensureConnected).toHaveBeenCalledWith(false, "calendar");
    expect(googleMock.listManaged).toHaveBeenCalledWith("replacement-calendar", expect.any(Object));
    expect(googleMock.apply).toHaveBeenCalledWith("replacement-calendar", expect.any(Array));
    expect(storageMock.state).toMatchObject({
      googleCalendarId: "replacement-calendar",
      googleCalendarName: "Lectio",
      status: "healthy"
    });
  });

  it("recreates a deleted calendar when Google only reports it while listing events", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(emptyHtml)));
    googleMock.ensureConnected
      .mockResolvedValueOnce({ calendarId: "calendar", calendarName: "Lectio" })
      .mockResolvedValueOnce({ calendarId: "replacement-calendar", calendarName: "Lectio" });
    googleMock.listManaged
      .mockRejectedValueOnce(new GoogleApiError(410, "Resource has been deleted"))
      .mockResolvedValueOnce([]);

    await expect(runSync()).resolves.toMatchObject({ inserted: 1 });

    expect(googleMock.ensureConnected).toHaveBeenNthCalledWith(1, false, "calendar");
    expect(googleMock.ensureConnected).toHaveBeenNthCalledWith(2, false, undefined);
    expect(googleMock.listManaged).toHaveBeenLastCalledWith("replacement-calendar", expect.any(Object));
    expect(googleMock.apply).toHaveBeenCalledWith("replacement-calendar", expect.any(Array));
    expect(storageMock.state).toMatchObject({
      googleCalendarId: "replacement-calendar",
      googleCalendarName: "Lectio",
      status: "healthy"
    });
  });

  it("requires both connections before fetching", async () => {
    storageMock.state = state({ lectioAccount: undefined });
    await expect(runSync()).rejects.toMatchObject({ code: "LECTIO_AUTH_REQUIRED" });
    storageMock.state = state({ googleCalendarId: undefined });
    await expect(runSync()).rejects.toMatchObject({ code: "GOOGLE_AUTH_REQUIRED" });
  });
});
