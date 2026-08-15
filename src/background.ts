import browser from "webextension-polyfill";
import { schoolIdFromUrl } from "./core/account";
import { sanitizeIntervalMinutes } from "./core/settings";
import { clearState, getState, patchState } from "./core/storage";
import { ALARM_NAME, connectCalendar, runSync, scheduleNextSync } from "./core/sync-engine";
import { disconnectFirefoxGoogle } from "./core/firefox-oauth";
import { disconnectBraveGoogle, isBraveBrowser } from "./core/brave-oauth";
import { toRuntimeSafeError } from "./core/runtime-error";
import type { LectioDiscoveryRequest, LectioDiscoveryResponse } from "./core/lectio-session";
import type { ExtensionState, RuntimeMessage, RuntimeResponse, SyncSettings } from "./core/types";

interface RuntimeSender {
  url?: string;
  tab?: { url?: string };
}

interface LectioTab {
  id?: number;
  url?: string;
  windowId?: number;
}

function parseRuntimeMessage(value: unknown): RuntimeMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "GET_STATE":
    case "START_LECTIO_SETUP":
    case "CONNECT_GOOGLE":
    case "SYNC_NOW":
    case "CHECK_LECTIO":
    case "OPEN_SETTINGS":
      return { type: message.type };
    case "LECTIO_PAGE_SEEN":
      if (
        typeof message.url !== "string"
        || message.url.length > 2_048
        || (message.studentId !== undefined && (typeof message.studentId !== "string" || !/^\d{1,32}$/.test(message.studentId)))
        || (message.schoolName !== undefined && (typeof message.schoolName !== "string" || message.schoolName.length > 120))
      ) return undefined;
      return {
        type: message.type,
        url: message.url,
        studentId: message.studentId as string | undefined,
        schoolName: message.schoolName as string | undefined
      };
    case "UPDATE_SETTINGS":
      if (typeof message.settings !== "object" || message.settings === null) return undefined;
      return { type: message.type, settings: message.settings as Partial<SyncSettings> };
    case "DISCONNECT":
      if (message.target !== "lectio" && message.target !== "google" && message.target !== "all") return undefined;
      return { type: message.type, target: message.target };
    default:
      return undefined;
  }
}

function lectioSenderUrl(sender: RuntimeSender): string | undefined {
  const rawUrl = sender.url ?? sender.tab?.url;
  if (!rawUrl || !schoolIdFromUrl(rawUrl)) return undefined;
  return rawUrl;
}

async function handleMessage(message: RuntimeMessage, sender: RuntimeSender = {}): Promise<RuntimeResponse> {
  try {
    switch (message.type) {
      case "GET_STATE":
        return { ok: true, data: await refreshLectioConnection() };
      case "START_LECTIO_SETUP":
        await discoverLectioAccount(await openLectioTab());
        return { ok: true, data: await getState() };
      case "LECTIO_PAGE_SEEN": {
        const senderUrl = lectioSenderUrl(sender);
        const schoolId = senderUrl ? schoolIdFromUrl(senderUrl) : undefined;
        if (!senderUrl || schoolId !== schoolIdFromUrl(message.url)) {
          throw new Error("Lectio account discovery came from an untrusted page.");
        }
        if (!schoolId || !message.studentId) return { ok: true };
        const next = await connectLectioAccount(schoolId, message.studentId, message.schoolName);
        return { ok: true, data: next };
      }
      case "CONNECT_GOOGLE": {
        try {
          return { ok: true, data: await connectCalendar(true) };
        } catch (error) {
          const safeError = toRuntimeSafeError(error);
          await patchState({ status: "google_disconnected", lastError: safeError });
          return { ok: false, error: safeError };
        }
      }
      case "SYNC_NOW":
      case "CHECK_LECTIO": {
        const state = await refreshLectioConnection();
        if (__TARGET_BROWSER__ === "safari" && !state.lectioAccount) {
          return { ok: true, data: state };
        }
        return { ok: true, data: await runSync() };
      }
      case "UPDATE_SETTINGS": {
        const current = await getState();
        const allowed = sanitizeSettings(message.settings, current.settings);
        const next = await patchState({ settings: allowed });
        await scheduleNextSync(next);
        return { ok: true, data: next };
      }
      case "DISCONNECT": {
        if (message.target === "google" || message.target === "all") {
          await connectCalendarAdapterDisconnect();
        }
        if (message.target === "all") {
          await browser.alarms.clear(ALARM_NAME);
          await clearState();
          return { ok: true, data: await getState() };
        }
        const next = message.target === "lectio"
          ? await disconnectLectioAccount()
          : await patchState({ googleCalendarId: undefined, googleCalendarName: undefined, status: "google_disconnected" });
        return { ok: true, data: next };
      }
      case "OPEN_SETTINGS":
        return { ok: true };
    }
  } catch (error) {
    return { ok: false, error: toRuntimeSafeError(error) };
  }
}

