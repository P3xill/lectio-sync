import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("popup recovery", () => {
  it("reopens interactive Google authorization after a connection failure", async () => {
    const popup = await readFile("src/popup/main.ts", "utf8");
    expect(popup).toContain('state.status === "google_disconnected"');
    expect(popup).toContain('send<ExtensionState>({ type: "CONNECT_GOOGLE" })');
    expect(popup).toContain('googleDisconnected ? `Reconnect ${calendarStatusLabel}`');
  });

  it("performs a real Lectio check before refreshing an expired state", async () => {
    const popup = await readFile("src/popup/main.ts", "utf8");
    const recoveryHandler = popup.slice(
      popup.indexOf("function recoveryView"),
      popup.indexOf("function settingsView")
    );

    expect(recoveryHandler).toContain('send({ type: "CHECK_LECTIO" })');
    expect(recoveryHandler).toContain('send<ExtensionState>({ type: "GET_STATE" })');
    expect(recoveryHandler.indexOf('"CHECK_LECTIO"')).toBeLessThan(
      recoveryHandler.indexOf('"GET_STATE"')
    );
  });

  it("refreshes recovery state even when a retry fails", async () => {
    const popup = await readFile("src/popup/main.ts", "utf8");
    expect(popup).toMatch(/try \{\s*await send\(\{ type: "SYNC_NOW" \}\);\s*\} finally \{\s*state = await send<ExtensionState>\(\{ type: "GET_STATE" \}\);/);
  });

  it("keeps the setup preview state valid after opening Lectio", async () => {
    const popup = await readFile("src/popup/main.ts", "utf8");
    expect(popup).toContain('if (message.type === "START_LECTIO_SETUP") return state as T;');
  });
});
