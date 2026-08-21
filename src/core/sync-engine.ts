import browser from "webextension-polyfill";
import { addWeeks, getFetchWeekOffsets, getIsoWeek, lectioWeekValue } from "./date";
import { parseLectioActivityDetails, parseLectioSchedule } from "./parser";
import { toCalendarEvent } from "./calendar-event";
import { reconcileEvents } from "./reconcile";
import { GoogleApiError, GoogleCalendarAdapter } from "./google-calendar";
import { SafariCalendarAdapter } from "./safari-calendar";
import {
  fetchLectioPage,
  LectioPageTooLargeError,
  LectioSessionTabError
} from "./lectio-session";
import { getState, patchState } from "./storage";
import type {
  CalendarEventInput,
  ExtensionState,
  LectioEvent,
  SafeError,
  SourceSnapshotState,
  SyncSummary
} from "./types";

const ALARM_NAME = "lectio-sync-periodic";
const MAX_EVENTS_PER_SYNC = 500;
const STALE_SYNC = Symbol("stale-sync");

interface SyncIdentity {
  schoolId: string;
  studentId: string;
  lectioConnectedAt: string;
  googleCalendarId: string;
}

type StaleSyncError = SafeError & { [STALE_SYNC]: true };

let activeSync: Promise<SyncSummary> | undefined;

function calendarAdapter() {
  return __TARGET_BROWSER__ === "safari" ? new SafariCalendarAdapter() : new GoogleCalendarAdapter();
}

function makeSafeError(code: SafeError["code"], message: string, technicalDetail?: string): SafeError {
  return {
    code,
    message,
    occurredAt: new Date().toISOString(),
    technicalDetail: technicalDetail?.slice(0, 500)
  };
}

function syncIdentity(state: ExtensionState): SyncIdentity | undefined {
  if (!state.lectioAccount || !state.googleCalendarId) return undefined;
  return {
    schoolId: state.lectioAccount.schoolId,
    studentId: state.lectioAccount.studentId,
    lectioConnectedAt: state.lectioAccount.connectedAt,
    googleCalendarId: state.googleCalendarId
  };
}

function hasSyncIdentity(state: ExtensionState, expected: SyncIdentity): boolean {
  const current = syncIdentity(state);
  return Boolean(
    current
    && current.schoolId === expected.schoolId
    && current.studentId === expected.studentId
    && current.lectioConnectedAt === expected.lectioConnectedAt
    && current.googleCalendarId === expected.googleCalendarId
  );
}

function staleSyncError(calendarMayHaveChanged: boolean): StaleSyncError {
  return {
    ...makeSafeError(
      "UNKNOWN",
      calendarMayHaveChanged
        ? "Synchronization was cancelled because the connected account or calendar changed. The previous calendar may have been updated."
        : "Synchronization was cancelled because the connected account or calendar changed before calendar updates began."
    ),
    ...(calendarMayHaveChanged ? { calendarMayHaveChanged: true } : {}),
    [STALE_SYNC]: true
  };
}

async function assertSyncIdentity(expected: SyncIdentity, calendarMayHaveChanged: boolean): Promise<void> {
  if (!hasSyncIdentity(await getState(), expected)) {
    throw staleSyncError(calendarMayHaveChanged);
  }
}

function markCalendarMayHaveChanged(error: SafeError): SafeError {
  if (error.calendarMayHaveChanged) return error;
  return {
    ...error,
    message: "Calendar synchronization was interrupted. Some changes may have been applied; the next sync will reconcile them.",
    calendarMayHaveChanged: true
  };
}

function lectioParserErrorCode(error: unknown): "AUTH_REQUIRED" | "UNEXPECTED_PAGE" | undefined {
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "AUTH_REQUIRED" || code === "UNEXPECTED_PAGE") return code;
  }
  const message = String(error);
  if (/Lectio authentication is required/i.test(message)) return "AUTH_REQUIRED";
  if (/unrecognized activity page|without schedule markers/i.test(message)) return "UNEXPECTED_PAGE";
  return undefined;
}

function groupConsecutive(offsets: number[]): number[][] {
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const offset of sorted) {
    const last = groups.at(-1);
    if (!last || offset !== (last.at(-1) ?? offset) + 1) groups.push([offset]);
    else last.push(offset);
  }
  return groups;
}

function weekWindow(baseMonday: Date, offsets: number[]) {
  const first = offsets[0] ?? 0;
  const last = offsets.at(-1) ?? first;
  return {
    timeMin: addWeeks(baseMonday, first).toISOString(),
    timeMax: addWeeks(baseMonday, last + 1).toISOString()
  };
}

