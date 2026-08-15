import browser from "webextension-polyfill";
import { sanitizeIntervalMinutes } from "./settings";
import {
  DEFAULT_STATE,
  type ExtensionState,
  type LectioAccount,
  type SafeError,
  type SourceSnapshotState,
  type SyncSettings,
  type SyncStatus
} from "./types";

const STATE_KEY = "lectioSyncStateV1";
const MAX_STORED_SNAPSHOTS = 2_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SOURCE_ID_LENGTH = 500;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 40;
const MAX_ERROR_LENGTH = 500;

const SYNC_STATUSES = new Set<SyncStatus>([
  "not_configured",
  "ready",
  "syncing",
  "healthy",
  "lectio_expired",
  "google_disconnected",
  "safe_error"
]);

const SAFE_ERROR_CODES = new Set<SafeError["code"]>([
  "LECTIO_AUTH_REQUIRED",
  "LECTIO_UNEXPECTED_PAGE",
  "LECTIO_NETWORK",
  "GOOGLE_AUTH_REQUIRED",
  "GOOGLE_API",
  "SAFARI_CALENDAR_REQUIRED",
  "UNKNOWN"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : undefined;
}

function boundedIdentifier(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/);
  if (!match) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === match[1]
    ? value
    : undefined;
}

function sanitizeSettings(value: unknown): SyncSettings {
  const input = isRecord(value) ? value : {};
  return {
    intervalMinutes: sanitizeIntervalMinutes(input.intervalMinutes, DEFAULT_STATE.settings.intervalMinutes),
    horizonWeeks: Number.isInteger(input.horizonWeeks)
      && Number(input.horizonWeeks) >= 2
      && Number(input.horizonWeeks) <= 12
      ? Number(input.horizonWeeks)
      : DEFAULT_STATE.settings.horizonWeeks,
    cancellationMode: input.cancellationMode === "mark" || input.cancellationMode === "remove"
      ? input.cancellationMode
      : DEFAULT_STATE.settings.cancellationMode,
    includeHomework: typeof input.includeHomework === "boolean"
      ? input.includeHomework
      : DEFAULT_STATE.settings.includeHomework,
    includeTitle: typeof input.includeTitle === "boolean"
      ? input.includeTitle
      : DEFAULT_STATE.settings.includeTitle,
    includeDescription: typeof input.includeDescription === "boolean"
      ? input.includeDescription
      : DEFAULT_STATE.settings.includeDescription,
    includeClass: typeof input.includeClass === "boolean"
      ? input.includeClass
      : DEFAULT_STATE.settings.includeClass,
    includeTeacher: typeof input.includeTeacher === "boolean"
      ? input.includeTeacher
      : DEFAULT_STATE.settings.includeTeacher
  };
}

function sanitizeLectioAccount(value: unknown, fallbackConnectedAt?: string): LectioAccount | undefined {
  if (!isRecord(value)) return undefined;
  const schoolId = typeof value.schoolId === "string" && /^\d{1,32}$/.test(value.schoolId)
    ? value.schoolId
    : undefined;
  const studentId = typeof value.studentId === "string" && /^\d{1,32}$/.test(value.studentId)
    ? value.studentId
    : undefined;
  if (!schoolId || !studentId) return undefined;

  const schoolName = boundedString(value.schoolName, 120);
  return {
    schoolId,
    studentId,
    ...(schoolName ? { schoolName } : {}),
    connectedAt: validTimestamp(value.connectedAt)
      ?? fallbackConnectedAt
      ?? new Date().toISOString()
  };
}

function sanitizeLastError(value: unknown, fallbackOccurredAt?: string): SafeError | undefined {
  if (!isRecord(value)) return undefined;
  const code = typeof value.code === "string" && SAFE_ERROR_CODES.has(value.code as SafeError["code"])
    ? value.code as SafeError["code"]
    : "UNKNOWN";
  const message = boundedString(value.message, MAX_ERROR_LENGTH)
    ?? "The action could not be completed safely.";
  const technicalDetail = boundedString(value.technicalDetail, MAX_ERROR_LENGTH);
  return {
    code,
    message,
    occurredAt: validTimestamp(value.occurredAt)
      ?? fallbackOccurredAt
      ?? new Date().toISOString(),
    ...(technicalDetail ? { technicalDetail } : {}),
    ...(typeof value.calendarMayHaveChanged === "boolean"
      ? { calendarMayHaveChanged: value.calendarMayHaveChanged }
      : {})
  };
}

