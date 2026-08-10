import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const artifacts = resolve("artifacts");
const archive = resolve(artifacts, "lectio-sync-chrome.zip");
await mkdir(artifacts, { recursive: true });
await rm(archive, { force: true });

const manifest = await readFile(resolve("dist/chrome/manifest.json"), "utf8");
if (manifest.includes("REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID")) {
  throw new Error("Set GOOGLE_OAUTH_CLIENT_ID before creating a release package. See .env.example.");
}

const result = spawnSync("zip", ["-q", "-r", archive, ".", "-x", "*.map", "*.svg", ".DS_Store"], {
  cwd: resolve("dist/chrome"),
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status ?? 1);