async function connectLectioAccount(
  schoolId: string,
  studentId: string,
  schoolName?: string
) {
  const state = await getState();
  const currentAccount = state.lectioAccount;
  const accountChanged = currentAccount?.schoolId !== schoolId
    || currentAccount?.studentId !== studentId;
  const account = {
    schoolId,
    studentId,
    schoolName,
    connectedAt: accountChanged
      ? new Date().toISOString()
      : (currentAccount?.connectedAt ?? new Date().toISOString())
  };
  const next = await patchState(accountChanged ? {
    ...lectioAccountHistoryReset(),
    lectioAccount: account,
    status: state.googleCalendarId ? "ready" : "not_configured"
  } : {
    lectioAccount: {
      ...account,
      connectedAt: currentAccount!.connectedAt
    },
    ...(state.status === "lectio_expired" ? {
      status: state.googleCalendarId ? "ready" as const : "not_configured" as const,
      lastError: undefined
    } : {})
  });
  if (accountChanged) await scheduleNextSync(next);
  return next;
}

function lectioAccountHistoryReset(): Pick<
  ExtensionState,
  "lastAttemptAt" | "lastSuccessAt" | "nextSyncAt" | "lastError" | "rotationCursor" | "sourceSnapshots"
> {
  return {
    lastAttemptAt: undefined,
    lastSuccessAt: undefined,
    nextSyncAt: undefined,
    lastError: undefined,
    rotationCursor: 0,
    sourceSnapshots: {}
  };
}

async function disconnectLectioAccount() {
  await browser.alarms.clear(ALARM_NAME);
  return patchState({
    ...lectioAccountHistoryReset(),
    lectioAccount: undefined,
    status: "not_configured"
  });
}

async function discoverLectioAccount(tab: LectioTab | undefined): Promise<boolean> {
  if (tab?.id === undefined || !tab.url) return false;
  const schoolId = schoolIdFromUrl(tab.url);
  if (!schoolId) return false;
  try {
    const response = await browser.tabs.sendMessage(tab.id, {
      type: "LECTIO_DISCOVER_ACCOUNT"
    } satisfies LectioDiscoveryRequest) as LectioDiscoveryResponse;
    if (
      !response
      || schoolIdFromUrl(response.url) !== schoolId
      || typeof response.studentId !== "string"
      || !/^\d{1,32}$/.test(response.studentId)
      || (response.schoolName !== undefined && (typeof response.schoolName !== "string" || response.schoolName.length > 120))
    ) return false;
    await connectLectioAccount(schoolId, response.studentId, response.schoolName);
    return true;
  } catch {
    // The tab may predate this extension build. Reloading it injects the current content script.
    return false;
  }
}

async function refreshLectioConnection() {
  const state = await getState();
  if (__TARGET_BROWSER__ !== "safari") return state;

  const tabs = await browser.tabs.query({});
  const schoolPrefix = state.lectioAccount
    ? `/lectio/${encodeURIComponent(state.lectioAccount.schoolId)}/`.toLowerCase()
    : undefined;
  const candidates = lectioTabs(tabs, schoolPrefix);

  for (const candidate of candidates) {
    if (await discoverLectioAccount(candidate)) {
      return restoreSafariCalendarConnection(await getState());
    }
  }

  if (!state.lectioAccount) return state;
  return disconnectLectioAccount();
}

async function restoreSafariCalendarConnection(state: Awaited<ReturnType<typeof getState>>) {
  if (__TARGET_BROWSER__ !== "safari" || !state.lectioAccount || state.googleCalendarId) return state;
  try {
    return await connectCalendar(false);
  } catch {
    // Calendar permission may not have been granted yet. Setup remains available.
    return state;
  }
}

