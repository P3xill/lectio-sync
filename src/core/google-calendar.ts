import type { CalendarAdapter, CalendarWindow } from "./calendar-adapter";
import { toGoogleResource } from "./calendar-adapter";
import {
  disconnectBraveGoogle,
  getBraveGoogleToken,
  invalidateBraveAccessToken,
  isBraveBrowser,
  isValidBraveWebClientId
} from "./brave-oauth";
import {
  disconnectFirefoxGoogle,
  getFirefoxGoogleToken,
  invalidateFirefoxAccessToken
} from "./firefox-oauth";
import type { CalendarEventInput, ManagedCalendarEvent, ReconciliationOperation, SyncSummary } from "./types";

const API_ROOT = "https://www.googleapis.com/calendar/v3";
const GOOGLE_OAUTH_CLIENT_ID_PATTERN = /^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/iu;
const WRITE_INTERVAL_MS = 175;
const RATE_LIMIT_RETRY_DELAYS_MS = [350, 700, 1_400];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  readonly code: "GOOGLE_AUTH_REQUIRED" | "GOOGLE_API";
  readonly occurredAt = new Date().toISOString();

  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.code = status === 401 ? "GOOGLE_AUTH_REQUIRED" : "GOOGLE_API";
  }
}

export function isValidGoogleOAuthClientId(clientId: string): boolean {
  return GOOGLE_OAUTH_CLIENT_ID_PATTERN.test(clientId);
}

async function getGoogleToken(interactive: boolean): Promise<string> {
  if (__TARGET_BROWSER__ === "firefox") {
    try {
      return await getFirefoxGoogleToken(interactive);
    } catch (error) {
      throw new GoogleApiError(401, String(error).slice(0, 500));
    }
  } else {
    if (await isBraveBrowser()) {
      if (!isValidBraveWebClientId(__GOOGLE_BRAVE_OAUTH_CLIENT_ID__)) {
        throw new GoogleApiError(401, "Brave Google OAuth is not configured with a valid Web application client ID.");
      }
      try {
        return await getBraveGoogleToken(interactive);
      } catch (error) {
        throw new GoogleApiError(401, String(error).slice(0, 500));
      }
    }
    if (!chrome.identity?.getAuthToken) throw new GoogleApiError(401, "Google authentication is unavailable.");
    const clientId = chrome.runtime?.getManifest?.().oauth2?.client_id;
    if (typeof clientId !== "string" || !isValidGoogleOAuthClientId(clientId)) {
      throw new GoogleApiError(401, "Chrome/Brave Google OAuth is not configured with a valid Chrome Extension client ID.");
    }
    let result: { token?: string } | string;
    try {
      result = await chrome.identity.getAuthToken({ interactive });
    } catch (error) {
      throw new GoogleApiError(
        401,
        `Google authentication failed. In Brave, enable “Allow Google login for extensions”. ${String(error)}`.slice(0, 500)
      );
    }
    // Brave has shipped Chromium identity implementations that preserve the
    // legacy string result while current Chrome returns GetAuthTokenResult.
    const token = typeof result === "string" ? result : result.token;
    if (!token) throw new GoogleApiError(401, "Google authentication is required.");
    return token;
  }
}

async function invalidateGoogleToken(token: string): Promise<void> {
  if (__TARGET_BROWSER__ === "firefox") {
    invalidateFirefoxAccessToken(token);
  } else if (chrome.identity?.removeCachedAuthToken) {
    invalidateBraveAccessToken(token);
    await chrome.identity.removeCachedAuthToken({ token });
  }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private async request<T>(path: string, init: RequestInit = {}, interactive = false): Promise<T> {
    const token = await getGoogleToken(interactive);
    for (let attempt = 0; ; attempt += 1) {
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
        const retryDelay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        const rateLimited = (response.status === 403 || response.status === 429)
          && /rateLimitExceeded|userRateLimitExceeded|Rate Limit Exceeded/i.test(body);
        if (rateLimited && retryDelay !== undefined) {
          await delay(retryDelay);
          continue;
        }
        throw new GoogleApiError(response.status, body.slice(0, 500) || `Google Calendar returned ${response.status}.`);
      }
      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
    }
  }

  async ensureConnected(interactive: boolean, currentCalendarId?: string): Promise<{ calendarId: string; calendarName: string }> {
    if (currentCalendarId) {
      try {
        await this.request(`/calendars/${encodeURIComponent(currentCalendarId)}`, {}, interactive);
        return { calendarId: currentCalendarId, calendarName: "Lectio" };
      } catch (error) {
        if (!(error instanceof GoogleApiError) || (error.status !== 404 && error.status !== 410)) throw error;
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

    let cursor = 0;
    let failure: unknown;
    let nextWriteAt = Date.now();
    const waitForWriteSlot = async () => {
      const now = Date.now();
      const scheduledAt = Math.max(now, nextWriteAt);
      nextWriteAt = scheduledAt + WRITE_INTERVAL_MS;
      if (scheduledAt > now) await delay(scheduledAt - now);
    };
    const workerCount = Math.min(3, operations.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < operations.length && failure === undefined) {
        const operation = operations[cursor++]!;
        try {
          if (operation.kind === "noop") {
            summary.unchanged += 1;
          } else if (operation.kind === "insert") {
            await waitForWriteSlot();
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
            await waitForWriteSlot();
            await this.update(calendarId, operation.eventId, operation.event);
            summary.updated += 1;
          } else {
            await waitForWriteSlot();
            await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(operation.eventId)}`, {
              method: "DELETE"
            });
            summary.deleted += 1;
          }
        } catch (error) {
          failure ??= error;
        }
      }
    }));
    if (failure !== undefined) throw failure;
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
      await disconnectBraveGoogle();
      await chrome.identity.clearAllCachedAuthTokens();
    }
  }
}
