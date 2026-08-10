import { COPENHAGEN_TIME_ZONE } from "./date";
import { fingerprint, stableGoogleEventId } from "./crypto";
import type { CalendarEventInput, LectioAccount, LectioEvent, SyncSettings } from "./types";

export async function toCalendarEvent(
  source: LectioEvent,
  account: LectioAccount,
  settings: SyncSettings
): Promise<CalendarEventInput> {
  const cancelled = source.status === "cancelled";
  const baseSummary = settings.includeTitle ? source.title : source.className ?? "Lectio module";
  const summary = cancelled ? `AFLYST · ${baseSummary}` : baseSummary;
  const descriptionLines = [
    settings.includeDescription && source.note ? `Description:\n${source.note}` : undefined,
    settings.includeClass && source.className ? `Class: ${source.className}` : undefined,
    settings.includeTeacher && source.teacher ? `Teacher: ${source.teacher}` : undefined,
    settings.includeHomework && source.homework ? `Homework:\n${source.homework}` : undefined,
    "Synced privately by Lectio Sync."
  ].filter((value): value is string => Boolean(value));

  const comparable = {
    summary,
    description: descriptionLines.join("\n\n"),
    location: source.location,
    start: source.start,
    end: source.end,
    colorId: cancelled ? "11" : source.status === "changed" ? "5" : undefined,
    transparency: cancelled ? "transparent" as const : "opaque" as const,
    timeZone: COPENHAGEN_TIME_ZONE
  };

  return {
    id: await stableGoogleEventId(account.schoolId, account.studentId, source.sourceId),
    ...comparable,
    sourceId: source.sourceId,
    fingerprint: await fingerprint(comparable),
    lectioStatus: source.status
  };
}
