import browser from "webextension-polyfill";
import { schoolIdFromUrl, schoolNameFromDocument, studentIdFromDocument } from "./core/account";
import {
  parseLectioPageRequest,
  responseFromLectioFetch,
  type LectioDiscoveryResponse
} from "./core/lectio-session";
import type { RuntimeMessage } from "./core/types";

const schoolId = schoolIdFromUrl(location.href);
const studentId = studentIdFromDocument(document);

if (schoolId && studentId) {
  const message: RuntimeMessage = {
    type: "LECTIO_PAGE_SEEN",
    url: location.href,
    studentId,
    schoolName: schoolNameFromDocument(document)
  };
  void browser.runtime.sendMessage(message).catch(() => undefined);
}

browser.runtime.onMessage.addListener((value: unknown) => {
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "LECTIO_DISCOVER_ACCOUNT") {
    return Promise.resolve({
      url: location.href,
      studentId: studentIdFromDocument(document),
      schoolName: schoolNameFromDocument(document)
    } satisfies LectioDiscoveryResponse);
  }

  const request = parseLectioPageRequest(value, location.href);
  if (!request || __TARGET_BROWSER__ !== "safari") return undefined;

  return fetch(request.url, {
    method: "GET",
    credentials: "include",
    cache: request.cache,
    redirect: "manual",
    referrerPolicy: "no-referrer",
    headers: { Accept: "text/html,application/xhtml+xml" }
  }).then(responseFromLectioFetch);
});
