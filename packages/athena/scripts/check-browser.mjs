import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ stdin: { contents: 'import { AthenaNativeClient, AthenaError } from "./src/index.ts"; import { AthenaHttpClient } from "./src/browser.ts"; export { AthenaNativeClient, AthenaHttpClient, AthenaError };', resolveDir: process.cwd(), sourcefile: "athena-browser-entry.ts" }, platform: "browser", format: "esm", target: "es2022", bundle: true, write: false, metafile: true, logLevel: "silent" });
assert.equal(result.errors.length, 0);
for (const input of Object.keys(result.metafile.inputs)) assert(!/(?:node:|@smithy|node_modules\/(?:mongodb|@aws-sdk)|src\/node\.ts)/u.test(input), "browser graph imported server signing/driver code");
for (const output of Object.values(result.metafile.outputs)) assert.equal(output.imports.length, 0, "browser graph has external imports");
const text = result.outputFiles[0]?.text;
assert.equal(typeof text, "string"); assert(!/from ["']node:|require\(["']node:/u.test(text));
process.stdout.write("Athena pure root/browser graph PASS; no actual browser query claimed\n");
