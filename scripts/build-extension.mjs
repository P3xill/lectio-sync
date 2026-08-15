import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(resolve(".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const target = process.argv[2];
if (!new Set(["chrome", "firefox", "safari"]).has(target)) {
  throw new Error("Usage: node scripts/build-extension.mjs <chrome|firefox|safari>");
}

const chromiumOauthMode = process.env.CHROMIUM_OAUTH_MODE ?? "auto";
if (!new Set(["auto", "brave", "chrome"]).has(chromiumOauthMode)) {
  throw new Error("CHROMIUM_OAUTH_MODE must be auto, brave, or chrome.");
}

const firefoxClientId = process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_ID
  ?? "REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_ID.apps.googleusercontent.com";
const firefoxClientSecret = process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET
  ?? "REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_SECRET";
const desktopClientIdPattern = /^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/iu;
if (
  target === "firefox"
  && process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_ID
  && !desktopClientIdPattern.test(firefoxClientId)
) {
  throw new Error("GOOGLE_FIREFOX_OAUTH_CLIENT_ID must be a valid Google Desktop OAuth client ID.");
}
if (
  target === "firefox"
  && process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET
  && !/^GOCSPX-[A-Za-z0-9_-]{20,}$/u.test(firefoxClientSecret)
) {
  throw new Error("GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET must be the issued Google Desktop OAuth client secret.");
}

const braveClientId = process.env.GOOGLE_BRAVE_OAUTH_CLIENT_ID
  ?? "REPLACE_WITH_BRAVE_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com";
if (
  target === "chrome"
  && process.env.GOOGLE_BRAVE_OAUTH_CLIENT_ID
  && !desktopClientIdPattern.test(braveClientId)
) {
  throw new Error("GOOGLE_BRAVE_OAUTH_CLIENT_ID must be a valid Google Web application OAuth client ID.");
}

const outdir = resolve(`dist/${target}`);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = {
  bundle: true,
  minify: true,
  sourcemap: target !== "safari",
  platform: "browser",
  target: target === "safari" ? ["safari16"] : target === "firefox" ? ["firefox121"] : ["chrome120"],
  define: {
    __TARGET_BROWSER__: JSON.stringify(target),
    __CHROMIUM_OAUTH_MODE__: JSON.stringify(chromiumOauthMode),
    __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__: JSON.stringify(firefoxClientId),
    __GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET__: JSON.stringify(firefoxClientSecret),
    __GOOGLE_BRAVE_OAUTH_CLIENT_ID__: JSON.stringify(braveClientId)
  },
  logLevel: "info"
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/background.ts"], outfile: `${outdir}/background.js`, format: "iife" }),
  build({ ...shared, entryPoints: ["src/content.ts"], outfile: `${outdir}/content.js`, format: "iife" }),
  build({ ...shared, entryPoints: ["src/popup/main.ts"], outfile: `${outdir}/popup.js`, format: "iife" })
]);

let popup = await readFile("src/popup/popup.html", "utf8");
popup = popup
  .replace('<link rel="stylesheet" href="./styles.css" />', '<link rel="stylesheet" href="popup.css" />')
  .replace('<script type="module" src="./main.ts"></script>', '<script src="popup.js"></script>');
await writeFile(`${outdir}/popup.html`, popup);

await cp("public/icons", `${outdir}/icons`, { recursive: true });
