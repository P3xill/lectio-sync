import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, type ExtensionState, type RuntimeResponse } from "../src/core/types";

type MessageListener = (value: unknown, sender?: { url?: string; tab?: { url?: string } }) => Promise<RuntimeResponse>;

const backgroundHarness = vi.hoisted(() => {
  const listeners = {
    message: undefined as MessageListener | undefined
  };
  return {
    listeners,
    browser: {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: MessageListener) => { listeners.message = listener; })
        },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        sendNativeMessage: vi.fn(async () => undefined)
      },
      alarms: {
        clear: vi.fn(async () => true),
        onAlarm: { addListener: vi.fn() }
      },
      tabs: {
        query: vi.fn(async (): Promise<Array<{ id?: number; url?: string; windowId?: number }>> => []),
        sendMessage: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() }
      },
      windows: { update: vi.fn() },
      notifications: { onClicked: { addListener: vi.fn() } }
    }
  };
});

const storageMock = vi.hoisted(() => ({
  state: undefined as ExtensionState | undefined,
  getState: vi.fn(async () => storageMock.state!),
  patchState: vi.fn(async (patch: Partial<ExtensionState>) => {
    storageMock.state = { ...storageMock.state!, ...patch };
    return storageMock.state;
  }),
  clearState: vi.fn(async () => {
    storageMock.state = structuredClone(DEFAULT_STATE);
  })
}));

const syncMock = vi.hoisted(() => ({
  connectCalendar: vi.fn(),
  runSync: vi.fn(),
  scheduleNextSync: vi.fn(async () => undefined)
}));

vi.mock("webextension-polyfill", () => ({ default: backgroundHarness.browser }));
vi.mock("../src/core/storage", () => ({
  clearState: storageMock.clearState,
  getState: storageMock.getState,
  patchState: storageMock.patchState
}));
vi.mock("../src/core/sync-engine", () => ({
  ALARM_NAME: "lectio-sync-periodic",
  connectCalendar: syncMock.connectCalendar,
  runSync: syncMock.runSync,
  scheduleNextSync: syncMock.scheduleNextSync
}));
vi.mock("../src/core/firefox-oauth", () => ({ disconnectFirefoxGoogle: vi.fn() }));
vi.mock("../src/core/brave-oauth", () => ({
  disconnectBraveGoogle: vi.fn(),
  isBraveBrowser: vi.fn(async () => false)
}));

import "../src/background";

function state(overrides: Partial<ExtensionState> = {}): ExtensionState {
  return {
    ...structuredClone(DEFAULT_STATE),
    lectioAccount: {
      schoolId: "23",
      studentId: "42",
      schoolName: "Existing school",
      connectedAt: "2026-08-01T08:00:00.000Z"
    },
    googleCalendarId: "calendar-id",
    googleCalendarName: "Lectio",
    status: "healthy",
    lastAttemptAt: "2026-08-14T08:00:00.000Z",
    lastSuccessAt: "2026-08-14T08:01:00.000Z",
    nextSyncAt: "2026-08-14T08:10:00.000Z",
    lastError: {
      code: "LECTIO_NETWORK",
      message: "Previous account error",
      occurredAt: "2026-08-14T08:00:00.000Z"
    },
    rotationCursor: 4,
    sourceSnapshots: {
      "absid:1": {
        fingerprint: "old-fingerprint",
        missingStreak: 0,
        lastSeenAt: "2026-08-14T08:01:00.000Z"
      }
    },
    ...overrides
  };
}

async function dispatch(value: unknown, sender: { url?: string; tab?: { url?: string } } = {}) {
  if (!backgroundHarness.listeners.message) throw new Error("Background message listener was not registered.");
  return backgroundHarness.listeners.message(value, sender);
}

