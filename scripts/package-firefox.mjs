import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const artifacts = resolve("artifacts");
const archive = resolve(artifacts, "lectio-sync-firefox.zip");
const temporaryArchive = resolve(artifacts, "lectio-sync-firefox.zip.tmp");

const background = await readFile(resolve("dist/firefox/background.js"), "utf8");
if (
  background.includes("REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_ID")
  || background.includes("REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_SECRET")
) {
  throw new Error("Set the Firefox Desktop OAuth client ID and issued client secret before packaging. See .env.example.");
}

await mkdir(artifacts, { recursive: true });
await rm(temporaryArchive, { force: true });
const result = spawnSync("zip", ["-q", "-r", temporaryArchive, ".", "-x", "*.map", "*.svg", ".DS_Store"], {
  cwd: resolve("dist/firefox"),
  stdio: "inherit"
});
if (result.status !== 0) {
  await rm(temporaryArchive, { force: true });
  process.exit(result.status ?? 1);
}
await rename(temporaryArchive, archive);
