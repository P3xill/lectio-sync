import browser from "webextension-polyfill";
import type { CalendarAdapter, CalendarWindow } from "./calendar-adapter";
import type { ManagedCalendarEvent, ReconciliationOperation, SyncSummary } from "./types";

interface NativeResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

type CalendarConnection = { calendarId: string; calendarName: string };
let connectionGeneration = 0;
let connectionQueue: Promise<unknown> = Promise.resolve();
const pendingConnections = new Map<string, Promise<CalendarConnection>>();

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

  ensureConnected(interactive: boolean, currentCalendarId?: string, calendarColor?: string): Promise<{ calendarId: string; calendarName: string }> {
    const generation = connectionGeneration;
    const key = JSON.stringify([generation, interactive, currentCalendarId, calendarColor]);
    const pending = pendingConnections.get(key);
    if (pending) return pending;
    const assertCurrent = () => {
      if (generation !== connectionGeneration) throw calendarBridgeError("The Apple Calendar connection was cancelled. Reconnect to try again.");
    };
    const request = connectionQueue.then(async () => {
      assertCurrent();
      const connected = await this.send<CalendarConnection>("ENSURE_CALENDAR", { interactive, currentCalendarId, calendarColor });
      assertCurrent();
      return connected;
    }).finally(() => {
      if (pendingConnections.get(key) === request) pendingConnections.delete(key);
    });
    pendingConnections.set(key, request);
    connectionQueue = request.catch(() => undefined);
    return request;
  }

  async setColor(calendarId: string, calendarColor: string): Promise<void> {
    await this.ensureConnected(false, calendarId, calendarColor);
  }

  listManaged(calendarId: string, window: CalendarWindow): Promise<ManagedCalendarEvent[]> {
    return this.send("LIST_EVENTS", { calendarId, window });
  }

  apply(calendarId: string, operations: ReconciliationOperation[]): Promise<SyncSummary> {
    if (operations.every((operation) => operation.kind === "noop")) {
      return Promise.resolve({
        inserted: 0, updated: 0, deleted: 0, unchanged: operations.length,
        fetched: operations.length, completedAt: new Date().toISOString()
      });
    }
    return this.send("APPLY_OPERATIONS", { calendarId, operations });
  }

  async disconnect(): Promise<void> {
    connectionGeneration += 1;
    await this.send("DISCONNECT");
  }
}
