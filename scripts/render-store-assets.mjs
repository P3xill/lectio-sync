import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "store-assets/render/index.html");
const outputDir = resolve(projectRoot, "store-assets/exports");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const exports = [
  { filename: "browser-store-screenshot-1280x800.png", width: 1280, height: 800, mode: "browser" },
  { filename: "mac-app-store-screenshot-1280x800.png", width: 1280, height: 800, mode: "safari" },
  { filename: "chrome-small-promo-440x280.png", width: 440, height: 280, mode: "small" },
  { filename: "chrome-marquee-1400x560.png", width: 1400, height: 560, mode: "marquee" },
  { filename: "social-preview-1200x630.png", width: 1200, height: 630, mode: "social" },
];

mkdirSync(outputDir, { recursive: true });

for (const item of exports) {
  const output = resolve(outputDir, item.filename);
  const url = `${pathToFileURL(source).href}?mode=${item.mode}`;
  execFileSync(chrome, [
    "--headless=new",
    "--hide-scrollbars",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    `--window-size=${item.width},${item.height}`,
    `--screenshot=${output}`,
    url,
  ], { stdio: "ignore" });
}

execFileSync("cp", [resolve(projectRoot, "public/icons/icon-128.png"), resolve(outputDir, "store-icon-128.png")]);

const manifest = [...exports, { filename: "store-icon-128.png", width: 128, height: 128, mode: "source" }].map((item) => {
  const contents = readFileSync(resolve(outputDir, item.filename));
  return {
    file: item.filename,
    width: item.width,
    height: item.height,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
});
writeFileSync(resolve(outputDir, "manifest.json"), `${JSON.stringify({ version: "0.2.0", generated: "2026-08-15", assets: manifest }, null, 2)}\n`);

console.log(`Rendered ${exports.length + 1} store assets to ${outputDir}`);
