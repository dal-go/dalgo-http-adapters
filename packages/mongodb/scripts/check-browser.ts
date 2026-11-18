import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { readFile } from "node:fs/promises";

const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (manifest === null || typeof manifest !== "object" || !("exports" in manifest)) throw new Error("missing package exports");
// The root and /browser exports must keep the same safe entry. /node is the
// sole driver entry and must never be substituted for either browser export.
const exports = manifest.exports as Record<string, { readonly import?: unknown }>;
if (exports["."]?.import !== "./dist/index.js" || exports["./browser"]?.import !== "./dist/index.js" || exports["./node"]?.import !== "./dist/node.js") throw new Error("MongoDB runtime entry boundary changed");
const result = await build({
  entryPoints: [new URL("../dist/index.js", import.meta.url).pathname],
  platform: "browser", bundle: true, format: "esm", write: false, metafile: true,
});
for (const [name, input] of Object.entries(result.metafile.inputs)) {
  if (/(?:^|\/)node_modules\/(?:mongodb|bson|socks|kerberos|mongodb-client-encryption)(?:\/|$)/u.test(name)
    || /(?:^|\/)node-executor\.[jt]s$/u.test(name)) throw new Error(`server MongoDB dependency entered browser output: ${name}`);
  for (const imported of input.imports) {
    if (imported.path.startsWith("node:") || isBuiltin(imported.path)) throw new Error(`Node builtin entered browser output: ${imported.path}`);
  }
}
const bytes = result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
console.log(`MongoDB browser entry: ${String(Object.keys(result.metafile.inputs).length)} inputs, ${String(bytes)} bytes; no server driver or Node builtin`);
