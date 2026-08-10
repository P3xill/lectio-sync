import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { LectioEvent } from "./types";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export class LectioParserError extends Error {
  constructor(
    public readonly code: "AUTH_REQUIRED" | "UNEXPECTED_PAGE",
    message: string
  ) {
    super(message);
    this.name = "LectioParserError";
  }
}

export interface ParsedSchedule {
  events: LectioEvent[];
  structuralMarkers: number;
}

export interface ParsedActivityDetails {
  title?: string;
  note?: string;
  structuralMarkers: number;
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function children(node: Node): Node[] {
  return "childNodes" in node ? (node.childNodes as Node[]) : [];
}

function getAttr(node: Element, name: string): string | undefined {
  return node.attrs.find((attribute) => attribute.name === name)?.value;
}

function classes(node: Element): string[] {
  return (getAttr(node, "class") ?? "").split(/\s+/).filter(Boolean);
}

function hasClass(node: Element, className: string): boolean {
  return classes(node).includes(className);
}

function walk(node: Node, callback: (node: Node, ancestors: Element[]) => void, ancestors: Element[] = []): void {
  callback(node, ancestors);
  const nextAncestors = isElement(node) ? [...ancestors, node] : ancestors;
  for (const child of children(node)) walk(child, callback, nextAncestors);
}

function textContent(node: Node): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  return children(node).map(textContent).join("");
}

