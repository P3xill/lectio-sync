import { describe, expect, it } from "vitest";
import { reconcileEvents } from "../src/core/reconcile";
import type { CalendarEventInput, ManagedCalendarEvent } from "../src/core/types";

const desired = (sourceId: string, fingerprint = "new"): CalendarEventInput => ({
  id: `id-${sourceId}`,
  sourceId,
  fingerprint,
  lectioStatus: "confirmed",
  summary: sourceId,
  description: "",
  start: "2026-08-10T08:00:00",
  end: "2026-08-10T09:00:00",
  transparency: "opaque"
});

describe("reconcileEvents", () => {
  it("inserts missing events and leaves matching events untouched", () => {
    const existing: ManagedCalendarEvent[] = [{ id: "id-a", sourceId: "a", fingerprint: "same" }];
    const result = reconcileEvents([desired("a", "same"), desired("b")], existing, {}, "2026-08-01T00:00:00Z");
    expect(result.operations.map((operation) => operation.kind)).toEqual(["noop", "insert"]);
  });

  it("updates an event in place when its fingerprint changes", () => {
    const result = reconcileEvents([desired("a", "new")], [{ id: "id-a", sourceId: "a", fingerprint: "old" }], {}, "2026-08-01T00:00:00Z");
    expect(result.operations).toEqual([{ kind: "update", event: desired("a", "new"), eventId: "id-a" }]);
  });

  it("keeps the canonical event and removes duplicate provider events for one source", () => {
    const result = reconcileEvents([desired("a", "same")], [
      { id: "legacy-a", sourceId: "a", fingerprint: "old" },
      { id: "id-a", sourceId: "a", fingerprint: "same" },
      { id: "duplicate-a", sourceId: "a", fingerprint: "same" }
    ], {}, "2026-08-01T00:00:00Z");

    expect(result.operations).toEqual([
      { kind: "noop", eventId: "id-a", sourceId: "a" },
      { kind: "delete", eventId: "legacy-a", sourceId: "a" },
      { kind: "delete", eventId: "duplicate-a", sourceId: "a" }
    ]);
  });

  it("never deletes after only one valid missing observation", () => {
    const result = reconcileEvents([], [{ id: "id-a", sourceId: "a", fingerprint: "old" }], {}, "2026-08-01T00:00:00Z");
    expect(result.operations).toEqual([{ kind: "noop", eventId: "id-a", sourceId: "a" }]);
    expect(result.nextSnapshots.a?.missingStreak).toBe(1);
  });

  it("deletes after a second consecutive valid missing observation", () => {
    const result = reconcileEvents([], [{ id: "id-a", sourceId: "a", fingerprint: "old" }], {
      a: { fingerprint: "old", missingStreak: 1, lastSeenAt: "2026-07-31T00:00:00Z" }
    }, "2026-08-01T00:00:00Z");
    expect(result.operations).toEqual([{ kind: "delete", eventId: "id-a", sourceId: "a" }]);
    expect(result.nextSnapshots.a).toBeUndefined();
  });
});