async function fetchScheduleWeek(schoolId: string, studentId: string, weekDate: Date): Promise<LectioEvent[]> {
  const params = new URLSearchParams({
    type: "elev",
    elevid: studentId,
    week: lectioWeekValue(weekDate)
  });
  const url = `https://www.lectio.dk/lectio/${encodeURIComponent(schoolId)}/SkemaNy.aspx?${params}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetchLectioPage(url, "no-store");
    } catch (error) {
      if (error instanceof LectioPageTooLargeError) {
        throw makeSafeError("LECTIO_UNEXPECTED_PAGE", error.message);
      }
      if (error instanceof LectioSessionTabError) {
        throw makeSafeError("LECTIO_NETWORK", error.message, String(error));
      }
      throw makeSafeError("LECTIO_NETWORK", "Lectio could not be reached.", String(error));
    }

    if (response.type === "opaqueredirect" || response.status === 0 || (response.status >= 300 && response.status < 400)) {
      throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
    }
    if (!response.ok) {
      throw makeSafeError("LECTIO_NETWORK", `Lectio returned HTTP ${response.status}.`);
    }

    try {
      return parseLectioSchedule(response.html, response.url).events;
    } catch (error) {
      if (lectioParserErrorCode(error) === "AUTH_REQUIRED") {
        throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
      }
      if (attempt === 0) continue;
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned an unexpected page.", String(error));
    }
  }

  throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned an unexpected page.");
}

function trustedActivityUrl(rawUrl: string | undefined, schoolId: string, sourceId: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    const expectedPrefix = `/lectio/${encodeURIComponent(schoolId)}/aktivitet/`.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const allowedPage = pathname === `${expectedPrefix}aktivitetforside2.aspx`
      || pathname === `${expectedPrefix}aktivitetinfo2.aspx`;
    const expectedAbsId = sourceId.startsWith("absid:") ? sourceId.slice("absid:".length) : undefined;
    if (
      url.protocol !== "https:"
      || url.hostname !== "www.lectio.dk"
      || !allowedPage
      || !expectedAbsId
      || url.searchParams.get("absid") !== expectedAbsId
    ) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function fetchActivityDetails(event: LectioEvent, schoolId: string): Promise<LectioEvent> {
  if (!event.sourceId.startsWith("absid:")) return event;
  const url = trustedActivityUrl(event.sourceUrl, schoolId, event.sourceId);
  if (!url) return event;

  let response;
  try {
    response = await fetchLectioPage(url, "no-cache");
  } catch (error) {
    if (error instanceof LectioPageTooLargeError) {
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", error.message);
    }
    if (error instanceof LectioSessionTabError) {
      throw makeSafeError("LECTIO_NETWORK", error.message, String(error));
    }
    throw makeSafeError("LECTIO_NETWORK", "A Lectio activity page could not be reached.", String(error));
  }

  if (response.type === "opaqueredirect" || response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
  }
  if (!response.ok) {
    throw makeSafeError("LECTIO_NETWORK", `Lectio returned HTTP ${response.status} for an activity page.`);
  }

  try {
    const details = parseLectioActivityDetails(response.html, response.url || url);
    return {
      ...event,
      title: details.title ?? event.title,
      note: details.note ?? event.note
    };
  } catch (error) {
    if (lectioParserErrorCode(error) === "AUTH_REQUIRED") {
      throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
    }
    throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned an unexpected activity page.", String(error));
  }
}

async function enrichActivityDetails(events: LectioEvent[], schoolId: string): Promise<LectioEvent[]> {
  const enriched = [...events];
  let cursor = 0;
  const workerCount = Math.min(8, events.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < events.length) {
      const index = cursor++;
      enriched[index] = await fetchActivityDetails(events[index]!, schoolId);
    }
  }));
  return enriched;
}

async function notifyError(error: SafeError): Promise<void> {
  if (!browser.notifications?.create) return;
  const title = error.code === "LECTIO_AUTH_REQUIRED" ? "Lectio login expired" : "Lectio Sync paused safely";
  await browser.notifications.create(`lectio-sync-${error.code}`, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-128.png"),
    title,
    message: error.message
  }).catch(() => undefined);
}

function isNewCancellation(
  event: CalendarEventInput,
  previous: SourceSnapshotState | undefined,
  hasCompletedSync: boolean
): boolean {
  if (event.lectioStatus !== "cancelled" || !hasCompletedSync) return false;
  if (!previous) return true;
  if (previous.lectioStatus) return previous.lectioStatus !== "cancelled";
  // Older stored snapshots did not include status. Comparing fingerprints avoids
  // announcing modules that were already marked as cancelled before an upgrade.
  return previous.fingerprint !== event.fingerprint;
}

async function notifyCancellations(events: CalendarEventInput[]): Promise<void> {
  if (!browser.notifications?.create) return;
  for (const event of events) {
    const moduleName = event.summary.replace(/^AFLYST\s*·\s*/i, "");
    const startsAt = event.start.replace("T", " ").slice(0, 16);
    await browser.notifications.create(`lectio-cancelled-${event.id}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-128.png"),
      title: "Module cancelled",
      message: `${moduleName} on ${startsAt} was cancelled in Lectio.`
    }).catch(() => undefined);
  }
}

