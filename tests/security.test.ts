import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
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
    expect(handler).not.toMatch(/eventStore\.calendars\(for: \.event\)\.first/);
  });

  it("does not generate source maps for Safari conversion", async () => {
    const buildScript = await readFile("scripts/build-extension.mjs", "utf8");
    expect(buildScript).toContain('sourcemap: target !== "safari"');
  });
});