describe("background Lectio account lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      identity: { clearAllCachedAuthTokens: vi.fn(async () => undefined) }
    });
    storageMock.state = state();
  });

  it("resets account-scoped sync history and schedules from scratch when the account changes", async () => {
    const response = await dispatch({
      type: "LECTIO_PAGE_SEEN",
      url: "https://www.lectio.dk/lectio/99/forside.aspx",
      studentId: "77",
      schoolName: "New school"
    }, {
      url: "https://www.lectio.dk/lectio/99/forside.aspx"
    });

    expect(response.ok).toBe(true);
    expect(storageMock.state).toMatchObject({
      lectioAccount: { schoolId: "99", studentId: "77", schoolName: "New school" },
      googleCalendarId: "calendar-id",
      status: "ready",
      rotationCursor: 0,
      sourceSnapshots: {}
    });
    expect(storageMock.state?.lastAttemptAt).toBeUndefined();
    expect(storageMock.state?.lastSuccessAt).toBeUndefined();
    expect(storageMock.state?.nextSyncAt).toBeUndefined();
    expect(storageMock.state?.lastError).toBeUndefined();
    expect(syncMock.scheduleNextSync).toHaveBeenCalledOnce();
  });

  it("preserves freshly written snapshots and the existing alarm when discovery finds the same account", async () => {
    const freshSnapshots = {
      "absid:2": {
        fingerprint: "fresh-fingerprint",
        missingStreak: 0 as const,
        lastSeenAt: "2026-08-14T08:02:00.000Z"
      }
    };
    storageMock.patchState.mockImplementationOnce(async (patch: Partial<ExtensionState>) => {
      storageMock.state = {
        ...storageMock.state!,
        sourceSnapshots: freshSnapshots,
        ...patch
      };
      return storageMock.state;
    });

    const response = await dispatch({
      type: "LECTIO_PAGE_SEEN",
      url: "https://www.lectio.dk/lectio/23/forside.aspx",
      studentId: "42",
      schoolName: "Updated school name"
    }, {
      tab: { url: "https://www.lectio.dk/lectio/23/forside.aspx" }
    });

    const patch = storageMock.patchState.mock.calls[0]?.[0];
    expect(patch).not.toHaveProperty("sourceSnapshots");
    expect(storageMock.state?.sourceSnapshots).toEqual(freshSnapshots);
    expect(storageMock.state?.nextSyncAt).toBe("2026-08-14T08:10:00.000Z");
    expect(storageMock.state?.lectioAccount?.connectedAt).toBe("2026-08-01T08:00:00.000Z");
    expect(response.data).toMatchObject({ sourceSnapshots: freshSnapshots });
    expect(syncMock.scheduleNextSync).not.toHaveBeenCalled();
    expect(backgroundHarness.browser.alarms.clear).not.toHaveBeenCalled();
  });

  it("preserves a same-account sync error during Safari account rediscovery", async () => {
    storageMock.state = state({
      status: "safe_error",
      lastError: {
        code: "LECTIO_UNEXPECTED_PAGE",
        message: "Lectio returned an unexpected page.",
        occurredAt: "2026-08-14T08:03:00.000Z",
        technicalDetail: "Schedule markers were not found."
      }
    });

    const response = await dispatch({
      type: "LECTIO_PAGE_SEEN",
      url: "https://www.lectio.dk/lectio/23/skemany.aspx",
      studentId: "42",
      schoolName: "Existing school"
    }, {
      url: "https://www.lectio.dk/lectio/23/skemany.aspx"
    });

    expect(response.ok).toBe(true);
    expect(storageMock.state?.status).toBe("safe_error");
    expect(storageMock.state?.lastError).toMatchObject({
      code: "LECTIO_UNEXPECTED_PAGE",
      technicalDetail: "Schedule markers were not found."
    });
    expect(syncMock.scheduleNextSync).not.toHaveBeenCalled();
  });

  it("clears the alarm and all account-scoped history when Lectio is disconnected", async () => {
    const response = await dispatch({ type: "DISCONNECT", target: "lectio" });

    expect(response.ok).toBe(true);
    expect(backgroundHarness.browser.alarms.clear).toHaveBeenCalledWith("lectio-sync-periodic");
    expect(storageMock.state).toMatchObject({
      googleCalendarId: "calendar-id",
      status: "not_configured",
      rotationCursor: 0,
      sourceSnapshots: {}
    });
    expect(storageMock.state?.lectioAccount).toBeUndefined();
    expect(storageMock.state?.lastAttemptAt).toBeUndefined();
    expect(storageMock.state?.lastSuccessAt).toBeUndefined();
    expect(storageMock.state?.nextSyncAt).toBeUndefined();
    expect(storageMock.state?.lastError).toBeUndefined();
  });

  it("stops the alarm before clearing all extension state", async () => {
    const response = await dispatch({ type: "DISCONNECT", target: "all" });

    expect(response.ok).toBe(true);
    expect(backgroundHarness.browser.alarms.clear).toHaveBeenCalledWith("lectio-sync-periodic");
    expect(storageMock.clearState).toHaveBeenCalledOnce();
    expect(storageMock.state).toEqual(DEFAULT_STATE);
  });

  it("rejects Lectio discovery claims whose page does not match the sender", async () => {
    const before = structuredClone(storageMock.state);

    const response = await dispatch({
      type: "LECTIO_PAGE_SEEN",
      url: "https://www.lectio.dk/lectio/99/forside.aspx",
      studentId: "77"
    }, {
      url: "https://www.lectio.dk/lectio/23/forside.aspx"
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UNKNOWN");
    expect(storageMock.state).toEqual(before);
    expect(storageMock.patchState).not.toHaveBeenCalled();
  });

  it("rejects malformed runtime messages before they can change state", async () => {
    const before = structuredClone(storageMock.state);

    const response = await dispatch({
      type: "LECTIO_PAGE_SEEN",
      url: "https://www.lectio.dk/lectio/23/forside.aspx",
      studentId: "not-a-student-id"
    }, {
      url: "https://www.lectio.dk/lectio/23/forside.aspx"
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe("The extension rejected an invalid request.");
    expect(storageMock.state).toEqual(before);
    expect(storageMock.patchState).not.toHaveBeenCalled();
  });

  it("uses a matching open Lectio schedule for setup and accepts only its validated discovery response", async () => {
    backgroundHarness.browser.windows.update.mockResolvedValueOnce(undefined);
    backgroundHarness.browser.tabs.query.mockResolvedValueOnce([
      { id: 10, url: "https://www.lectio.dk/lectio/23/login_list.aspx", windowId: 1 },
      { id: 11, url: "https://www.lectio.dk/lectio/23/skemany.aspx", windowId: 2 },
      { id: 12, url: "https://www.lectio.dk/lectio/99/skemany.aspx", windowId: 3 },
      { id: 13, url: "https://example.test/lectio/23/skemany.aspx", windowId: 4 }
    ]);
    backgroundHarness.browser.tabs.sendMessage.mockResolvedValueOnce({
      url: "https://www.lectio.dk/lectio/23/skemany.aspx",
      studentId: "42",
      schoolName: "Existing school"
    });

    const response = await dispatch({ type: "START_LECTIO_SETUP" });

    expect(backgroundHarness.browser.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(backgroundHarness.browser.tabs.update).toHaveBeenCalledWith(11, { active: true });
    expect(backgroundHarness.browser.tabs.sendMessage).toHaveBeenCalledWith(11, { type: "LECTIO_DISCOVER_ACCOUNT" });
    expect(backgroundHarness.browser.tabs.create).not.toHaveBeenCalled();
    expect(response).toMatchObject({ ok: true, data: { lectioAccount: { schoolId: "23", studentId: "42" } } });
  });

  it("keeps valid settings while discarding malformed or out-of-range values", async () => {
    const response = await dispatch({
      type: "UPDATE_SETTINGS",
      settings: {
        intervalMinutes: 15,
        horizonWeeks: 99,
        cancellationMode: "remove",
        includeHomework: true,
        includeTitle: "yes"
      } as never
    });

    expect(response.ok).toBe(true);
    expect(storageMock.state?.settings).toEqual({
      ...state().settings,
      intervalMinutes: 15,
      cancellationMode: "remove",
      includeHomework: true
    });
    expect(syncMock.scheduleNextSync).toHaveBeenCalledWith(storageMock.state);
  });
});
