export const MIN_CHECK_INTERVAL_MINUTES = 5;
export const MAX_CHECK_INTERVAL_MINUTES = 1_440;
export const CALENDAR_COLOR_OPTIONS = [
  { name: "Red", value: "#FF3B30" },
  { name: "Orange", value: "#FF9500" },
  { name: "Yellow", value: "#FFCC00" },
  { name: "Green", value: "#34C759" },
  { name: "Blue", value: "#007AFF" },
  { name: "Purple", value: "#AF52DE" },
  { name: "Brown", value: "#A2845E" }
] as const;
export const DEFAULT_CALENDAR_COLOR = "#007AFF";
const CALENDAR_COLORS = new Set<string>(CALENDAR_COLOR_OPTIONS.map((option) => option.value));

export function sanitizeIntervalMinutes(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_CHECK_INTERVAL_MINUTES
    && value <= MAX_CHECK_INTERVAL_MINUTES
    ? value
    : fallback;
}

export function sanitizeCalendarColor(value: unknown, fallback = DEFAULT_CALENDAR_COLOR): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.toUpperCase();
  if (normalized === "#0A84FF") return DEFAULT_CALENDAR_COLOR;
  return CALENDAR_COLORS.has(normalized) ? normalized : fallback;
}
