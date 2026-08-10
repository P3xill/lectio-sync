import { describe, expect, it } from "vitest";
import { toGoogleResource } from "../src/core/calendar-adapter";

describe("toGoogleResource", () => {
  it("keeps ownership metadata private and pins Copenhagen time", () => {
    expect(toGoogleResource({
      id: "stable-id",
      sourceId: "absid:12",
      fingerprint: "fingerprint",
      lectioStatus: "confirmed",
      summary: "Mathematics",
      description: "Teacher: AB",
      location: "A12",
      start: "2026-08-10T08:00:00",
      end: "2026-08-10T09:00:00",
      transparency: "opaque"
    })).toMatchObject({
      id: "stable-id",
      start: { timeZone: "Europe/Copenhagen" },
      end: { timeZone: "Europe/Copenhagen" },
      extendedProperties: {
        private: { lectioSync: "true", sourceId: "absid:12", fingerprint: "fingerprint", lectioStatus: "confirmed" }
      }
    });
  });
});
