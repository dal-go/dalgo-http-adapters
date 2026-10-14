// Measures what an app ships for @dalgo/sqlite-wasm/opfs: the main-thread
// entry, the dataset worker (with sqlite-wasm's JavaScript) and sqlite3.wasm.
// Run after `pnpm build`: node test/browser/bundle-size.ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function bundle(entry: string, external: string[]): Promise<Uint8Array> {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external,
    write: false,
    logLevel: "warning",
  });
  return (result.outputFiles[0] as { contents: Uint8Array }).contents;
}

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;
const row = (name: string, bytes: Uint8Array): string => {
  const gzip = gzipSync(bytes, { level: 9 }).length;
  const brotli = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  return `| ${name} | ${kib(bytes.length)} | ${kib(gzip)} | ${kib(brotli)} |`;
};

const require = createRequire(import.meta.url);
const wasm = new Uint8Array(readFileSync(join(dirname(require.resolve("@sqlite.org/sqlite-wasm")), "sqlite3.wasm")));
console.log("| Asset | Raw (minified) | gzip -9 | brotli 11 |");
console.log("| --- | --- | --- | --- |");
console.log(row("`/opfs` main-thread entry (`@dalgo/core` external)", await bundle("dist/opfs/index.js", ["@dalgo/core"])));
console.log(row("dataset worker (`/opfs/worker` + sqlite-wasm JS)", await bundle("dist/opfs/worker.js", [])));
console.log(row("`sqlite3.wasm`", wasm));
