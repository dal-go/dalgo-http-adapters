import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.exports["."].import !== "./dist/index.js" || manifest.exports["./binding"].import !== "./dist/index.js" || manifest.exports["./browser"].import !== "./dist/browser.js" || manifest.exports["./node"].import !== "./dist/node.js") throw new Error("KV runtime boundary changed");
for (const entry of ["index", "browser"]) {
  const result = await build({ entryPoints: [new URL(`../dist/${entry}.js`, import.meta.url).pathname], platform: "browser", conditions: ["browser"], bundle: true, format: "esm", write: false, metafile: true });
  for (const [name, input] of Object.entries(result.metafile.inputs)) {
    if (/(?:^|\/)(?:node-fetch|rest)\.[jt]s$/u.test(name) || /(?:^|\/)node_modules\/(?:@cloudflare|undici|mongodb|@aws-sdk)(?:\/|$)/u.test(name)) throw new Error(`server dependency in KV browser graph: ${name}`);
    for (const imported of input.imports) if (isBuiltin(imported.path) || imported.path.startsWith("node:") || imported.external) throw new Error(`non-browser KV dependency: ${imported.path}`);
  }
  process.stdout.write(`KV ${entry}: ${String(Object.keys(result.metafile.inputs).length)} browser inputs, ${String(result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0))} bytes; no Node/REST/provider SDK\n`);
}
