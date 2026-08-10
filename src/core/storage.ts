import browser from "webextension-polyfill";
import { DEFAULT_STATE, type ExtensionState } from "./types";

const STATE_KEY = "lectioSyncStateV1";

export async function getState(): Promise<ExtensionState> {
  const stored = await browser.storage.local.get(STATE_KEY);
  const value = stored[STATE_KEY] as Partial<ExtensionState> | undefined;
  return {
    ...DEFAULT_STATE,
    ...value,
    settings: { ...DEFAULT_STATE.settings, ...value?.settings },
    sourceSnapshots: value?.sourceSnapshots ?? {},
    rotationCursor: value?.rotationCursor ?? 0
  };
}

export async function setState(state: ExtensionState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

export async function patchState(patch: Partial<ExtensionState>): Promise<ExtensionState> {
  const current = await getState();
  const next: ExtensionState = {
    ...current,
    ...patch,
    settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
    sourceSnapshots: patch.sourceSnapshots ?? current.sourceSnapshots
  };
  await setState(next);
  return next;
}

export async function clearState(): Promise<void> {
  await browser.storage.local.remove(STATE_KEY);
}
