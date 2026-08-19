import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(resolve(".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const target = process.argv[2];
if (!new Set(["chrome", "firefox", "safari"]).has(target)) {
  throw new Error("Usage: node scripts/build-manifest.mjs <chrome|firefox|safari>");
}

const templatePath = resolve(`manifests/manifest.${target}.json`);
const outputPath = resolve(`dist/${target}/manifest.json`);
let manifest = await readFile(templatePath, "utf8");

if (target === "chrome") {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ??
    "REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com";
  if (
    process.env.GOOGLE_OAUTH_CLIENT_ID
    && !/^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/iu.test(clientId)
  ) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID must be a valid Google Chrome Extension OAuth client ID.");
  }
  manifest = manifest.replaceAll("__GOOGLE_OAUTH_CLIENT_ID__", clientId);
}

await writeFile(outputPath, `${manifest.trim()}\n`, { mode: 0o644 });
