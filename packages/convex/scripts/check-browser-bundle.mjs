import assert from "node:assert/strict";
import { atob, btoa } from "node:buffer";
import { webcrypto } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true, platform: "browser", format: "iife", globalName: "ConvexProof",
  write: false, metafile: true,
});
for (const input of Object.keys(result.metafile.inputs)) {
  assert.ok(!/(?:^|\/)node:|node_modules\/(?:ws|mongodb|redis|ioredis|prettier|esbuild)\//u.test(input), "browser graph includes a Node driver/tool");
  assert.ok(!/convex\/(?:src|dist\/esm)\/(?:browser|server|cli)\//u.test(input), "browser graph must use only official Convex value helpers");
}
const code = result.outputFiles[0]?.text;
assert.ok(code !== undefined, "browser bundle missing");
const context = createContext({ URL, TextDecoder, TextEncoder, atob, btoa, AbortController, AbortSignal, crypto: webcrypto, performance, setTimeout, clearTimeout });
runInContext(code, context, { timeout: 1000 });
runInContext(`
  let calls = 0;
  const db = new ConvexProof.ConvexDatabase({
    endpoint: "https://owned.convex.cloud",
    token: () => { calls++; throw new Error("token during construction"); },
    fetch: () => { calls++; throw new Error("fetch during construction"); },
    collections: { tasks: { getFunction: "dalgo:getTask" } },
  });
  if (calls !== 0 || db.metadata().provenance !== "trusted-configuration"
      || typeof process !== "undefined" || typeof Buffer !== "undefined"
      || typeof require !== "undefined") throw new Error("entry is not lazy and browser-safe");
`, context, { timeout: 1000 });
