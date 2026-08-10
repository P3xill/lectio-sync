import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const artifacts = resolve("artifacts");
const archive = resolve(artifacts, "lectio-sync-firefox.zip");
await mkdir(artifacts, { recursive: true });
await rm(archive, { force: true });

const background = await readFile(resolve("dist/firefox/background.js"), "utf8");
if (background.includes("REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_ID")) {
  throw new Error("Set GOOGLE_FIREFOX_OAUTH_CLIENT_ID before creating a release package. See .env.example.");
}

const result = spawnSync("zip", ["-q", "-r", archive, ".", "-x", "*.map", "*.svg", ".DS_Store"], {
  cwd: resolve("dist/firefox"),
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status ?? 1);