function findFirst(node: Node, predicate: (element: Element) => boolean): Element | undefined {
  if (isElement(node) && predicate(node)) return node;
  for (const child of children(node)) {
    const match = findFirst(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function findAll(node: Node, predicate: (element: Element) => boolean): Element[] {
  const matches: Element[] = [];
  walk(node, (candidate) => {
    if (isElement(candidate) && predicate(candidate)) matches.push(candidate);
  });
  return matches;
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  const cleaned = value ? cleanText(value) : "";
  return cleaned ? cleaned.slice(0, maximum) : undefined;
}

function elementIdentity(node: Element): string {
  return [getAttr(node, "id"), getAttr(node, "class"), getAttr(node, "data-field"), getAttr(node, "aria-label")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function directText(node: Element): string {
  return cleanText(children(node)
    .filter((child) => !isElement(child))
    .map(textContent)
    .join(" "));
}

function valueByIdentity(document: Node, pattern: RegExp): string | undefined {
  const element = findFirst(document, (candidate) => pattern.test(elementIdentity(candidate)));
  return boundedText(element ? textContent(element) : undefined, 5_000);
}

function valueBesideLabel(document: Node, pattern: RegExp): string | undefined {
  let value: string | undefined;
  walk(document, (node, ancestors) => {
    if (value || !isElement(node) || !pattern.test(cleanText(textContent(node)))) return;
    const parent = ancestors.at(-1);
    if (!parent) return;
    const siblings = children(parent);
    const index = siblings.indexOf(node);
    for (const sibling of siblings.slice(index + 1)) {
      const candidate = boundedText(textContent(sibling), 5_000);
      if (candidate && !pattern.test(candidate)) {
        value = candidate;
        return;
      }
    }
  });
  return value;
}

function parseCompositeActivityTitle(value: string): string | undefined {
  const marker = value.match(/\b\d{1,2}\/\d{1,2}\s+\d+\.\s*modul\s*-\s*/i);
  if (marker?.index === undefined) return undefined;
  const remainder = value.slice(marker.index + marker[0].length);
  const parts = remainder.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  return boundedText(parts.slice(1).join(" – "), 300);
}

function compositeActivityFields(document: Node): { title?: string; note?: string; found: boolean } {
  const elements = findAll(document, () => true);
  const headingIndex = elements.findIndex((element) => {
    const value = cleanText(textContent(element));
    if (value.length > 500 || !/\bmodul\b/i.test(value)) return false;
    if (!parseCompositeActivityTitle(value)) return false;
    return !children(element).some((child) => isElement(child) && parseCompositeActivityTitle(cleanText(textContent(child))));
  });
  if (headingIndex < 0) return { found: false };

  const heading = cleanText(textContent(elements[headingIndex]!));
  const title = parseCompositeActivityTitle(heading);
  let note: string | undefined;
  for (const element of elements.slice(headingIndex + 1)) {
    const candidate = directText(element);
    if (!candidate) continue;
    if (/^(Lektier|Øvrigt indhold|Materiale|Dokumenter)$/i.test(candidate)) break;
    if (candidate === heading || heading.includes(candidate)) continue;
    if (candidate.length >= 3) {
      note = boundedText(candidate, 5_000);
      break;
    }
  }
  return { title, note, found: true };
}

function valueAfterLabel(lines: string[], pattern: RegExp): string | undefined {
  const line = lines.find((candidate) => pattern.test(candidate));
  return line?.split(":", 2)[1]?.trim() || undefined;
}

function sectionAfterLabel(lines: string[], pattern: RegExp, stopPatterns: RegExp[]): string | undefined {
  const index = lines.findIndex((candidate) => pattern.test(candidate));
  if (index < 0) return undefined;

  const label = lines[index]!;
  const colon = label.indexOf(":");
  const values = colon >= 0 && label.slice(colon + 1).trim() ? [label.slice(colon + 1).trim()] : [];
  for (const line of lines.slice(index + 1)) {
    if (stopPatterns.some((stopPattern) => stopPattern.test(line))) break;
    values.push(line);
  }
  return boundedText(values.join("\n"), 5_000);
}

function titleBeforeDate(lines: string[]): string | undefined {
  const dateIndex = lines.findIndex((line) => /^\d{1,2}\/\d{1,2}-\d{4}\b/.test(line));
  if (dateIndex <= 0) return undefined;
  const candidates = lines.slice(0, dateIndex).filter((line) => !/^(Aflyst!|Ændret!)$/i.test(line));
  return boundedText(candidates.at(-1), 300);
}

function parseSourceId(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://www.lectio.dk");
    if (url.protocol !== "https:" || url.hostname !== "www.lectio.dk") return undefined;
    for (const key of ["absid", "aftaleid", "ProeveholdId", "proeveholdid", "aktivitetid"]) {
      const value = url.searchParams.get(key);
      if (value) return `${key.toLowerCase()}:${value}`;
    }
    return url.pathname && url.search ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}

function parseDateTime(tooltip: string, fallbackDay?: string): { start: string; end: string } | undefined {
  const explicit = tooltip.match(/(\d{1,2})\/(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})\s+til\s+(\d{1,2}):(\d{2})/i);
  if (explicit) {
    const [, day, month, year, startHour, startMinute, endHour, endMinute] = explicit;
    return {
      start: `${year}-${month?.padStart(2, "0")}-${day?.padStart(2, "0")}T${startHour?.padStart(2, "0")}:${startMinute}:00`,
      end: `${year}-${month?.padStart(2, "0")}-${day?.padStart(2, "0")}T${endHour?.padStart(2, "0")}:${endMinute}:00`
    };
  }

  const timeOnly = tooltip.match(/(?:^|\s)(\d{1,2}):(\d{2})\s+til\s+(\d{1,2}):(\d{2})/i);
  if (timeOnly && fallbackDay && /^\d{4}-\d{2}-\d{2}$/.test(fallbackDay)) {
    const [, startHour, startMinute, endHour, endMinute] = timeOnly;
    return {
      start: `${fallbackDay}T${startHour?.padStart(2, "0")}:${startMinute}:00`,
      end: `${fallbackDay}T${endHour?.padStart(2, "0")}:${endMinute}:00`
    };
  }
  return undefined;
}

function eventTitle(node: Element, lines: string[]): string {
  const explicitTitle = valueAfterLabel(lines, /^(?:Aktivitets)?Titel\s*:/i);
  if (explicitTitle) return explicitTitle;
  const tooltipTitle = titleBeforeDate(lines);
  if (tooltipTitle) return tooltipTitle;
  const content = findFirst(node, (element) => hasClass(element, "s2skemabrikcontent"));
  const fromContent = content ? cleanText(textContent(content)) : "";
  if (fromContent) return fromContent.split("\n").at(-1)?.trim() || "Lectio module";

  const hold = valueAfterLabel(lines, /^Hold\s*:/i);
  if (hold) return hold;

  const titleLine = lines.find((line) =>
    !/^(Aflyst!|Ændret!|\d{1,2}\/\d{1,2}-\d{4}|Hold\s*:|Lærer.*:|Lokale.*:|Lektier\s*:)/i.test(line)
  );
  return titleLine || "Lectio module";
}

function parseBrick(node: Element, ancestors: Element[]): LectioEvent | undefined {
  const tooltip = cleanText(getAttr(node, "data-tooltip") ?? getAttr(node, "data-additionalinfo") ?? "");
  const lines = tooltip.split("\n").map((line) => line.trim()).filter(Boolean);
  const dayCell = [...ancestors].reverse().find((ancestor) => ancestor.tagName === "td" && getAttr(ancestor, "data-date"));
  const dateTime = parseDateTime(tooltip, dayCell ? getAttr(dayCell, "data-date") : undefined);
  const href = getAttr(node, "href");
  const sourceId = parseSourceId(href);
  if (!dateTime || !sourceId) return undefined;

  const rawStatus = `${lines[0] ?? ""} ${classes(node).join(" ")}`;
  const status: LectioEvent["status"] = /aflyst|cancelled/i.test(rawStatus)
    ? "cancelled"
    : /ændret|changed/i.test(rawStatus)
      ? "changed"
      : "confirmed";

  const homework = sectionAfterLabel(lines, /^Lektier\s*:/i, [
    /^(?:Aktivitets)?Note\s*:/i,
    /^Øvrigt indhold\s*:/i
  ]);
  const note = sectionAfterLabel(lines, /^(?:Aktivitets)?Note\s*:/i, [
    /^Lektier\s*:/i,
    /^Øvrigt indhold\s*:/i
  ]);

  return {
    sourceId,
    title: eventTitle(node, lines),
    note,
    start: dateTime.start,
    end: dateTime.end,
    className: valueAfterLabel(lines, /^Hold\s*:/i),
    location: valueAfterLabel(lines, /^Lokale(?:r)?\s*:/i),
    teacher: valueAfterLabel(lines, /^Lærer(?:e)?\s*:/i),
    homework,
    status,
    sourceUrl: href ? new URL(href, "https://www.lectio.dk").toString() : undefined
  };
}

export function parseLectioActivityDetails(
  html: string,
  finalUrl = "https://www.lectio.dk/lectio/"
): ParsedActivityDetails {
  if (/broker\.unilogin\.dk|nemlog-in\.mitid\.dk|login\.aspx/i.test(finalUrl)) {
    throw new LectioParserError("AUTH_REQUIRED", "Lectio authentication is required.");
  }
  if (/Loginvælger|Vælg login|Du er ikke logget ind|Log ind med MitID/i.test(html)) {
    throw new LectioParserError("AUTH_REQUIRED", "Lectio authentication is required.");
  }

  const document = parse(html) as Node;
  const composite = compositeActivityFields(document);
  const title = valueByIdentity(document, /(?:aktivitet|activity)[-_ ]*(?:s)?titel|activity[-_ ]*title/i)
    ?? valueBesideLabel(document, /^(?:Aktivitets)?titel\s*:?$/i)
    ?? composite.title;
  const note = valueByIdentity(document, /(?:aktivitet|activity)[-_ ]*note/i)
    ?? valueBesideLabel(document, /^(?:Aktivitets)?note\s*:?$/i)
    ?? composite.note;
  const bodyText = cleanText(textContent(document));
  const structuralMarkers = Number(composite.found)
    + Number(Boolean(title || note))
    + Number(/\bLektier\b/i.test(bodyText) && /\bmodul\b/i.test(bodyText));

  if (structuralMarkers === 0) {
    throw new LectioParserError("UNEXPECTED_PAGE", "Lectio returned an unrecognized activity page.");
  }
  return {
    title: boundedText(title, 300),
    note: boundedText(note, 5_000),
    structuralMarkers
  };
}

export function parseLectioSchedule(html: string, finalUrl = "https://www.lectio.dk/lectio/"): ParsedSchedule {
  if (/broker\.unilogin\.dk|nemlog-in\.mitid\.dk|login\.aspx/i.test(finalUrl)) {
    throw new LectioParserError("AUTH_REQUIRED", "Lectio authentication is required.");
  }
  if (/Loginvælger|Vælg login|Du er ikke logget ind|Log ind med MitID/i.test(html)) {
    throw new LectioParserError("AUTH_REQUIRED", "Lectio authentication is required.");
  }

  const document = parse(html) as Node;
  const events: LectioEvent[] = [];
  let structuralMarkers = 0;

  walk(document, (node, ancestors) => {
    if (!isElement(node)) return;
    if ((node.tagName === "table" && hasClass(node, "s2skema")) || getAttr(node, "data-date")) {
      structuralMarkers += 1;
    }
    if (node.tagName === "a" && (hasClass(node, "s2skemabrik") || hasClass(node, "s2bgbox"))) {
      const event = parseBrick(node, ancestors);
      if (event) events.push(event);
    }
  });

  if (structuralMarkers === 0) {
    throw new LectioParserError("UNEXPECTED_PAGE", "Lectio returned a page without schedule markers.");
  }

  const deduplicated = new Map(events.map((event) => [event.sourceId, event]));
  return { events: [...deduplicated.values()], structuralMarkers };
}
