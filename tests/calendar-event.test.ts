import { describe, expect, it } from "vitest";
import { toCalendarEvent } from "../src/core/calendar-event";
import { DEFAULT_SETTINGS, type LectioAccount, type LectioEvent } from "../src/core/types";

const account: LectioAccount = { schoolId: "23", studentId: "42", connectedAt: "2026-08-01T00:00:00Z" };
const source: LectioEvent = {
  sourceId: "absid:1001",
  title: "Mathematics",
  start: "2026-08-10T08:15:00",
  end: "2026-08-10T09:00:00",
  className: "3x MA",
  teacher: "AB",
  homework: "Sensitive homework",
  note: "Welcome to the course.",
  status: "confirmed",
  sourceUrl: "https://www.lectio.dk/lectio/23/aktivitet/aktivitetinfo2.aspx?absid=1001"
};

describe("toCalendarEvent", () => {
  it("minimizes data by excluding homework by default", async () => {
    const event = await toCalendarEvent(source, account, DEFAULT_SETTINGS);
    expect(event.description).toContain("Description:\nWelcome to the course.");
    expect(event.description).toContain("Class: 3x MA");
    expect(event.description).toContain("Teacher: AB");
    expect(event.description).not.toContain("Sensitive homework");
    expect(event.description).not.toContain("https://www.lectio.dk");
    expect(event.description).not.toContain("Lectio:");
  });

  it("can exclude the class from the description", async () => {
    const event = await toCalendarEvent(source, account, { ...DEFAULT_SETTINGS, includeClass: false });
    expect(event.description).not.toContain("Class: 3x MA");
  });

  it("can exclude the title and description independently", async () => {
    const event = await toCalendarEvent(source, account, {
      ...DEFAULT_SETTINGS,
      includeTitle: false,
      includeDescription: false
    });
    expect(event.summary).toBe("3x MA");
    expect(event.description).not.toContain("Welcome to the course.");
    expect(event.description).toContain("Class: 3x MA");
  });

  it("uses a neutral event name when both title and class are unavailable", async () => {
    const event = await toCalendarEvent({ ...source, className: undefined }, account, {
      ...DEFAULT_SETTINGS,
      includeTitle: false
    });
    expect(event.summary).toBe("Lectio module");
  });

  it("marks cancelled modules as red and free", async () => {
    const event = await toCalendarEvent({ ...source, status: "cancelled" }, account, DEFAULT_SETTINGS);
    expect(event.summary).toBe("AFLYST · Mathematics");
    expect(event.colorId).toBe("11");
    expect(event.transparency).toBe("transparent");
  });

  it("changes its fingerprint when a user-visible field changes", async () => {
    const first = await toCalendarEvent(source, account, DEFAULT_SETTINGS);
    const moved = await toCalendarEvent({ ...source, location: "New room" }, account, DEFAULT_SETTINGS);
    expect(first.fingerprint).not.toBe(moved.fingerprint);
    expect(first.id).toBe(moved.id);
  });
});
