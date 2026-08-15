import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const artifacts = resolve("artifacts");
const archive = resolve(artifacts, "lectio-sync-chrome.zip");
const temporaryArchive = resolve(artifacts, "lectio-sync-chrome.zip.tmp");

const manifest = await readFile(resolve("dist/chrome/manifest.json"), "utf8");
if (manifest.includes("REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID")) {
  throw new Error("Set GOOGLE_OAUTH_CLIENT_ID before creating a release package. See .env.example.");
}

const background = await readFile(resolve("dist/chrome/background.js"), "utf8");
if (background.includes("REPLACE_WITH_BRAVE_WEB_OAUTH_CLIENT_ID")) {
  throw new Error("Set GOOGLE_BRAVE_OAUTH_CLIENT_ID before creating a release package. See .env.example.");
}

await mkdir(artifacts, { recursive: true });
await rm(temporaryArchive, { force: true });
const result = spawnSync("zip", ["-q", "-r", temporaryArchive, ".", "-x", "*.map", "*.svg", ".DS_Store"], {
  cwd: resolve("dist/chrome"),
  stdio: "inherit"
});
if (result.status !== 0) {
  await rm(temporaryArchive, { force: true });
  process.exit(result.status ?? 1);
}
await rename(temporaryArchive, archive);
