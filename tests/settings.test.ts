import { describe, expect, it } from "vitest";
import {
  MAX_CHECK_INTERVAL_MINUTES,
  MIN_CHECK_INTERVAL_MINUTES,
  sanitizeIntervalMinutes
} from "../src/core/settings";

describe("check interval settings", () => {
  it.each([5, 17, 37, 1_440])("accepts a custom whole-minute interval: %s", (value) => {
    expect(sanitizeIntervalMinutes(value, 10)).toBe(value);
  });

  it.each([4, 1_441, 5.5, Number.NaN, "30", undefined])("rejects an unsafe interval: %s", (value) => {
    expect(sanitizeIntervalMinutes(value, 10)).toBe(10);
  });

  it("keeps documented bounds stable", () => {
    expect(MIN_CHECK_INTERVAL_MINUTES).toBe(5);
    expect(MAX_CHECK_INTERVAL_MINUTES).toBe(1_440);
  });
});
