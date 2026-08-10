import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  manifest = manifest.replaceAll("__GOOGLE_OAUTH_CLIENT_ID__", clientId);
}

await writeFile(outputPath, `${manifest.trim()}\n`, { mode: 0o644 });