function validSourceId(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_SOURCE_ID_LENGTH
    && !["__proto__", "constructor", "prototype"].includes(value)
    && /^[A-Za-z0-9_./?=&:%+-]+$/.test(value);
}

function sanitizeSnapshots(value: unknown): Record<string, SourceSnapshotState> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, SourceSnapshotState]> = [];
  for (const [sourceId, candidate] of Object.entries(value)) {
    if (!validSourceId(sourceId) || !isRecord(candidate)) continue;
    const fingerprint = boundedIdentifier(candidate.fingerprint, MAX_FINGERPRINT_LENGTH);
    const lastSeenAt = validTimestamp(candidate.lastSeenAt);
    if (!fingerprint || !lastSeenAt) continue;
    const missingStreak = candidate.missingStreak === 0 || candidate.missingStreak === 1
      ? candidate.missingStreak
      : 0;
    const lectioStatus = candidate.lectioStatus === "confirmed"
      || candidate.lectioStatus === "changed"
      || candidate.lectioStatus === "cancelled"
      ? candidate.lectioStatus
      : undefined;
    entries.push([sourceId, {
      fingerprint,
      missingStreak,
      lastSeenAt,
      ...(lectioStatus ? { lectioStatus } : {})
    }]);
  }
  entries.sort((left, right) => Date.parse(right[1].lastSeenAt) - Date.parse(left[1].lastSeenAt));
  return Object.fromEntries(entries.slice(0, MAX_STORED_SNAPSHOTS));
}

function sanitizeState(value: unknown): ExtensionState {
  const stored = isRecord(value) ? value : {};
  const lastAttemptAt = validTimestamp(stored.lastAttemptAt);
  const lastSuccessAt = validTimestamp(stored.lastSuccessAt);
  const nextSyncAt = validTimestamp(stored.nextSyncAt);
  const googleCalendarId = boundedIdentifier(stored.googleCalendarId, MAX_IDENTIFIER_LENGTH);
  const googleCalendarName = boundedString(stored.googleCalendarName, 120);
  const status = typeof stored.status === "string" && SYNC_STATUSES.has(stored.status as SyncStatus)
    ? stored.status as SyncStatus
    : DEFAULT_STATE.status;
  const rotationCursor = Number.isSafeInteger(stored.rotationCursor)
    && Number(stored.rotationCursor) >= 0
    && Number(stored.rotationCursor) < Number.MAX_SAFE_INTEGER
    ? Number(stored.rotationCursor)
    : DEFAULT_STATE.rotationCursor;
  const lectioAccount = sanitizeLectioAccount(stored.lectioAccount, lastSuccessAt ?? lastAttemptAt);
  const lastError = sanitizeLastError(stored.lastError, lastAttemptAt ?? lastSuccessAt);

  return {
    status,
    rotationCursor,
    settings: sanitizeSettings(stored.settings),
    sourceSnapshots: sanitizeSnapshots(stored.sourceSnapshots),
    ...(lectioAccount ? { lectioAccount } : {}),
    ...(googleCalendarId ? { googleCalendarId } : {}),
    ...(googleCalendarId && googleCalendarName ? { googleCalendarName } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(nextSyncAt ? { nextSyncAt } : {}),
    ...(lastError ? { lastError } : {})
  };
}

export async function getState(): Promise<ExtensionState> {
  const stored = await browser.storage.local.get(STATE_KEY);
  return sanitizeState(stored[STATE_KEY]);
}

export async function setState(state: ExtensionState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: sanitizeState(state) });
}

export async function patchState(patch: Partial<ExtensionState>): Promise<ExtensionState> {
  const current = await getState();
  const next: ExtensionState = {
    ...current,
    ...patch,
    settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
    sourceSnapshots: patch.sourceSnapshots ?? current.sourceSnapshots
  };
  const sanitized = sanitizeState(next);
  await setState(sanitized);
  return sanitized;
}

export async function clearState(): Promise<void> {
  await browser.storage.local.remove(STATE_KEY);
}
