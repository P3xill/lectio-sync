import browser from "webextension-polyfill";
import type { CalendarAdapter, CalendarWindow } from "./calendar-adapter";
import type { ManagedCalendarEvent, ReconciliationOperation, SyncSummary } from "./types";

interface NativeResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function calendarBridgeError(message?: string): Error {
  return Object.assign(new Error(message ?? "The Safari calendar bridge is unavailable."), {
    code: "SAFARI_CALENDAR_REQUIRED",
    occurredAt: new Date().toISOString()
  });
}

export class SafariCalendarAdapter implements CalendarAdapter {
  private async send<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await browser.runtime.sendNativeMessage("dk.lectiosync.extension", { type, ...payload }) as NativeResponse<T>;
    if (!response?.ok || response.data === undefined) {
      throw calendarBridgeError(response?.error);
    }
    return response.data;
  }

  ensureConnected(interactive: boolean, currentCalendarId?: string): Promise<{ calendarId: string; calendarName: string }> {
    return this.send("ENSURE_CALENDAR", { interactive, currentCalendarId });
  }

  listManaged(calendarId: string, window: CalendarWindow): Promise<ManagedCalendarEvent[]> {
    return this.send("LIST_EVENTS", { calendarId, window });
  }

  apply(calendarId: string, operations: ReconciliationOperation[]): Promise<SyncSummary> {
    return this.send("APPLY_OPERATIONS", { calendarId, operations });
  }

  async disconnect(): Promise<void> {
    await this.send("DISCONNECT");
  }
}
