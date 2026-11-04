// Owned Node test runner. Only the browser-platform bundle enters the separate
// browser-like realm; Node globals are absent there, not replaced by polyfills.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createContext, Script, SourceTextModule } from "node:vm";
let fetches = 0;
let workers = 0;
let dynamicImports = 0;
const context = createContext({
  URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
  Request, Response, Headers, ReadableStream, WritableStream, TransformStream,
  setTimeout, clearTimeout, location: new URL("https://app.example.test/fixture"),
  fetch() { fetches++; throw new Error("unexpected fixture fetch"); },
  Worker: class { constructor() { workers++; throw new Error("unexpected fixture worker"); } },
});
const absentNodeGlobals = new Script("typeof process === 'undefined' && typeof Buffer === 'undefined' && typeof require === 'undefined' && typeof global === 'undefined'");
assert.equal(absentNodeGlobals.runInContext(context), true);
const module = new SourceTextModule(readFileSync(new URL("./browser-bundle.mjs", import.meta.url), "utf8"), {
  context, identifier: "https://app.example.test/browser-bundle.mjs",
  initializeImportMeta(meta) { meta.url = "https://app.example.test/browser-bundle.mjs"; },
  importModuleDynamically() { dynamicImports++; throw new Error("optional engine import executed before selection/query dispatch"); },
});
await module.link(() => { throw new Error("unexpected static external in packed browser bundle"); });
await module.evaluate({ timeout: 10_000 });
const browser = JSON.parse(JSON.stringify(await module.namespace.verifyBrowserRoots()));
assert.deepEqual(browser, { coreIdentity: true, duckLazyRootAndBrowser: true });
assert.equal(absentNodeGlobals.runInContext(context), true);
assert.equal(dynamicImports, 0, "lazy optional engine must not execute on import/construction/preabort");

// Negative controls ensure a real adapter Node builtin and lazy engine imports
// are rejected by this loader, rather than merely absent from node_modules.
const blocked = error => error?.code === "ERR_NATIVE_PACKED_BROWSER_IMPORT";
await assert.rejects(import("@dalgo/dalgo2redis-resp/node"), blocked);
await assert.rejects(import("mongodb"), blocked);
await assert.rejects(import("@duckdb/duckdb-wasm"), blocked);
const requireFromAdapter = createRequire(import.meta.resolve("@dalgo/dalgo2redis-resp"));
assert.throws(() => requireFromAdapter("node:net"), blocked, "CommonJS requires in the package graph must be guarded too");
assert.equal(fetches, 0);
assert.equal(workers, 0);
console.log(JSON.stringify({ packageGraphGuard: true, guardNegativeControls: true, coreIdentity: true, duckLazyRootAndBrowser: true, fetches, workers }));
