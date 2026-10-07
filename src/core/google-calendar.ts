import browser from "webextension-polyfill";
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
const OWNED_CALENDAR_KEY = "lectioSyncOwnedGoogleCalendarV1";
let calendarConnectionQueue: Promise<unknown> = Promise.resolve();

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

  constructor(public readonly status: number, message: string, public readonly technicalDetail?: string) {
    super(message);
    this.name = "GoogleApiError";
    this.code = status === 401 ? "GOOGLE_AUTH_REQUIRED" : "GOOGLE_API";
  }
}

export function isValidGoogleOAuthClientId(clientId: string): boolean {
  return GOOGLE_OAUTH_CLIENT_ID_PATTERN.test(clientId);
}

function googleAuthenticationError(error: unknown): GoogleApiError {
  const detail = String(error);
  if (/has not completed.*(?:Google )?verification|app.*(?:in testing|being tested)|only.*(?:approved|developer-approved) testers/iu.test(detail)) {
    return new GoogleApiError(401,
      "Google blocked access to Lectio Sync because the app is in testing or has not completed verification. Contact Lectio Sync support; the developer must enable access in Google Cloud before you can connect."
    );
  }
  if (/\baccess_denied\b/iu.test(detail)) {
    return new GoogleApiError(401,
      "Google Calendar access was denied. If you declined permission, reconnect and allow access. If Google says Lectio Sync is blocked or unverified, contact Lectio Sync support so the developer can fix the app's Google Cloud configuration."
    );
  }
  return new GoogleApiError(401,
    "Google Calendar could not renew access. Reconnect Google Calendar and allow access to resume synchronization.",
    detail.slice(0, 500)
  );
}

