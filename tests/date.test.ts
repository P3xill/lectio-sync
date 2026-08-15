import { describe, expect, it } from "vitest";
import {
  addWeeks,
  formatCopenhagenDateTime,
  formatDisplayDateTime,
  formatDisplayTime,
  getFetchWeekOffsets,
  getIsoWeek,
  lectioWeekValue
} from "../src/core/date";

describe("ISO week handling", () => {
  it("handles an ISO week-year boundary", () => {
    expect(getIsoWeek(new Date("2027-01-01T12:00:00Z"))).toMatchObject({ week: 53, year: 2026 });
    expect(lectioWeekValue(new Date("2027-01-01T12:00:00Z"))).toBe("532026");
  });

  it("uses Copenhagen's calendar date around local Monday midnight", () => {
    expect(getIsoWeek(new Date("2026-08-16T22:30:00Z"))).toMatchObject({
      week: 34,
      year: 2026,
      monday: new Date("2026-08-17T00:00:00Z")
    });
    expect(getIsoWeek(new Date("2026-01-04T23:30:00Z"))).toMatchObject({
      week: 2,
      year: 2026,
      monday: new Date("2026-01-05T00:00:00Z")
    });
  });

  it("prioritizes the near three weeks initially", () => {
    expect(getFetchWeekOffsets(true, 8, 0)).toEqual([0, 1, 2]);
    expect(getFetchWeekOffsets(true, 1, 0)).toEqual([0, 1]);
  });

  it("fetches near weeks and rotates one distant week later", () => {
    expect(getFetchWeekOffsets(false, 8, 0)).toEqual([0, 1, 2, 3]);
    expect(getFetchWeekOffsets(false, 8, 5)).toEqual([0, 1, 2, 8]);
    expect(getFetchWeekOffsets(false, 8, 6)).toEqual([0, 1, 2, 3]);
  });

  it("handles short horizons and formats Copenhagen wall-clock time", () => {
    expect(getFetchWeekOffsets(false, 2, 99)).toEqual([0, 1, 2]);
    expect(addWeeks(new Date("2026-08-03T00:00:00Z"), 2).toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(formatCopenhagenDateTime(new Date("2026-01-10T08:30:15Z"))).toBe("2026-01-10T09:30:15");
  });

  it("uses 24-hour Copenhagen time in the extension UI", () => {
    const evening = new Date("2026-08-07T19:53:47Z");
    expect(formatDisplayTime(evening)).toBe("21:53");
    expect(formatDisplayDateTime(evening)).toBe("07/08/2026, 21:53:47");
  });
});
