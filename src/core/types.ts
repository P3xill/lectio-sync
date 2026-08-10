export type SyncStatus =
  | "not_configured"
  | "ready"
  | "syncing"
  | "healthy"
  | "lectio_expired"
  | "google_disconnected"
  | "safe_error";

export type CancellationMode = "mark" | "remove";

export interface LectioAccount {
  schoolId: string;
  studentId: string;
  schoolName?: string;
  connectedAt: string;
}

export interface SyncSettings {
  intervalMinutes: 5 | 10;
  horizonWeeks: number;
  cancellationMode: CancellationMode;
  includeHomework: boolean;
  includeTitle: boolean;
  includeDescription: boolean;
  includeClass: boolean;
  includeTeacher: boolean;
}

export interface ExtensionState {
  lectioAccount?: LectioAccount;
  googleCalendarId?: string;
  googleCalendarName?: string;
  status: SyncStatus;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextSyncAt?: string;
  lastError?: SafeError;
  rotationCursor: number;
  settings: SyncSettings;
  sourceSnapshots: Record<string, SourceSnapshotState>;
}

export interface SafeError {
  code:
    | "LECTIO_AUTH_REQUIRED"
    | "LECTIO_UNEXPECTED_PAGE"
    | "LECTIO_NETWORK"
    | "GOOGLE_AUTH_REQUIRED"
    | "GOOGLE_API"
    | "SAFARI_CALENDAR_REQUIRED"
    | "UNKNOWN";
  message: string;
  occurredAt: string;
  technicalDetail?: string;
}

export interface LectioEvent {
  sourceId: string;
  title: string;
  note?: string;
  start: string;
  end: string;
  className?: string;
  location?: string;
  teacher?: string;
  homework?: string;
  status: "confirmed" | "changed" | "cancelled";
  sourceUrl?: string;
}

export interface SourceSnapshotState {
  fingerprint: string;
  missingStreak: number;
  lastSeenAt: string;
  lectioStatus?: LectioEvent["status"];
}

export interface CalendarEventInput {
  id: string;
  summary: string;
  description: string;
  location?: string;
  start: string;
  end: string;
  colorId?: string;
  transparency: "opaque" | "transparent";
  sourceId: string;
  fingerprint: string;
  lectioStatus: LectioEvent["status"];
}

export interface ManagedCalendarEvent {
  id: string;
  sourceId: string;
  fingerprint?: string;
  status?: string;
  lectioStatus?: LectioEvent["status"];
}

export type ReconciliationOperation =
  | { kind: "insert"; event: CalendarEventInput }
  | { kind: "update"; event: CalendarEventInput; eventId: string }
  | { kind: "delete"; eventId: string; sourceId: string }
  | { kind: "noop"; eventId: string; sourceId: string };

export interface ReconciliationResult {
  operations: ReconciliationOperation[];
  nextSnapshots: Record<string, SourceSnapshotState>;
}

export interface SyncSummary {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  fetched: number;
  completedAt: string;
}

export type RuntimeMessage =
  | { type: "GET_STATE" }
  | { type: "START_LECTIO_SETUP" }
  | { type: "LECTIO_PAGE_SEEN"; url: string; studentId?: string; schoolName?: string }
  | { type: "CONNECT_GOOGLE" }
  | { type: "SYNC_NOW" }
  | { type: "CHECK_LECTIO" }
  | { type: "UPDATE_SETTINGS"; settings: Partial<SyncSettings> }
  | { type: "DISCONNECT"; target: "lectio" | "google" | "all" }
  | { type: "OPEN_SETTINGS" };

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: SafeError;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  intervalMinutes: 10,
  horizonWeeks: 8,
  cancellationMode: "mark",
  includeHomework: false,
  includeTitle: true,
  includeDescription: true,
  includeClass: true,
  includeTeacher: true
};

export const DEFAULT_STATE: ExtensionState = {
  status: "not_configured",
  rotationCursor: 0,
  settings: DEFAULT_SETTINGS,
  sourceSnapshots: {}
};
