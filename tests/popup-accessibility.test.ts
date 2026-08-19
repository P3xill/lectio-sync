import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16)) ?? [];
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red, green, blue] = linear as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastAgainstWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

describe("popup accessibility", () => {
  it("declares a stable 400 pixel browser popup width", async () => {
    const styles = await readFile("src/popup/styles.css", "utf8");
    expect(styles).toMatch(/html\s*\{[\s\S]*?min-width:\s*400px;[\s\S]*?width:\s*400px;/);
    expect(styles).toMatch(/body\s*\{[\s\S]*?min-width:\s*400px;[\s\S]*?width:\s*400px;/);
    expect(styles).not.toMatch(/max-width:\s*100vw/);
  });

  it("keeps focus and control boundaries above 3:1 against white", async () => {
    const styles = await readFile("src/popup/styles.css", "utf8");
    const border = styles.match(/--border:\s*(#[0-9a-f]{6})/i)?.[1];
    const focus = styles.match(/--blue:\s*(#[0-9a-f]{6})/i)?.[1];
    const switchOff = styles.match(/\.switch-track\s*\{[^}]*background:\s*(#[0-9a-f]{6})/i)?.[1];

    expect(border).toBeDefined();
    expect(focus).toBeDefined();
    expect(switchOff).toBeDefined();
    expect(contrastAgainstWhite(border!)).toBeGreaterThanOrEqual(3);
    expect(contrastAgainstWhite(focus!)).toBeGreaterThanOrEqual(3);
    expect(contrastAgainstWhite(switchOff!)).toBeGreaterThanOrEqual(3);
    expect(styles).toContain("outline: 3px solid var(--blue)");
  });

  it("uses focused status messages instead of a whole-app live region", async () => {
    const [html, popup] = await Promise.all([
      readFile("src/popup/popup.html", "utf8"),
      readFile("src/popup/main.ts", "utf8")
    ]);

    expect(html).not.toContain("aria-live");
    expect(popup).toContain('attrs: { role: transientIsError ? "alert" : "status" }');
  });

  it("restores focus after popup view navigation", async () => {
    const popup = await readFile("src/popup/main.ts", "utf8");
    expect(popup).toContain("function focusPendingTarget()");
    expect(popup).toContain('target.focus({ preventScroll: true })');
    expect(popup).toContain('data-focus-key", "view-details"');
    expect(popup).toContain('"data-focus-key": "settings-menu"');
  });
});
