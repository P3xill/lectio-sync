import type {
  CalendarEventInput,
  ManagedCalendarEvent,
  ReconciliationResult,
  SourceSnapshotState
} from "./types";

const DELETE_AFTER_MISSING_SYNCS = 2;

export function reconcileEvents(
  desired: CalendarEventInput[],
  existing: ManagedCalendarEvent[],
  previousSnapshots: Record<string, SourceSnapshotState>,
  nowIso: string
): ReconciliationResult {
  const desiredBySource = new Map(desired.map((event) => [event.sourceId, event]));
  const existingBySource = new Map<string, ManagedCalendarEvent[]>();
  for (const event of existing) {
    const matches = existingBySource.get(event.sourceId);
    if (matches) matches.push(event);
    else existingBySource.set(event.sourceId, [event]);
  }
  const nextSnapshots: Record<string, SourceSnapshotState> = {};
  const operations: ReconciliationResult["operations"] = [];

  for (const event of desired) {
    const matches = existingBySource.get(event.sourceId) ?? [];
    const current = matches.find((candidate) => candidate.id === event.id) ?? matches[0];
    nextSnapshots[event.sourceId] = {
      fingerprint: event.fingerprint,
      missingStreak: 0,
      lastSeenAt: nowIso,
      lectioStatus: event.lectioStatus
    };

    if (!current) {
      operations.push({ kind: "insert", event });
    } else if (current.fingerprint !== event.fingerprint || current.status === "cancelled") {
      operations.push({ kind: "update", event, eventId: current.id });
    } else {
      operations.push({ kind: "noop", eventId: current.id, sourceId: event.sourceId });
    }

    for (const duplicate of matches) {
      if (duplicate !== current) {
        operations.push({ kind: "delete", eventId: duplicate.id, sourceId: duplicate.sourceId });
      }
    }
  }

  for (const current of existing) {
    if (desiredBySource.has(current.sourceId)) continue;
    const previous = previousSnapshots[current.sourceId];
    const missingStreak = (previous?.missingStreak ?? 0) + 1;

    if (missingStreak >= DELETE_AFTER_MISSING_SYNCS) {
      operations.push({ kind: "delete", eventId: current.id, sourceId: current.sourceId });
      continue;
    }

    nextSnapshots[current.sourceId] = {
      fingerprint: previous?.fingerprint ?? current.fingerprint ?? "unknown",
      missingStreak,
      lastSeenAt: previous?.lastSeenAt ?? nowIso,
      lectioStatus: previous?.lectioStatus ?? current.lectioStatus
    };
    operations.push({ kind: "noop", eventId: current.id, sourceId: current.sourceId });
  }

  return { operations, nextSnapshots };
}
