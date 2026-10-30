import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const runtimeEntry = join(packageRoot, "src", "index.ts");
const runtimeDist = join(packageRoot, "dist", "index.js");

const entries = [
  ["@dalgo/adapter-runtime", runtimeEntry],
  ["@dalgo/dalgo2couchdb", join(packagesRoot, "couchdb", "src", "index.ts")],
  ["@dalgo/dalgo2postgrest", join(packagesRoot, "postgrest", "src", "index.ts")],
];
const allEntries = [...entries];
for (const [name, entryPoint] of entries) {
  if (entryPoint === runtimeEntry) continue;
  const dist = join(dirname(entryPoint), "..", "dist", "index.js");
  if (existsSync(dist)) allEntries.push([`${name} (dist)`, dist]);
}
if (existsSync(runtimeDist)) allEntries.push(["@dalgo/adapter-runtime (dist)", runtimeDist]);

for (const [name, entryPoint] of allEntries) {
  const result = await build({
    entryPoints: [entryPoint],
    alias: { "@dalgo/adapter-runtime": runtimeEntry },
    bundle: true,
    external: ["@dalgo/core"],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const bundled = Object.keys(result.metafile.inputs).filter((path) => !path.startsWith("node:"));
  assert.ok(bundled.length > 0, `${name} did not produce a bundle`);
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.ok(
      !input.startsWith("node:") && !input.includes("node_modules/node:"),
      `${name} bundles Node built-in ${input}`,
    );
  }
  const output = result.outputFiles?.[0]?.text ?? "";
  assert.ok(output.length > 0, `${name} produced empty output`);
  assert.ok(
    !/\brequire\(\s*["']node:|\bfrom\s*["']node:|\bimport\(\s*["']node:/.test(output),
    `${name} output references a Node built-in`,
  );
  console.log(`${name}: browser bundle ok (${String(output.length)} bytes)`);
}
