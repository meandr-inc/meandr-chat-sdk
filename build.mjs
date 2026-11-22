import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";

const target = "es2019";
// A name ending in _ is internal, and every build shortens it, the npm one too: an app's
// bundler never renames properties. Nothing public, and nothing sent to the chat, ends in _.
const mangleProps = /_$/;

// What a page ships, minified and gzipped, in bytes; the build fails past these.
const budgets = {
  "src/index.ts": 12600,
  "src/markdown.ts": 6700,
  "src/global.ts": 19200,
};

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts", "src/markdown.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  target,
  mangleProps,
  sourcemap: true,
  chunkNames: "chunk-[hash]",
});

// The script file: window.MeandrChat, for pages without a bundler.
await build({
  entryPoints: ["src/global.ts"],
  outfile: "dist/meandr-chat.js",
  bundle: true,
  format: "iife",
  globalName: "MeandrChat",
  target,
  mangleProps,
  minify: true,
  sourcemap: true,
});

execFileSync("node_modules/.bin/tsc", ["--emitDeclarationOnly"], { stdio: "inherit" });

// The script tag's integrity attribute, for the release notes and the README.
const sri = "sha384-" + createHash("sha384").update(readFileSync("dist/meandr-chat.js")).digest("base64");
console.log("dist/meandr-chat.js integrity", sri);

let over = false;
for (const [entry, budget] of Object.entries(budgets)) {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", target, mangleProps, minify: true, write: false });
  const size = gzipSync(out.outputFiles[0].contents).length;
  console.log(entry, size, "bytes minified and gzipped, budget", budget);
  if (size > budget) over = true;
}
if (over) {
  console.error("over budget");
  process.exit(1);
}
