import { describe, expect, it } from "vitest";
import { base32Hex, stableGoogleEventId } from "../src/core/crypto";

describe("Google event identity", () => {
  it("encodes bytes as lowercase base32hex", () => {
    expect(base32Hex(new Uint8Array([0xff, 0x00]))).toBe("vs00");
  });

  it("is deterministic, private, and valid for Google event ids", async () => {
    const first = await stableGoogleEventId("23", "42", "absid:1001");
    const second = await stableGoogleEventId("23", "42", "absid:1001");
    const other = await stableGoogleEventId("23", "42", "absid:1002");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(first).not.toContain("1001");
  });
});
