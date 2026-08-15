import type { SafeError } from "./types";

const SAFE_ERROR_CODES = new Set<SafeError["code"]>([
  "LECTIO_AUTH_REQUIRED",
  "LECTIO_UNEXPECTED_PAGE",
  "LECTIO_NETWORK",
  "GOOGLE_AUTH_REQUIRED",
  "GOOGLE_API",
  "SAFARI_CALENDAR_REQUIRED",
  "UNKNOWN"
]);

const FALLBACK_MESSAGE = "The action could not be completed safely.";

export function toRuntimeSafeError(error: unknown): SafeError {
  if (typeof error !== "object" || error === null) {
    return { code: "UNKNOWN", message: FALLBACK_MESSAGE, occurredAt: new Date().toISOString() };
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" && SAFE_ERROR_CODES.has(record.code as SafeError["code"])
    ? record.code as SafeError["code"]
    : "UNKNOWN";
  const occurredAt = typeof record.occurredAt === "string"
    && record.occurredAt.length <= 40
    && Number.isFinite(Date.parse(record.occurredAt))
    ? record.occurredAt
    : new Date().toISOString();
  const result: SafeError = {
    code,
    message: typeof record.message === "string" && record.message.length > 0
      ? record.message.slice(0, 500)
      : FALLBACK_MESSAGE,
    occurredAt
  };
  if (typeof record.technicalDetail === "string") result.technicalDetail = record.technicalDetail.slice(0, 500);
  if (typeof record.calendarMayHaveChanged === "boolean") result.calendarMayHaveChanged = record.calendarMayHaveChanged;
  return result;
}
