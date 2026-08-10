import browser from "webextension-polyfill";
import { schoolIdFromUrl } from "./core/account";
import { clearState, getState, patchState } from "./core/storage";
import { ALARM_NAME, connectCalendar, runSync, scheduleNextSync } from "./core/sync-engine";
import { disconnectFirefoxGoogle } from "./core/firefox-oauth";
import type { RuntimeMessage, RuntimeResponse, SyncSettings } from "./core/types";

async function handleMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  try {
    switch (message.type) {
      case "GET_STATE":
        return { ok: true, data: await getState() };
      case "START_LECTIO_SETUP":
        await openLectioTab();
        return { ok: true };
      case "LECTIO_PAGE_SEEN": {
        const schoolId = schoolIdFromUrl(message.url);
        if (!schoolId || !message.studentId) return { ok: true };
        const state = await getState();
        const next = await patchState({
          lectioAccount: {
            schoolId,
            studentId: message.studentId,
            schoolName: message.schoolName,
            connectedAt: new Date().toISOString()
          },
          status: state.googleCalendarId ? "ready" : "not_configured",
          lastError: undefined
        });
        await scheduleNextSync(next);
        return { ok: true, data: next };
      }
      case "CONNECT_GOOGLE":
        return { ok: true, data: await connectCalendar(true) };
      case "SYNC_NOW":
      case "CHECK_LECTIO":
        return { ok: true, data: await runSync() };
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
          await clearState();
          return { ok: true, data: await getState() };
        }
        const next = message.target === "lectio"
          ? await patchState({ lectioAccount: undefined, status: "not_configured", sourceSnapshots: {} })
          : await patchState({ googleCalendarId: undefined, googleCalendarName: undefined, status: "google_disconnected" });
        return { ok: true, data: next };
      }
      case "OPEN_SETTINGS":
        return { ok: true };
    }
  } catch (error) {
    const safeError = typeof error === "object" && error && "code" in error
      ? error
      : { code: "UNKNOWN", message: "The action could not be completed safely.", occurredAt: new Date().toISOString() };
    return { ok: false, error: safeError as RuntimeResponse["error"] };
  }
}

async function openLectioTab(): Promise<void> {
  const state = await getState();
  const tabs = await browser.tabs.query({});
  const schoolPrefix = state.lectioAccount
    ? `/lectio/${encodeURIComponent(state.lectioAccount.schoolId)}/`.toLowerCase()
    : undefined;

  const candidates = tabs
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

  const existing = candidates[0];
  if (existing?.id !== undefined) {
    if (existing.windowId !== undefined) {
      await browser.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
    }
    await browser.tabs.update(existing.id, { active: true });
    return;
  }

  await browser.tabs.create({ url: "https://www.lectio.dk/lectio/login_list.aspx", active: true });
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
    intervalMinutes: input.intervalMinutes === 5 ? 5 : input.intervalMinutes === 10 ? 10 : current.intervalMinutes,
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
    await chrome.identity.clearAllCachedAuthTokens();
  } else {
    await browser.runtime.sendNativeMessage("dk.lectiosync.extension", { type: "DISCONNECT" }).catch(() => undefined);
  }
}

browser.runtime.onMessage.addListener((message: unknown) => handleMessage(message as RuntimeMessage));

browser.runtime.onInstalled.addListener(() => {
  void scheduleNextSync();
});

browser.runtime.onStartup.addListener(() => {
  void scheduleNextSync();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void runSync().catch(() => undefined);
});

browser.notifications?.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("lectio-cancelled-")) {
    void browser.tabs.create({ url: "https://calendar.google.com/calendar/u/0/r", active: true });
  } else {
    void openLectioTab();
  }
});
