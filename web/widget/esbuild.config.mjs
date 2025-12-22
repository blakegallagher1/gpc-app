/**
 * esbuild configuration for ChatGPT Apps SDK skybridge bundle
 *
 * Bundles the React widget into a single JS file that can be
 * loaded directly in ChatGPT's widget iframe without Next.js runtime.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [resolve(__dirname, "src/skybridge-entry.tsx")],
  bundle: true,
  outfile: resolve(__dirname, "public/skybridge.js"),
  format: "iife",
  platform: "browser",
  target: ["es2020", "chrome90", "firefox90", "safari14"],
  minify: !isWatch,
  sourcemap: isWatch ? "inline" : false,
  define: {
    "process.env.NODE_ENV": isWatch ? '"development"' : '"production"',
  },
  alias: {
    "@": resolve(__dirname, "src"),
  },
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
    ".css": "css",
  },
  jsx: "automatic",
  logLevel: "info",
};

async function build() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    const result = await esbuild.build(buildOptions);
    console.log("Build complete:", result);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
