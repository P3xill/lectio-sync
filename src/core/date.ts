const COPENHAGEN_TIME_ZONE = "Europe/Copenhagen";
const COPENHAGEN_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: COPENHAGEN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export interface IsoWeek {
  week: number;
  year: number;
  monday: Date;
}

export function getIsoWeek(date: Date): IsoWeek {
  const parts = COPENHAGEN_DATE_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const utc = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const monday = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const originalDay = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - originalDay + 1);
  return { week, year: utc.getUTCFullYear(), monday };
}

export function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * 7 * 86_400_000);
}

export function lectioWeekValue(date: Date): string {
  const { week, year } = getIsoWeek(date);
  return `${String(week).padStart(2, "0")}${year}`;
}

export function getFetchWeekOffsets(initialSync: boolean, horizonWeeks: number, rotationCursor: number): number[] {
  if (initialSync) {
    return [0, 1, 2].filter((offset) => offset <= horizonWeeks);
  }

  const near = [0, 1, 2];
  if (horizonWeeks <= 2) return near.filter((offset) => offset <= horizonWeeks);
  const distantCount = horizonWeeks - 2;
  const rotating = 3 + (rotationCursor % distantCount);
  return [...near, rotating];
}

export function formatCopenhagenDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COPENHAGEN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

export function formatDisplayTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COPENHAGEN_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

export function formatDisplayDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COPENHAGEN_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

export { COPENHAGEN_TIME_ZONE };