async function getGoogleToken(interactive: boolean): Promise<string> {
  if (__TARGET_BROWSER__ === "firefox") {
    try {
      return await getFirefoxGoogleToken(interactive);
    } catch (error) {
      throw googleAuthenticationError(error);
    }
  } else {
    if (await isBraveBrowser()) {
      if (!isValidBraveWebClientId(__GOOGLE_BRAVE_OAUTH_CLIENT_ID__)) {
        throw new GoogleApiError(401, "Brave Google OAuth is not configured with a valid Web application client ID.");
      }
      try {
        return await getBraveGoogleToken(interactive);
      } catch (error) {
        throw googleAuthenticationError(error);
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
      throw googleAuthenticationError(error);
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
  } else {
    invalidateBraveAccessToken(token);
    if (!await isBraveBrowser() && chrome.identity?.removeCachedAuthToken) await chrome.identity.removeCachedAuthToken({ token });
  }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private tokenRequest: Promise<string> | undefined;
  private tokenRecovery: { rejectedToken: string; request: Promise<string> } | undefined;

  private token(interactive: boolean): Promise<string> {
    // Share only in-flight silent authentication; do not cache an access token.
    if (interactive) return getGoogleToken(true);
    if (this.tokenRequest) return this.tokenRequest;
    const pending = getGoogleToken(false);
    this.tokenRequest = pending;
    void pending.then(
      () => { if (this.tokenRequest === pending) this.tokenRequest = undefined; },
      () => { if (this.tokenRequest === pending) this.tokenRequest = undefined; }
    );
    return pending;
  }

  private recoverToken(rejectedToken: string, interactive: boolean): Promise<string> {
    // Late 401 responses for the same token reuse the recovery already started.
    if (this.tokenRecovery?.rejectedToken === rejectedToken) return this.tokenRecovery.request;
    const request = invalidateGoogleToken(rejectedToken).then(() => this.token(interactive));
    const recovery = { rejectedToken, request };
    this.tokenRecovery = recovery;
    void request.catch(() => {
      if (this.tokenRecovery === recovery) this.tokenRecovery = undefined;
    });
    return request;
  }

  private async request<T>(path: string, init: RequestInit = {}, interactive = false): Promise<T> {
    let token = await this.token(interactive);
    let authenticationRetried = false;
    let rateLimitAttempt = 0;
    for (;;) {
      const response = await fetch(`${API_ROOT}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init.headers
        }
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401) {
          if (!authenticationRetried) {
            authenticationRetried = true;
            token = await this.recoverToken(token, interactive);
            continue;
          }
          await invalidateGoogleToken(token);
          this.tokenRecovery = undefined;
          throw new GoogleApiError(401,
            "Google Calendar access has expired or was revoked. Reconnect Google Calendar and allow access to resume synchronization.",
            body.slice(0, 500) || "Google Calendar returned 401 Invalid Credentials."
          );
        }
        const retryDelay = RATE_LIMIT_RETRY_DELAYS_MS[rateLimitAttempt];
        const rateLimited = (response.status === 403 || response.status === 429)
          && /rateLimitExceeded|userRateLimitExceeded|Rate Limit Exceeded/i.test(body);
        if (rateLimited && retryDelay !== undefined) {
          rateLimitAttempt += 1;
          await delay(retryDelay);
          continue;
        }
        throw new GoogleApiError(response.status, body.slice(0, 500) || `Google Calendar returned ${response.status}.`);
      }
      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
    }
  }

  ensureConnected(interactive: boolean, currentCalendarId?: string, calendarColor?: string): Promise<{ calendarId: string; calendarName: string }> {
    // Connections can come from separate adapter instances (popup and sync).
    const pending = calendarConnectionQueue.then(() => this.ensureCalendar(interactive, currentCalendarId, calendarColor));
    calendarConnectionQueue = pending.catch(() => undefined);
    return pending;
  }

  private async ensureCalendar(interactive: boolean, currentCalendarId?: string, calendarColor?: string): Promise<{ calendarId: string; calendarName: string }> {
    const stored = (await browser.storage.local.get(OWNED_CALENDAR_KEY))[OWNED_CALENDAR_KEY];
    const identifiers = [...new Set([currentCalendarId, typeof stored === "string" ? stored : undefined])];
    for (const identifier of identifiers) {
      if (!identifier) continue;
      try {
        await this.request(`/calendars/${encodeURIComponent(identifier)}?fields=id`, {}, interactive);
      } catch (error) {
        if (!(error instanceof GoogleApiError) || (error.status !== 404 && error.status !== 410)) throw error;
        continue;
      }
      await browser.storage.local.set({ [OWNED_CALENDAR_KEY]: identifier });
      if (calendarColor && identifier !== currentCalendarId) await this.setColor(identifier, calendarColor);
      return { calendarId: identifier, calendarName: "Lectio" };
    }

    const calendar = await this.request<{ id: string }>("/calendars?fields=id", {
      method: "POST",
      body: JSON.stringify({ summary: "Lectio", timeZone: "Europe/Copenhagen" })
    }, interactive);
    // Persist ownership before optional colour writes: a failed PATCH must not
    // cause the next connection attempt to POST another calendar.
    await browser.storage.local.set({ [OWNED_CALENDAR_KEY]: calendar.id });
    if (calendarColor) await this.setColor(calendar.id, calendarColor);
    return { calendarId: calendar.id, calendarName: "Lectio" };
  }

  async setColor(calendarId: string, calendarColor: string): Promise<void> {
    const red = Number.parseInt(calendarColor.slice(1, 3), 16);
    const green = Number.parseInt(calendarColor.slice(3, 5), 16);
    const blue = Number.parseInt(calendarColor.slice(5, 7), 16);
    if (!/^#[0-9A-Fa-f]{6}$/.test(calendarColor) || [red, green, blue].some(Number.isNaN)) {
      throw new GoogleApiError(400, "The calendar colour was invalid.");
    }
    const foregroundColor = (red * 299 + green * 587 + blue * 114) / 1_000 >= 150
      ? "#000000"
      : "#FFFFFF";
    await this.request(
      `/users/me/calendarList/${encodeURIComponent(calendarId)}?colorRgbFormat=true&fields=id`,
      {
        method: "PATCH",
        body: JSON.stringify({ backgroundColor: calendarColor.toUpperCase(), foregroundColor })
      }
    );
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
        maxResults: "2500",
        fields: "nextPageToken,items(id,status,extendedProperties/private)"
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
              await this.request(`/calendars/${encodeURIComponent(calendarId)}/events?fields=id`, {
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
    summary.completedAt = new Date().toISOString();
    return summary;
  }

  private async update(calendarId: string, eventId: string, event: CalendarEventInput): Promise<void> {
    await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=id`, {
      method: "PUT",
      body: JSON.stringify(toGoogleResource(event))
    });
  }

  async disconnect(): Promise<void> {
    this.tokenRecovery = undefined;
    if (__TARGET_BROWSER__ === "firefox") {
      await disconnectFirefoxGoogle();
    } else {
      await disconnectBraveGoogle();
      if (!await isBraveBrowser() && chrome.identity?.clearAllCachedAuthTokens) await chrome.identity.clearAllCachedAuthTokens();
    }
  }
}