async function openLectioTab(): Promise<LectioTab | undefined> {
  const state = await getState();
  const tabs = await browser.tabs.query({});
  const schoolPrefix = state.lectioAccount
    ? `/lectio/${encodeURIComponent(state.lectioAccount.schoolId)}/`.toLowerCase()
    : undefined;

  const candidates = lectioTabs(tabs, schoolPrefix);

  const existing = candidates[0];
  if (existing?.id !== undefined) {
    if (existing.windowId !== undefined) {
      await browser.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
    }
    await browser.tabs.update(existing.id, { active: true });
    return existing;
  }

  return browser.tabs.create({ url: "https://www.lectio.dk/lectio/login_list.aspx", active: true });
}

function lectioTabs(tabs: LectioTab[], schoolPrefix: string | undefined): LectioTab[] {
  return tabs
    .filter((tab) => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return url.protocol === "https:" && url.hostname === "www.lectio.dk" && url.pathname.toLowerCase().startsWith("/lectio/");
      } catch {
        return false;
      }
    })
    .sort((left, right) => lectioTabScore(right.url, schoolPrefix) - lectioTabScore(left.url, schoolPrefix));
}

function lectioTabScore(rawUrl: string | undefined, schoolPrefix: string | undefined): number {
  if (!rawUrl) return 0;
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    let score = 1;
    if (schoolPrefix && path.startsWith(schoolPrefix)) score += 100;
    if (path.endsWith("/skemany.aspx")) score += 20;
    if (path.endsWith("/forside.aspx")) score += 10;
    if (path.endsWith("/login_list.aspx")) score -= 50;
    return score;
  } catch {
    return 0;
  }
}

function sanitizeSettings(input: Partial<SyncSettings>, current: SyncSettings): SyncSettings {
  return {
    intervalMinutes: sanitizeIntervalMinutes(input.intervalMinutes, current.intervalMinutes),
    horizonWeeks: Number.isInteger(input.horizonWeeks) && Number(input.horizonWeeks) >= 2 && Number(input.horizonWeeks) <= 12
      ? Number(input.horizonWeeks)
      : current.horizonWeeks,
    cancellationMode: input.cancellationMode === "remove" ? "remove" : input.cancellationMode === "mark" ? "mark" : current.cancellationMode,
    includeHomework: typeof input.includeHomework === "boolean" ? input.includeHomework : current.includeHomework,
    includeTitle: typeof input.includeTitle === "boolean" ? input.includeTitle : current.includeTitle,
    includeDescription: typeof input.includeDescription === "boolean" ? input.includeDescription : current.includeDescription,
    includeClass: typeof input.includeClass === "boolean" ? input.includeClass : current.includeClass,
    includeTeacher: typeof input.includeTeacher === "boolean" ? input.includeTeacher : current.includeTeacher
  };
}

async function connectCalendarAdapterDisconnect(): Promise<void> {
  if (__TARGET_BROWSER__ === "firefox") {
    await disconnectFirefoxGoogle();
  } else if (__TARGET_BROWSER__ === "chrome" && chrome.identity?.clearAllCachedAuthTokens) {
    if (await isBraveBrowser()) await disconnectBraveGoogle();
    await chrome.identity.clearAllCachedAuthTokens();
  } else {
    await browser.runtime.sendNativeMessage("dk.lectiosync.extension", { type: "DISCONNECT" }).catch(() => undefined);
  }
}

browser.runtime.onMessage.addListener((value: unknown, sender: RuntimeSender) => {
  const message = parseRuntimeMessage(value);
  if (!message) {
    return Promise.resolve({
      ok: false,
      error: { code: "UNKNOWN", message: "The extension rejected an invalid request.", occurredAt: new Date().toISOString() }
    } satisfies RuntimeResponse);
  }
  return handleMessage(message, sender);
});

browser.runtime.onInstalled.addListener(() => {
  void scheduleNextSync();
});

browser.runtime.onStartup.addListener(() => {
  void refreshLectioConnection().then((state) => {
    if (state.lectioAccount) return scheduleNextSync(state);
  });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void refreshLectioConnection().then((state) => {
      if (state.lectioAccount) return runSync();
    }).catch(() => undefined);
  }
});

browser.tabs.onRemoved.addListener(() => {
  if (__TARGET_BROWSER__ === "safari") void refreshLectioConnection().catch(() => undefined);
});

browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    __TARGET_BROWSER__ === "safari"
    && (changeInfo.url !== undefined || changeInfo.status === "complete")
  ) {
    void refreshLectioConnection().catch(() => undefined);
  }
});

browser.notifications?.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("lectio-cancelled-")) {
    void browser.tabs.create({ url: "https://calendar.google.com/calendar/u/0/r", active: true });
  } else {
    void openLectioTab();
  }
});