function errorFromUnknown(error: unknown): SafeError {
  if (error instanceof GoogleApiError && error.status === 401) {
    return makeSafeError("GOOGLE_AUTH_REQUIRED", "Reconnect Google Calendar.", error.message);
  }
  if (error instanceof GoogleApiError) {
    return makeSafeError("GOOGLE_API", "Google Calendar could not be updated.", error.message);
  }
  if (typeof error === "object" && error && "code" in error && "occurredAt" in error) {
    return error as SafeError;
  }
  if (__TARGET_BROWSER__ === "safari" && /calendar bridge|permission|calendar/i.test(String(error))) {
    return makeSafeError("SAFARI_CALENDAR_REQUIRED", "Allow calendar access in the Lectio Sync app.", String(error));
  }
  return makeSafeError("UNKNOWN", "Synchronization stopped before changing your calendar.", String(error));
}

async function resetSyncAlarm(intervalMinutes: number): Promise<string> {
  await browser.alarms.clear(ALARM_NAME);
  await browser.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes });
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
}

export async function scheduleNextSync(state?: ExtensionState): Promise<void> {
  const current = state ?? await getState();
  const nextSyncAt = await resetSyncAlarm(current.settings.intervalMinutes);
  await patchState({
    nextSyncAt
  });
}

export async function connectCalendar(interactive = true): Promise<ExtensionState> {
  const state = await getState();
  const connected = await calendarAdapter().ensureConnected(interactive, state.googleCalendarId);
  const nextStatus = state.lectioAccount ? "ready" as const : state.status;
  return patchState({
    googleCalendarId: connected.calendarId,
    googleCalendarName: connected.calendarName,
    status: nextStatus,
    lastError: undefined
  });
}

