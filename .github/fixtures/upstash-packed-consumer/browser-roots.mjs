// Only the bundle enters the browser-like realm; Node types/globals are absent.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createContext, Script, SourceTextModule } from "node:vm";
let fetches = 0; let workers = 0;
const context = createContext({
  URL, TextEncoder, TextDecoder, AbortController, AbortSignal, performance, atob, btoa,
  Request, Response, Headers, ReadableStream, setTimeout, clearTimeout,
  fetch() { fetches++; throw new Error("unexpected browser fixture fetch"); },
  Worker: class { constructor() { workers++; throw new Error("unexpected worker"); } },
});
const absent = new Script("typeof process === 'undefined' && typeof Buffer === 'undefined' && typeof require === 'undefined' && typeof global === 'undefined'");
assert.equal(absent.runInContext(context), true);
assert.throws(() => new Script("process").runInContext(context), { name: "ReferenceError" });
assert.throws(() => new Script("Buffer").runInContext(context), { name: "ReferenceError" });
const module = new SourceTextModule(readFileSync(new URL("./browser-bundle.mjs", import.meta.url), "utf8"), {
  context, identifier: "https://app.example.test/upstash-bundle.mjs",
  importModuleDynamically() { throw new Error("browser bundle must have no external dynamic exception"); },
});
await module.link(() => { throw new Error("unexpected static external in packed browser bundle"); });
await module.evaluate({ timeout: 5000 });
assert.deepEqual(JSON.parse(JSON.stringify(await module.namespace.verifyBrowserRoots())), { publicErrorIdentity: true, lazy: true });
assert.equal(absent.runInContext(context), true);
const blocked = error => error?.code === "ERR_NATIVE_PACKED_BROWSER_IMPORT";
await assert.rejects(import("@dalgo/dalgo2redis-resp/node"), blocked);
await assert.rejects(import("mongodb"), blocked);
const fromAdapter = createRequire(import.meta.resolve("@dalgo/dalgo2upstash-redis"));
assert.throws(() => fromAdapter("node:net"), blocked, "actual CJS graph hook must reject builtins too");
assert.equal(fetches, 0); assert.equal(workers, 0);
console.log(JSON.stringify({ packageGraphGuard: true, guardNegativeControls: true, publicErrorIdentity: true, lazy: true, fetches, workers }));
