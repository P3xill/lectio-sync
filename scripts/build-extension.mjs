import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.argv[2];
if (!new Set(["chrome", "firefox", "safari"]).has(target)) {
  throw new Error("Usage: node scripts/build-extension.mjs <chrome|firefox|safari>");
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
    __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__: JSON.stringify(
      process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_ID
        ?? "REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_ID.apps.googleusercontent.com"
    )
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
