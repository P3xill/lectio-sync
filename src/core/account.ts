import type { LectioIdentity } from "./types";

export interface DiscoveredLectioAccount {
  schoolId?: string;
  studentId?: string;
  teacherId?: string;
  schoolName?: string;
}

export function schoolIdFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.lectio.dk") return undefined;
    return url.pathname.match(/^\/lectio\/(\d+)(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
}

/** Reject ambiguous identities instead of guessing which timetable to sync. */
export function lectioIdentity(value: { studentId?: unknown; teacherId?: unknown }): LectioIdentity | undefined {
  const valid = (id: unknown): id is string => typeof id === "string" && /^\d{1,32}$/.test(id);
  if (valid(value.studentId) && value.teacherId === undefined) return { studentId: value.studentId };
  if (valid(value.teacherId) && value.studentId === undefined) return { teacherId: value.teacherId };
  return undefined;
}

/** Keep legacy student event IDs unchanged, and namespace teacher IDs. */
export function lectioIdentityKey(identity: LectioIdentity): string {
  return identity.teacherId !== undefined ? `teacher:${identity.teacherId}` : identity.studentId;
}

export function accountFromDocument(document: Document): LectioIdentity | undefined {
  const schoolId = schoolIdFromUrl(document.baseURI);
  if (!schoolId) return undefined;
  // Prefer the personal navigation link over a timetable the user is browsing.
  const personalLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter(anchor => /^(?:mit skema|skema)$/i.test(anchor.textContent?.trim() ?? ""));
  for (const candidate of [...personalLinks.map(anchor => anchor.href), document.baseURI]) {
    try {
      const url = new URL(candidate, document.baseURI);
      if (url.protocol !== "https:" || url.hostname !== "www.lectio.dk"
        || url.pathname.toLowerCase() !== `/lectio/${schoolId}/skemany.aspx`) continue;
      const params = new Map(Array.from(url.searchParams, ([key, value]) => [key.toLowerCase(), value]));
      const identity = lectioIdentity({ studentId: params.get("elevid"), teacherId: params.get("laererid") });
      const type = params.get("type")?.toLowerCase();
      if (identity && (!type || type === (identity.teacherId !== undefined ? "laerer" : "elev"))) return identity;
    } catch {
      // Ignore malformed URLs from page content.
    }
  }
  return undefined;
}

export function studentIdFromDocument(document: Document): string | undefined {
  return accountFromDocument(document)?.studentId;
}

export function schoolNameFromDocument(document: Document): string | undefined {
  const title = document.title.replace(/^Lectio\s*[-–—:]?\s*/i, "").trim();
  if (!title || /log ind|login|hovedmenu/i.test(title)) return undefined;
  return title.slice(0, 120);
}
