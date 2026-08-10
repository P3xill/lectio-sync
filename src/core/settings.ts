export const MIN_CHECK_INTERVAL_MINUTES = 5;
export const MAX_CHECK_INTERVAL_MINUTES = 1_440;

export function sanitizeIntervalMinutes(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_CHECK_INTERVAL_MINUTES
    && value <= MAX_CHECK_INTERVAL_MINUTES
    ? value
    : fallback;
}
