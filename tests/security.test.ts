import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SKIPPED_SOURCE_DIRECTORIES = new Set([".build", ".git", "artifacts", "dist", "node_modules"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    if (entry.isDirectory() && SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat();
}

describe("extension security posture", () => {
  it.each(["chrome", "firefox", "safari"])("keeps the %s manifest least-privilege", async (target) => {
    const manifest = JSON.parse(await readFile(`manifests/manifest.${target}.json`, "utf8"));
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("webRequest");
    expect(manifest.host_permissions.every((host: string) => host.startsWith("https://"))).toBe(true);
    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.content_security_policy.extension_pages).toContain("object-src 'none'");
    expect(manifest.content_security_policy.extension_pages).not.toContain("unsafe-eval");
    expect(manifest.content_security_policy.extension_pages).not.toContain("unsafe-inline");
    expect(manifest.permissions).not.toContain("unlimitedStorage");
  });

  it("contains no committed private keys or OAuth client secrets", async () => {
    const files = (await sourceFiles(".")).filter((path) =>
      !path.includes("node_modules")
      && !path.includes("dist/")
      && !path.includes(".build/")
      && !path.includes("artifacts/")
      && !path.endsWith("package-lock.json")
      && !path.endsWith(".png")
    );
    const contents = await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")] as const));
    for (const [path, content] of contents) {
      expect(content, path).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
      expect(content, path).not.toMatch(/client_secret\s*[=:]\s*["'][^"']+/i);
    }
  });

  it("authorizes Safari calendar operations with a native ownership record", async () => {
    const handler = await readFile("safari-native/SafariWebExtensionHandler.swift", "utf8");
    expect(handler).toContain("LectioSyncOwnedCalendarIdentifierV1");
    expect(handler).toContain("ownedCalendar(withIdentifier: calendarId)");
    expect(handler).toContain("UserDefaults.standard.set(calendar.calendarIdentifier");
    expect(handler).toContain("preferredGoogleSourceIdentifiers()");
    expect(handler).toContain("defaultCalendarForNewEvents?.source");
    expect(handler).toContain("$0.allowsContentModifications && !$0.isSubscribed");
    expect(handler).not.toMatch(/eventStore\.calendars\(for: \.event\)\.first/);
  });

  it("discards staged Safari EventKit changes when a batch fails", async () => {
    const handler = await readFile("safari-native/SafariWebExtensionHandler.swift", "utf8");
    expect(handler).toContain("private let maximumOperations = 500");
    expect(handler).toMatch(/catch \{\s*eventStore\.reset\(\)\s*throw error\s*\}/);
  });

  it("requires the Safari marker source to match every update and delete", async () => {
    const handler = await readFile("safari-native/SafariWebExtensionHandler.swift", "utf8");
    expect(handler.match(/marker\.sourceId == sourceId/g)).toHaveLength(2);
    expect(handler).toContain("refused to update an event it does not own");
    expect(handler).toContain("refused to remove an event it does not own");
  });

  it("generates required Safari App Store metadata", async () => {
    const converter = await readFile("scripts/convert-safari.mjs", "utf8");
    expect(converter).toContain('"LSApplicationCategoryType", "public.app-category.productivity"');
    expect(converter).toContain('"NSHumanReadableCopyright", "Copyright © 2026 Johannes Nørgaard Peulicke"');
  });

  it("does not generate source maps for Safari conversion", async () => {
    const buildScript = await readFile("scripts/build-extension.mjs", "utf8");
    expect(buildScript).toContain('sourcemap: target !== "safari"');
  });

  it("validates account-discovery messages against their Lectio sender", async () => {
    const background = await readFile("src/background.ts", "utf8");
    expect(background).toContain("parseRuntimeMessage(value)");
    expect(background).toContain("lectioSenderUrl(sender)");
    expect(background).toContain("schoolId !== schoolIdFromUrl(message.url)");
    expect(background).not.toContain("handleMessage(message as RuntimeMessage)");
  });

  it("revalidates Safari's live Lectio tab before reporting a connection", async () => {
    const background = await readFile("src/background.ts", "utf8");
    expect(background).toContain('case "GET_STATE":\n        return { ok: true, data: await refreshLectioConnection() };');
    expect(background).toContain("browser.tabs.onRemoved.addListener");
    expect(background).toContain("browser.tabs.onUpdated.addListener");
    expect(background).toContain("await browser.alarms.clear(ALARM_NAME)");
    expect(background).toContain("restoreSafariCalendarConnection(await getState())");
    expect(background).toContain("return await connectCalendar(false)");
  });
});
