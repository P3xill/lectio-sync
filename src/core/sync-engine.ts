import browser from "webextension-polyfill";
import { addWeeks, getFetchWeekOffsets, getIsoWeek, lectioWeekValue } from "./date";
import { parseLectioActivityDetails, parseLectioSchedule } from "./parser";
import { toCalendarEvent } from "./calendar-event";
import { reconcileEvents } from "./reconcile";
import { GoogleApiError, GoogleCalendarAdapter } from "./google-calendar";
import { SafariCalendarAdapter } from "./safari-calendar";
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
const MAX_LECTIO_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS_PER_SYNC = 500;

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

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LECTIO_RESPONSE_BYTES) {
    throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned a page that was too large.");
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_LECTIO_RESPONSE_BYTES) {
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned a page that was too large.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LECTIO_RESPONSE_BYTES) {
        await reader.cancel();
        throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned a page that was too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchScheduleWeek(schoolId: string, studentId: string, weekDate: Date): Promise<LectioEvent[]> {
  const params = new URLSearchParams({
    type: "elev",
    elevid: studentId,
    week: lectioWeekValue(weekDate)
  });
  const url = `https://www.lectio.dk/lectio/${encodeURIComponent(schoolId)}/SkemaNy.aspx?${params}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
  } catch (error) {
    throw makeSafeError("LECTIO_NETWORK", "Lectio could not be reached.", String(error));
  }

  if (response.type === "opaqueredirect" || response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
  }
  if (!response.ok) {
    throw makeSafeError("LECTIO_NETWORK", `Lectio returned HTTP ${response.status}.`);
  }

  const html = await readLimitedText(response);
  try {
    return parseLectioSchedule(html, response.url).events;
  } catch (error) {
    if (lectioParserErrorCode(error) === "AUTH_REQUIRED") {
      throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
    }
    throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned an unexpected page.", String(error));
  }
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

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-cache",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
  } catch (error) {
    throw makeSafeError("LECTIO_NETWORK", "A Lectio activity page could not be reached.", String(error));
  }

  if (response.type === "opaqueredirect" || response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw makeSafeError("LECTIO_AUTH_REQUIRED", "Your Lectio login has expired.");
  }
  if (!response.ok) {
    throw makeSafeError("LECTIO_NETWORK", `Lectio returned HTTP ${response.status} for an activity page.`);
  }

  const html = await readLimitedText(response);
  try {
    const details = parseLectioActivityDetails(html, response.url || url);
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
  const workerCount = Math.min(4, events.length);
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
  if (typeof error === "object" && error && "code" in error && "occurredAt" in error) {
    return error as SafeError;
  }
  if (error instanceof GoogleApiError && error.status === 401) {
    return makeSafeError("GOOGLE_AUTH_REQUIRED", "Reconnect Google Calendar.", error.message);
  }
  if (error instanceof GoogleApiError) {
    return makeSafeError("GOOGLE_API", "Google Calendar could not be updated.", error.message);
  }
  if (__TARGET_BROWSER__ === "safari" && /calendar bridge|permission|calendar/i.test(String(error))) {
    return makeSafeError("SAFARI_CALENDAR_REQUIRED", "Allow calendar access in the Lectio Sync app.", String(error));
  }
  return makeSafeError("UNKNOWN", "Synchronization stopped before changing your calendar.", String(error));
}

export async function scheduleNextSync(state?: ExtensionState): Promise<void> {
  const current = state ?? await getState();
  await browser.alarms.clear(ALARM_NAME);
  await browser.alarms.create(ALARM_NAME, { periodInMinutes: current.settings.intervalMinutes });
  await patchState({
    nextSyncAt: new Date(Date.now() + current.settings.intervalMinutes * 60_000).toISOString()
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

export async function runSync(): Promise<SyncSummary> {
  const state = await getState();
  if (!state.lectioAccount) throw makeSafeError("LECTIO_AUTH_REQUIRED", "Connect Lectio first.");
  if (!state.googleCalendarId) throw makeSafeError("GOOGLE_AUTH_REQUIRED", "Connect Google Calendar first.");

  await patchState({ status: "syncing", lastAttemptAt: new Date().toISOString(), lastError: undefined });

  try {
    const baseMonday = getIsoWeek(new Date()).monday;
    const initialSync = !state.lastSuccessAt;
    const offsets = getFetchWeekOffsets(initialSync, state.settings.horizonWeeks, state.rotationCursor);
    const desiredSource: LectioEvent[] = [];
    for (const offset of offsets) {
      desiredSource.push(...await fetchScheduleWeek(
        state.lectioAccount.schoolId,
        state.lectioAccount.studentId,
        addWeeks(baseMonday, offset)
      ));
    }

    const uniqueDesiredSource = [...new Map(desiredSource.map((event) => [event.sourceId, event])).values()];
    if (uniqueDesiredSource.length > MAX_EVENTS_PER_SYNC) {
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Lectio returned too many events in one synchronization.");
    }
    const enrichedSource = await enrichActivityDetails(uniqueDesiredSource, state.lectioAccount.schoolId);
    const calendarSource: CalendarEventInput[] = [];
    for (const event of enrichedSource) {
      calendarSource.push(await toCalendarEvent(event, state.lectioAccount, state.settings));
    }
    const newlyCancelled = calendarSource.filter((event) =>
      isNewCancellation(event, state.sourceSnapshots[event.sourceId], Boolean(state.lastSuccessAt))
    );
    const desired = state.settings.cancellationMode === "remove"
      ? calendarSource.filter((event) => event.lectioStatus !== "cancelled")
      : calendarSource;

    const adapter = calendarAdapter();
    const existing = [];
    for (const group of groupConsecutive(offsets)) {
      existing.push(...await adapter.listManaged(state.googleCalendarId, weekWindow(baseMonday, group)));
    }
    const uniqueExisting = [...new Map(existing.map((event) => [event.id, event])).values()];
    const nowIso = new Date().toISOString();
    const reconciliation = reconcileEvents(desired, uniqueExisting, state.sourceSnapshots, nowIso);
    if (reconciliation.operations.length > MAX_EVENTS_PER_SYNC) {
      throw makeSafeError("LECTIO_UNEXPECTED_PAGE", "Too many calendar changes were required in one synchronization.");
    }
    let summary: SyncSummary;
    try {
      summary = await adapter.apply(state.googleCalendarId, reconciliation.operations);
    } catch (error) {
      if (__TARGET_BROWSER__ === "safari") throw error;
      const interrupted = errorFromUnknown(error);
      throw {
        ...interrupted,
        message: "Calendar synchronization was interrupted. Some changes may have been applied; the next sync will reconcile them.",
        calendarMayHaveChanged: true
      } satisfies SafeError;
    }

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

    const updated = await patchState({
      status: "healthy",
      lastSuccessAt: nowIso,
      lastAttemptAt: nowIso,
      lastError: undefined,
      rotationCursor: initialSync ? 0 : state.rotationCursor + 1,
      sourceSnapshots: nextSnapshots
    });
    await scheduleNextSync(updated);
    await notifyCancellations(newlyCancelled);
    return summary;
  } catch (error) {
    const safeError = errorFromUnknown(error);
    const status = safeError.code === "LECTIO_AUTH_REQUIRED"
      ? "lectio_expired" as const
      : safeError.code === "GOOGLE_AUTH_REQUIRED"
        ? "google_disconnected" as const
        : "safe_error" as const;
    await patchState({ status, lastError: safeError, nextSyncAt: undefined });
    await notifyError(safeError);
    throw safeError;
  }
}

export { ALARM_NAME };
