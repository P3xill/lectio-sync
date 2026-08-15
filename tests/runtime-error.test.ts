import { describe, expect, it } from "vitest";
import { toRuntimeSafeError } from "../src/core/runtime-error";

describe("runtime error serialization", () => {
  it("turns Error subclasses into bounded plain responses", () => {
    const error = Object.assign(new Error("Brave setup guidance"), {
      code: "GOOGLE_AUTH_REQUIRED",
      occurredAt: "2026-08-10T20:00:00.000Z"
    });

    expect(toRuntimeSafeError(error)).toEqual({
      code: "GOOGLE_AUTH_REQUIRED",
      message: "Brave setup guidance",
      occurredAt: "2026-08-10T20:00:00.000Z"
    });
  });

  it("rejects unknown codes and bounds attacker-controlled detail", () => {
    const serialized = toRuntimeSafeError({
      code: "NOT_ALLOWED",
      message: "x".repeat(800),
      technicalDetail: "y".repeat(800)
    });

    expect(serialized.code).toBe("UNKNOWN");
    expect(serialized.message).toHaveLength(500);
    expect(serialized.technicalDetail).toHaveLength(500);
  });
});
