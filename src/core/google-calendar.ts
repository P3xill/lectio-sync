import type { CalendarAdapter, CalendarWindow } from "./calendar-adapter";
import { toGoogleResource } from "./calendar-adapter";
import {
  disconnectFirefoxGoogle,
  getFirefoxGoogleToken,
  invalidateFirefoxAccessToken
} from "./firefox-oauth";
import type { CalendarEventInput, ManagedCalendarEvent, ReconciliationOperation, SyncSummary } from "./types";

const API_ROOT = "https://www.googleapis.com/calendar/v3";

interface GoogleEventResource {
  id: string;
  status?: string;
  extendedProperties?: { private?: Record<string, string> };
}

interface GoogleListResponse {
  items?: GoogleEventResource[];
  nextPageToken?: string;
}

export class GoogleApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
  }
}

async function getGoogleToken(interactive: boolean): Promise<string> {
  if (__TARGET_BROWSER__ === "firefox") {
    try {
      return await getFirefoxGoogleToken(interactive);
    } catch (error) {
      throw new GoogleApiError(401, String(error).slice(0, 500));
    }
  } else {
    if (!chrome.identity?.getAuthToken) throw new GoogleApiError(401, "Google authentication is unavailable.");
    const result = await chrome.identity.getAuthToken({ interactive });
    if (!result.token) throw new GoogleApiError(401, "Google authentication is required.");
    return result.token;
  }
}

async function invalidateGoogleToken(token: string): Promise<void> {
  if (__TARGET_BROWSER__ === "firefox") {
    invalidateFirefoxAccessToken(token);
  } else if (chrome.identity?.removeCachedAuthToken) {
    await chrome.identity.removeCachedAuthToken({ token });
  }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private async request<T>(path: string, init: RequestInit = {}, interactive = false): Promise<T> {
    const token = await getGoogleToken(interactive);
    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers
      }
    });

    if (response.status === 401) await invalidateGoogleToken(token);
    if (!response.ok) {
      const body = await response.text();
      throw new GoogleApiError(response.status, body.slice(0, 500) || `Google Calendar returned ${response.status}.`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async ensureConnected(interactive: boolean, currentCalendarId?: string): Promise<{ calendarId: string; calendarName: string }> {
    if (currentCalendarId) {
      try {
        await this.request(`/calendars/${encodeURIComponent(currentCalendarId)}`, {}, interactive);
        return { calendarId: currentCalendarId, calendarName: "Lectio" };
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 404) throw error;
      }
    }

    const calendar = await this.request<{ id: string }>("/calendars", {
      method: "POST",
      body: JSON.stringify({ summary: "Lectio", timeZone: "Europe/Copenhagen" })
    }, interactive);
    return { calendarId: calendar.id, calendarName: "Lectio" };
  }

  async listManaged(calendarId: string, window: CalendarWindow): Promise<ManagedCalendarEvent[]> {
    const events: ManagedCalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        privateExtendedProperty: "lectioSync=true",
        showDeleted: "true",
        singleEvents: "true",
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        maxResults: "2500"
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request<GoogleListResponse>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${query}`
      );
      for (const item of response.items ?? []) {
        const privateProperties = item.extendedProperties?.private;
        const sourceId = privateProperties?.sourceId;
        if (!sourceId) continue;
        events.push({
          id: item.id,
          sourceId,
          fingerprint: privateProperties?.fingerprint,
          status: item.status,
          lectioStatus: privateProperties?.lectioStatus === "confirmed"
            || privateProperties?.lectioStatus === "changed"
            || privateProperties?.lectioStatus === "cancelled"
            ? privateProperties.lectioStatus
            : undefined
        });
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
    return events;
  }

  async apply(calendarId: string, operations: ReconciliationOperation[]): Promise<SyncSummary> {
    const summary: SyncSummary = {
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      fetched: operations.length,
      completedAt: new Date().toISOString()
    };

    for (const operation of operations) {
      if (operation.kind === "noop") {
        summary.unchanged += 1;
        continue;
      }
      if (operation.kind === "insert") {
        try {
          await this.request(`/calendars/${encodeURIComponent(calendarId)}/events`, {
            method: "POST",
            body: JSON.stringify(toGoogleResource(operation.event))
          });
          summary.inserted += 1;
        } catch (error) {
          if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
          await this.update(calendarId, operation.event.id, operation.event);
          summary.updated += 1;
        }
      } else if (operation.kind === "update") {
        await this.update(calendarId, operation.eventId, operation.event);
        summary.updated += 1;
      } else {
        await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(operation.eventId)}`, {
          method: "DELETE"
        });
        summary.deleted += 1;
      }
    }
    return summary;
  }

  private async update(calendarId: string, eventId: string, event: CalendarEventInput): Promise<void> {
    await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "PUT",
      body: JSON.stringify(toGoogleResource(event))
    });
  }

  async disconnect(): Promise<void> {
    if (__TARGET_BROWSER__ === "firefox") {
      await disconnectFirefoxGoogle();
    } else if (chrome.identity?.clearAllCachedAuthTokens) {
      await chrome.identity.clearAllCachedAuthTokens();
    }
  }
}
