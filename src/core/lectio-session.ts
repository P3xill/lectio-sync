import browser from "webextension-polyfill";
import { schoolIdFromUrl } from "./account";

export const MAX_LECTIO_RESPONSE_BYTES = 2_000_000;

export type LectioCacheMode = "no-cache" | "no-store";

export interface LectioPageRequest {
  type: "LECTIO_FETCH_PAGE";
  url: string;
  cache: LectioCacheMode;
}

export interface LectioDiscoveryRequest {
  type: "LECTIO_DISCOVER_ACCOUNT";
}

export interface LectioDiscoveryResponse {
  url: string;
  studentId?: string;
  schoolName?: string;
}

export interface LectioPageResponse {
  status: number;
  ok: boolean;
  type: ResponseType;
  url: string;
  html: string;
}

export class LectioPageTooLargeError extends Error {
  constructor() {
    super("Lectio returned a page that was too large.");
    this.name = "LectioPageTooLargeError";
  }
}

export class LectioSessionTabError extends Error {
  constructor(message = "Safari could not reach the signed-in Lectio tab. Keep it open and reload it, then try again.") {
    super(message);
    this.name = "LectioSessionTabError";
  }
}

export function isSupportedLectioFetchUrl(rawUrl: string, schoolId: string): boolean {
  if (rawUrl.length > 2_048) return false;
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password || url.hash) return false;
    const path = url.pathname.toLowerCase();
    return schoolIdFromUrl(rawUrl) === schoolId && (
      path === `/lectio/${schoolId}/skemany.aspx`
      || path === `/lectio/${schoolId}/aktivitet/aktivitetinfo2.aspx`
    );
  } catch {
    return false;
  }
}

export function parseLectioPageRequest(value: unknown, currentPageUrl: string): LectioPageRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (
    message.type !== "LECTIO_FETCH_PAGE"
    || typeof message.url !== "string"
    || message.url.length > 2_048
    || (message.cache !== "no-cache" && message.cache !== "no-store")
  ) return undefined;

  const currentSchoolId = schoolIdFromUrl(currentPageUrl);
  if (!currentSchoolId || !isSupportedLectioFetchUrl(message.url, currentSchoolId)) return undefined;
  return { type: "LECTIO_FETCH_PAGE", url: message.url, cache: message.cache };
}

function withinResponseLimit(text: string): boolean {
  // A UTF-16 code unit needs at most three UTF-8 bytes. Most pages can be
  // validated without allocating another full encoded copy.
  if (text.length > MAX_LECTIO_RESPONSE_BYTES) return false;
  return text.length <= Math.floor(MAX_LECTIO_RESPONSE_BYTES / 3)
    || new TextEncoder().encode(text).byteLength <= MAX_LECTIO_RESPONSE_BYTES;
}

export async function readLimitedLectioText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LECTIO_RESPONSE_BYTES) {
    throw new LectioPageTooLargeError();
  }

  if (!response.body) {
    const text = await response.text();
    if (!withinResponseLimit(text)) {
      throw new LectioPageTooLargeError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LECTIO_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LectioPageTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function responseFromLectioFetch(response: Response): Promise<LectioPageResponse> {
  return {
    status: response.status,
    ok: response.ok,
    type: response.type,
    url: response.url,
    html: response.ok ? await readLimitedLectioText(response) : ""
  };
}

function isLectioPageResponse(value: unknown, schoolId: string): value is LectioPageResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (
    typeof response.status !== "number"
    || typeof response.ok !== "boolean"
    || typeof response.type !== "string"
    || typeof response.url !== "string"
    || typeof response.html !== "string"
  ) return false;
  const responseType = response.type as string;
  const validType = ["basic", "cors", "default", "error", "opaque", "opaqueredirect"].includes(responseType);
  const validFinalUrl = response.status === 0 || schoolIdFromUrl(response.url as string) === schoolId;
  return validType
    && validFinalUrl
    && withinResponseLimit(response.html);
}

export type LectioPageFetcher = (url: string, cache: LectioCacheMode) => Promise<LectioPageResponse>;

/** Reuse tab discovery within one sync, never page responses or login state. */
export function createLectioPageFetcher(): LectioPageFetcher {
  if (__TARGET_BROWSER__ !== "safari") return fetchLectioPage;
  return createTabPageFetcher();
}

function createTabPageFetcher(): LectioPageFetcher {
  let tabsRequest: ReturnType<typeof browser.tabs.query> | undefined;
  const preferredTabs = new Map<string, number>();
  return async (url, cache) => {
    const schoolId = schoolIdFromUrl(url);
    if (!schoolId) throw new LectioSessionTabError("Safari rejected an invalid Lectio URL.");
    const send = async (tabId: number) => {
      const response = await browser.tabs.sendMessage(tabId, {
        type: "LECTIO_FETCH_PAGE", url, cache
      } satisfies LectioPageRequest);
      return isLectioPageResponse(response, schoolId) ? response : undefined;
    };
    const preferred = preferredTabs.get(schoolId);
    if (preferred !== undefined) {
      try {
        const response = await send(preferred);
        if (response) return response;
      } catch {
        // Refresh discovery if the previously working tab closed or navigated.
      }
      preferredTabs.delete(schoolId);
      tabsRequest = undefined;
    }
    const discovery = tabsRequest ??= browser.tabs.query({});
    let tabs;
    try {
      tabs = await discovery;
    } catch (error) {
      if (tabsRequest === discovery) tabsRequest = undefined;
      throw error;
    }
    for (const tab of tabs) {
      if (tab.id === undefined || tab.id === preferred || !tab.url || schoolIdFromUrl(tab.url) !== schoolId) continue;
      try {
        const response = await send(tab.id);
        if (response) {
          preferredTabs.set(schoolId, tab.id);
          return response;
        }
      } catch {
        // An older tab may not have the content script loaded.
      }
    }
    if (tabsRequest === discovery) tabsRequest = undefined;
    throw new LectioSessionTabError();
  };
}

export async function fetchLectioPageViaTab(url: string, cache: LectioCacheMode): Promise<LectioPageResponse> {
  return createTabPageFetcher()(url, cache);
}

export async function fetchLectioPage(url: string, cache: LectioCacheMode): Promise<LectioPageResponse> {
  if (__TARGET_BROWSER__ === "safari") return fetchLectioPageViaTab(url, cache);
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache,
    redirect: "manual",
    referrerPolicy: "no-referrer",
    headers: { Accept: "text/html,application/xhtml+xml" }
  });
  return responseFromLectioFetch(response);
}
