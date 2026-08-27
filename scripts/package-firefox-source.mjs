import { mkdir, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const artifacts = resolve("artifacts");
const archive = resolve(artifacts, "lectio-sync-firefox-source.zip");
const temporaryArchive = resolve(artifacts, "lectio-sync-firefox-source.zip.tmp");
const sourcePaths = [
  ".env.example",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "manifests",
  "package-lock.json",
  "package.json",
  "public",
  "scripts",
  "src",
  "tsconfig.json",
  "vite.config.ts"
];

await mkdir(artifacts, { recursive: true });
await rm(temporaryArchive, { force: true });
const result = spawnSync("zip", [
  "-q",
  "-r",
  temporaryArchive,
  ...sourcePaths,
  "-x",
  "*.DS_Store",
  "*.map",
  "artifacts/*",
  "dist/*",
  "node_modules/*"
], { stdio: "inherit" });
if (result.status !== 0) {
  await rm(temporaryArchive, { force: true });
  process.exit(result.status ?? 1);
}
await rename(temporaryArchive, archive);
