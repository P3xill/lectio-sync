import type {
  CalendarEventInput,
  ManagedCalendarEvent,
  ReconciliationOperation,
  SyncSummary
} from "./types";

export interface CalendarWindow {
  timeMin: string;
  timeMax: string;
}

export interface CalendarAdapter {
  ensureConnected(interactive: boolean, currentCalendarId?: string, calendarColor?: string): Promise<{ calendarId: string; calendarName: string }>;
  setColor(calendarId: string, calendarColor: string): Promise<void>;
  listManaged(calendarId: string, window: CalendarWindow): Promise<ManagedCalendarEvent[]>;
  apply(calendarId: string, operations: ReconciliationOperation[]): Promise<SyncSummary>;
  disconnect(): Promise<void>;
}

export function toGoogleResource(event: CalendarEventInput): Record<string, unknown> {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: { dateTime: event.start, timeZone: "Europe/Copenhagen" },
    end: { dateTime: event.end, timeZone: "Europe/Copenhagen" },
    colorId: event.colorId,
    transparency: event.transparency,
    extendedProperties: {
      private: {
        lectioSync: "true",
        sourceId: event.sourceId,
        fingerprint: event.fingerprint,
        lectioStatus: event.lectioStatus
      }
    }
  };
}
