import assert from "node:assert/strict";
import { atob, btoa } from "node:buffer";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true, platform: "browser", format: "iife", globalName: "UpstashProof",
  write: false, metafile: true,
});
for (const input of Object.keys(result.metafile.inputs)) {
  assert.ok(!/redis-resp\/(?:src|dist)\/(?:node|server)\.[jt]s$/u.test(input), "Upstash browser entry includes a TCP/server module");
  assert.ok(!/(?:^|\/)node:|node_modules\/(?:mongodb|redis|ioredis)\//u.test(input), "Upstash browser entry includes a Node driver");
}
const code = result.outputFiles[0]?.text;
assert.ok(code !== undefined, "browser bundle missing");
const context = createContext({ URL, TextDecoder, TextEncoder, atob, btoa, AbortController, performance, setTimeout, clearTimeout });
runInContext(code, context, { timeout: 1000 });
runInContext(`
  let calls = 0;
  new UpstashProof.UpstashRedisExecutor({
    endpoint: 'https://fixture.upstash.io',
    token: () => { calls++; throw new Error('token called during construction'); },
    fetch: () => { calls++; throw new Error('fetch called during construction'); },
  });
  if (calls !== 0 || typeof process !== 'undefined' || typeof Buffer !== 'undefined' || typeof require !== 'undefined') {
    throw new Error('browser entry is not lazy or requires Node globals');
  }
`, context, { timeout: 1000 });
