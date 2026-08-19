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
  const requestedSchoolId = schoolIdFromUrl(message.url);
  if (!currentSchoolId || currentSchoolId !== requestedSchoolId) return undefined;
  return { type: "LECTIO_FETCH_PAGE", url: message.url, cache: message.cache };
}

export async function readLimitedLectioText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LECTIO_RESPONSE_BYTES) {
    throw new LectioPageTooLargeError();
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_LECTIO_RESPONSE_BYTES) {
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
    && new TextEncoder().encode(response.html).byteLength <= MAX_LECTIO_RESPONSE_BYTES;
}

export async function fetchLectioPageViaTab(
  url: string,
  cache: LectioCacheMode
): Promise<LectioPageResponse> {
  const schoolId = schoolIdFromUrl(url);
  if (!schoolId) throw new LectioSessionTabError("Safari rejected an invalid Lectio URL.");

  const tabs = await browser.tabs.query({});
  const candidates = tabs.filter((tab) => tab.id !== undefined && tab.url && schoolIdFromUrl(tab.url) === schoolId);
  if (candidates.length === 0) throw new LectioSessionTabError();

  for (const tab of candidates) {
    try {
      const response = await browser.tabs.sendMessage(tab.id!, {
        type: "LECTIO_FETCH_PAGE",
        url,
        cache
      } satisfies LectioPageRequest);
      if (isLectioPageResponse(response, schoolId)) return response;
    } catch {
      // Try another matching Lectio tab; an older tab may not have the content script loaded.
    }
  }
  throw new LectioSessionTabError();
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
