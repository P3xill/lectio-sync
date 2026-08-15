import { beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  get: vi.fn(async (key: string) => ({ [key]: local.values[key] })),
  set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(local.values, value); }),
  remove: vi.fn(async (key: string) => { delete local.values[key]; })
}));

vi.mock("webextension-polyfill", () => ({
  default: { storage: { local } }
}));

import { clearState, getState, patchState, setState } from "../src/core/storage";
import { getFetchWeekOffsets } from "../src/core/date";
import { DEFAULT_STATE } from "../src/core/types";

describe("state storage", () => {
  beforeEach(() => {
    local.values = {};
    vi.clearAllMocks();
  });

  it("returns independent defaults for a new installation", async () => {
    expect(await getState()).toEqual(DEFAULT_STATE);
  });

  it("migrates partial state and nested settings safely", async () => {
    local.values.lectioSyncStateV1 = {
      status: "healthy",
      settings: { intervalMinutes: 5 },
      rotationCursor: 3
    };
    const state = await getState();
    expect(state.settings).toMatchObject({
      intervalMinutes: 5,
      horizonWeeks: 8,
      includeTitle: true,
      includeDescription: true,
      includeClass: true
    });
    expect(state.sourceSnapshots).toEqual({});
    expect(state.rotationCursor).toBe(3);
  });

  it("repairs an out-of-range stored check interval", async () => {
    local.values.lectioSyncStateV1 = { settings: { intervalMinutes: 1 } };
    expect((await getState()).settings.intervalMinutes).toBe(10);
  });

  it.each([null, 42, "invalid", [], true])("falls back safely for a non-state value: %j", async (value) => {
    local.values.lectioSyncStateV1 = value;
    expect(await getState()).toEqual(DEFAULT_STATE);
  });

  it("sanitizes malformed persisted state while retaining valid legacy fields", async () => {
    const validTimestamp = "2026-08-01T00:00:00.000Z";
    local.values.lectioSyncStateV1 = {
      status: "corrupt",
      rotationCursor: -1,
      lectioAccount: {
        schoolId: "23",
        studentId: "42",
        schoolName: `  ${"A".repeat(140)}  `,
        connectedAt: "2026-02-31T00:00:00.000Z"
      },
      googleCalendarId: "   ",
      googleCalendarName: "Lectio",
      lastAttemptAt: "0",
      lastSuccessAt: validTimestamp,
      nextSyncAt: "2026-02-31T00:00:00.000Z",
      lastError: {
        code: "ATTACKER_CODE",
        message: "x".repeat(800),
        occurredAt: "not-a-date",
        technicalDetail: "y".repeat(800),
        calendarMayHaveChanged: "yes"
      },
      settings: {
        intervalMinutes: "5",
        horizonWeeks: 99,
        cancellationMode: "delete",
        includeHomework: true,
        includeTitle: false,
        includeDescription: 1,
        includeClass: false,
        includeTeacher: "false"
      },
      sourceSnapshots: Object.fromEntries([
        ["absid:1", {
          fingerprint: "valid-fingerprint",
          missingStreak: 99,
          lastSeenAt: validTimestamp,
          lectioStatus: "invalid"
        }],
        ["absid:2", { missingStreak: 0, lastSeenAt: validTimestamp }],
        ["absid:4", { fingerprint: "x".repeat(129), missingStreak: 0, lastSeenAt: validTimestamp }],
        ["bad source 🚨", { fingerprint: "bad", missingStreak: 0, lastSeenAt: validTimestamp }],
        ["aftaleid:3", { fingerprint: "bad-date", missingStreak: 0, lastSeenAt: "recently" }],
        ["__proto__", { fingerprint: "prototype", missingStreak: 0, lastSeenAt: validTimestamp }]
      ])
    };

    const state = await getState();
    expect(state).toMatchObject({
      status: "not_configured",
      rotationCursor: 0,
      lectioAccount: {
        schoolId: "23",
        studentId: "42",
        connectedAt: validTimestamp
      },
      lastSuccessAt: validTimestamp,
      settings: {
        intervalMinutes: 10,
        horizonWeeks: 8,
        cancellationMode: "mark",
        includeHomework: true,
        includeTitle: false,
        includeDescription: true,
        includeClass: false,
        includeTeacher: true
      },
      sourceSnapshots: {
        "absid:1": {
          fingerprint: "valid-fingerprint",
          missingStreak: 0,
          lastSeenAt: validTimestamp
        }
      },
      lastError: {
        code: "UNKNOWN",
        occurredAt: validTimestamp
      }
    });
    expect(state.lectioAccount?.schoolName).toHaveLength(120);
    expect(state.googleCalendarId).toBeUndefined();
    expect(state.googleCalendarName).toBeUndefined();
    expect(state.lastAttemptAt).toBeUndefined();
    expect(state.nextSyncAt).toBeUndefined();
    expect(state.lastError?.message).toHaveLength(500);
    expect(state.lastError?.technicalDetail).toHaveLength(500);
    expect(state.lastError?.calendarMayHaveChanged).toBeUndefined();
    expect(state.sourceSnapshots["absid:1"]?.lectioStatus).toBeUndefined();
  });

  it("drops invalid account identifiers and normalizes unsafe rotation state", async () => {
    local.values.lectioSyncStateV1 = {
      status: "healthy",
      rotationCursor: Number.MAX_SAFE_INTEGER,
      lectioAccount: {
        schoolId: "23",
        studentId: "not-numeric",
        connectedAt: "2026-08-01T00:00:00.000Z"
      }
    };

    const state = await getState();
    expect(state.lectioAccount).toBeUndefined();
    expect(state.rotationCursor).toBe(0);
    expect(getFetchWeekOffsets(false, 8, state.rotationCursor)).toEqual([0, 1, 2, 3]);
  });

  it("sanitizes state supplied through the typed persistence boundary", async () => {
    await setState({
      ...DEFAULT_STATE,
      rotationCursor: -4,
      settings: {
        ...DEFAULT_STATE.settings,
        horizonWeeks: 1,
        cancellationMode: "invalid"
      },
      sourceSnapshots: []
    } as unknown as typeof DEFAULT_STATE);

    const stored = local.values.lectioSyncStateV1 as typeof DEFAULT_STATE;
    expect(stored.rotationCursor).toBe(0);
    expect(stored.settings.horizonWeeks).toBe(8);
    expect(stored.settings.cancellationMode).toBe("mark");
    expect(stored.sourceSnapshots).toEqual({});
  });

  it("round-trips a complete valid state without changing its values", async () => {
    const complete = {
      ...DEFAULT_STATE,
      status: "healthy" as const,
      rotationCursor: 7,
      lectioAccount: {
        schoolId: "23",
        studentId: "42",
        schoolName: "Test Gymnasium",
        connectedAt: "2026-08-01T00:00:00.000Z"
      },
      googleCalendarId: "calendar-id@group.calendar.google.com",
      googleCalendarName: "Lectio",
      lastAttemptAt: "2026-08-01T00:01:00.000Z",
      lastSuccessAt: "2026-08-01T00:01:00.000Z",
      nextSyncAt: "2026-08-01T00:11:00.000Z",
      lastError: {
        code: "GOOGLE_API" as const,
        message: "Temporary failure",
        occurredAt: "2026-08-01T00:00:30.000Z",
        technicalDetail: "Rate limited",
        calendarMayHaveChanged: false
      },
      settings: {
        ...DEFAULT_STATE.settings,
        intervalMinutes: 37,
        horizonWeeks: 12,
        cancellationMode: "remove" as const,
        includeHomework: true,
        includeTitle: false
      },
      sourceSnapshots: {
        "aftaleid:9": {
          fingerprint: "fingerprint",
          missingStreak: 1,
          lastSeenAt: "2026-08-01T00:00:00.000Z",
          lectioStatus: "changed" as const
        }
      }
    };

    await setState(complete);
    expect(await getState()).toEqual(complete);
  });

  it("patches nested settings without dropping other fields", async () => {
    await setState({ ...DEFAULT_STATE, status: "ready" });
    const next = await patchState({ settings: { ...DEFAULT_STATE.settings, intervalMinutes: 37 } });
    expect(next.status).toBe("ready");
    expect(next.settings.intervalMinutes).toBe(37);
    expect(local.set).toHaveBeenCalled();
  });

  it("patches top-level state without replacing settings or snapshots", async () => {
    const sourceSnapshots = {
      "absid:1": {
        fingerprint: "fingerprint",
        missingStreak: 0,
        lastSeenAt: "2026-08-01T00:00:00.000Z"
      }
    };
    await setState({ ...DEFAULT_STATE, sourceSnapshots });
    const next = await patchState({ status: "healthy" });
    expect(next.settings).toEqual(DEFAULT_STATE.settings);
    expect(next.sourceSnapshots).toEqual(sourceSnapshots);
  });

  it("clears only the extension state key", async () => {
    local.values.lectioSyncStateV1 = DEFAULT_STATE;
    local.values.unrelated = true;
    await clearState();
    expect(local.values.lectioSyncStateV1).toBeUndefined();
    expect(local.values.unrelated).toBe(true);
  });

  it("caps old reconciliation snapshots before persisting state", async () => {
    const sourceSnapshots = Object.fromEntries(Array.from({ length: 2_005 }, (_, index) => [
      `event-${index}`,
      {
        fingerprint: `fingerprint-${index}`,
        missingStreak: 0,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
      }
    ]));
    await setState({ ...DEFAULT_STATE, sourceSnapshots });
    const stored = local.values.lectioSyncStateV1 as typeof DEFAULT_STATE;
    expect(Object.keys(stored.sourceSnapshots)).toHaveLength(2_000);
    expect(stored.sourceSnapshots["event-2004"]).toBeDefined();
    expect(stored.sourceSnapshots["event-0"]).toBeUndefined();
  });
});
