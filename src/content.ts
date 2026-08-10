import browser from "webextension-polyfill";
import { schoolIdFromUrl, schoolNameFromDocument, studentIdFromDocument } from "./core/account";
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
