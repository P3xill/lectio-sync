export interface DiscoveredLectioAccount {
  schoolId?: string;
  studentId?: string;
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

export function studentIdFromDocument(document: Document): string | undefined {
  const schoolId = schoolIdFromUrl(document.baseURI);
  if (!schoolId) return undefined;
  const schoolPath = `/lectio/${schoolId}/`;
  const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="elevid="]'));
  for (const anchor of candidates) {
    try {
      const url = new URL(anchor.href, document.baseURI);
      const studentId = url.searchParams.get("elevid");
      if (
        url.protocol === "https:"
        && url.hostname === "www.lectio.dk"
        && url.pathname.startsWith(schoolPath)
        && studentId
        && /^\d{1,32}$/.test(studentId)
      ) return studentId;
    } catch {
      // Ignore malformed links from page content.
    }
  }
  return undefined;
}

export function schoolNameFromDocument(document: Document): string | undefined {
  const title = document.title.replace(/^Lectio\s*[-–—:]?\s*/i, "").trim();
  if (!title || /log ind|login|hovedmenu/i.test(title)) return undefined;
  return title.slice(0, 120);
}