async function performSync(): Promise<SyncSummary> {
  let state = await getState();
  if (!state.lectioAccount) throw makeSafeError("LECTIO_AUTH_REQUIRED", "Connect Lectio first.");
  if (!state.googleCalendarId) {
    throw makeSafeError(
      __TARGET_BROWSER__ === "safari" ? "SAFARI_CALENDAR_REQUIRED" : "GOOGLE_AUTH_REQUIRED",
      __TARGET_BROWSER__ === "safari" ? "Connect iCloud Calendar first." : "Connect Google Calendar first."
    );
  }
  const lectioAccount = state.lectioAccount;
  let activeCalendarId = state.googleCalendarId;
  let identity = syncIdentity(state)!;
  let calendarMutationStarted = false;

  try {
    await patchState({ status: "syncing", lastAttemptAt: new Date().toISOString(), lastError: undefined });
    const adapter = calendarAdapter();
    const connected = await adapter.ensureConnected(false, activeCalendarId);
    if (connected.calendarId !== activeCalendarId) {
      await assertSyncIdentity(identity, false);
      await patchState({
        googleCalendarId: connected.calendarId,
        googleCalendarName: connected.calendarName
      });
      state = {
        ...state,
        googleCalendarId: connected.calendarId,
        googleCalendarName: connected.calendarName
      };
      activeCalendarId = connected.calendarId;
      identity = syncIdentity(state)!;
    }
    const baseMonday = getIsoWeek(new Date()).monday;
    const initialSync = !state.lastSuccessAt;
    const offsets = getFetchWeekOffsets(initialSync, state.settings.horizonWeeks, state.rotationCursor);
    const desiredSource: LectioEvent[] = [];
    for (const offset of offsets) {
      desiredSource.push(...await fetchScheduleWeek(
        lectioAccount.schoolId,
        lectioAccount.studentId,
        addWeeks(baseMonday, offset)
      ));
    }

    const uniqueDesiredSource = [...new Map(desiredSource.map((event) => [event.sourceId, event])).values()];
    if (uniqueDesiredSource.length > MAX_EVENTS_PER_SYNC) {
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned too many events in one synchronization.");
    }
    const enrichedSource = await enrichActivityDetails(uniqueDesiredSource, lectioAccount.schoolId);
    const calendarSource: CalendarEventInput[] = [];
    for (const event of enrichedSource) {
      calendarSource.push(await toCalendarEvent(event, lectioAccount, state.settings));
    }
    const newlyCancelled = calendarSource.filter((event) =>
      isNewCancellation(event, state.sourceSnapshots[event.sourceId], Boolean(state.lastSuccessAt))
    );
    const desired = state.settings.cancellationMode === "remove"
      ? calendarSource.filter((event) => event.lectioStatus !== "cancelled")
      : calendarSource;

    const existing = [];
    for (const group of groupConsecutive(offsets)) {
      existing.push(...await adapter.listManaged(activeCalendarId, weekWindow(baseMonday, group)));
    }
    const uniqueExisting = [...new Map(existing.map((event) => [event.id, event])).values()];
    const nowIso = new Date().toISOString();
    const reconciliation = reconcileEvents(desired, uniqueExisting, state.sourceSnapshots, nowIso);
    if (reconciliation.operations.length > MAX_EVENTS_PER_SYNC) {
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Too many calendar changes were required in one synchronization.");
    }
    await assertSyncIdentity(identity, false);
    let summary: SyncSummary;
    calendarMutationStarted = true;
    try {
      summary = await adapter.apply(activeCalendarId, reconciliation.operations);
    } catch (error) {
      if (__TARGET_BROWSER__ === "safari") throw error;
      const interrupted = errorFromUnknown(error);
      throw {
        ...interrupted,
        message: "Calendar synchronization was interrupted. Some changes may have been applied; the next sync will reconcile them.",
        calendarMayHaveChanged: true
      } satisfies SafeError;
    }
    await assertSyncIdentity(identity, true);

    const covered = new Set([
      ...calendarSource.map((event) => event.sourceId),
      ...uniqueExisting.map((event) => event.sourceId)
    ]);
    const nextSnapshots: Record<string, SourceSnapshotState> = { ...state.sourceSnapshots };
    for (const sourceId of covered) delete nextSnapshots[sourceId];
    Object.assign(nextSnapshots, reconciliation.nextSnapshots);
    for (const event of calendarSource) {
      const snapshot = nextSnapshots[event.sourceId];
      nextSnapshots[event.sourceId] = {
        fingerprint: event.fingerprint,
        missingStreak: snapshot?.missingStreak ?? 0,
        lastSeenAt: nowIso,
        lectioStatus: event.lectioStatus
      };
    }

    const nextSyncAt = await resetSyncAlarm(state.settings.intervalMinutes);
    await assertSyncIdentity(identity, true);
    await patchState({
      status: "healthy",
      lastSuccessAt: nowIso,
      lastAttemptAt: nowIso,
      lastError: undefined,
      nextSyncAt,
      rotationCursor: initialSync ? 0 : state.rotationCursor + 1,
      sourceSnapshots: nextSnapshots
    });
    await notifyCancellations(newlyCancelled);
    return summary;
  } catch (error) {
    let safeError = errorFromUnknown(error);
    if (calendarMutationStarted) safeError = markCalendarMayHaveChanged(safeError);
    if (typeof error === "object" && error !== null && STALE_SYNC in error) {
      throw safeError;
    }
    const status = safeError.code === "LECTIO_AUTH_REQUIRED"
      ? "lectio_expired" as const
      : safeError.code === "GOOGLE_AUTH_REQUIRED"
        ? "google_disconnected" as const
        : "safe_error" as const;
    await patchState({ status, lastError: safeError, nextSyncAt: undefined }).catch(() => undefined);
    await notifyError(safeError).catch(() => undefined);
    throw safeError;
  }
}

export function runSync(): Promise<SyncSummary> {
  if (activeSync) return activeSync;
  const sync = performSync();
  activeSync = sync;
  const clearActiveSync = () => {
    if (activeSync === sync) activeSync = undefined;
  };
  void sync.then(clearActiveSync, clearActiveSync);
  return sync;
}

export { ALARM_NAME };
