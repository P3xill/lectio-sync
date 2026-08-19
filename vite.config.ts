import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.TARGET_BROWSER ?? "chrome";
const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: ".",
  publicDir: "public",
  define: {
    __TARGET_BROWSER__: JSON.stringify(target),
    __CHROMIUM_OAUTH_MODE__: JSON.stringify(process.env.CHROMIUM_OAUTH_MODE ?? "auto"),
    __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__: JSON.stringify(
      process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_ID
        ?? "REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_ID.apps.googleusercontent.com"
    ),
    __GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET__: JSON.stringify(
      process.env.GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET ?? "unit-fixture-desktop-secret"
    ),
    __GOOGLE_BRAVE_OAUTH_CLIENT_ID__: JSON.stringify(
      process.env.GOOGLE_BRAVE_OAUTH_CLIENT_ID
        ?? "REPLACE_WITH_BRAVE_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com"
    )
  },
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(rootDirectory, "src/popup/popup.html"),
        background: resolve(rootDirectory, "src/background.ts"),
        content: resolve(rootDirectory, "src/content.ts")
      },
      output: {
        entryFileNames: (chunkInfo) => `${chunkInfo.name}.js`,
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  },
  test: {
    environment: "node",
    exclude: ["website/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/core/**/*.ts"],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85
      }
    }
  }
});
