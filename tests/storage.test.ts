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

  it("patches nested settings without dropping other fields", async () => {
    await setState({ ...DEFAULT_STATE, status: "ready" });
    const next = await patchState({ settings: { ...DEFAULT_STATE.settings, intervalMinutes: 5 } });
    expect(next.status).toBe("ready");
    expect(next.settings.intervalMinutes).toBe(5);
    expect(local.set).toHaveBeenCalled();
  });

  it("clears only the extension state key", async () => {
    local.values.lectioSyncStateV1 = DEFAULT_STATE;
    local.values.unrelated = true;
    await clearState();
    expect(local.values.lectioSyncStateV1).toBeUndefined();
    expect(local.values.unrelated).toBe(true);
  });
});
