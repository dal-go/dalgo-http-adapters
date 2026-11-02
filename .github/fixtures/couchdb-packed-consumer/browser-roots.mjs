// The fixture itself uses Node, but only the browser-platform bundle enters VM.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createContext, Script, SourceTextModule } from "node:vm";
let fetches = 0; let workers = 0;
const context = createContext({
  URL, btoa, atob, crypto, TextEncoder, TextDecoder, AbortController, AbortSignal, performance,
  Request, Response, Headers, ReadableStream, setTimeout, clearTimeout,
  fetch() { fetches++; throw new Error("unexpected browser fixture fetch"); },
  Worker: class { constructor() { workers++; throw new Error("unexpected worker"); } },
});
const absent = new Script("typeof process === 'undefined' && typeof Buffer === 'undefined' && typeof require === 'undefined' && typeof global === 'undefined'");
assert.equal(absent.runInContext(context), true);
assert.throws(() => new Script("process").runInContext(context), { name: "ReferenceError" });
assert.throws(() => new Script("Buffer").runInContext(context), { name: "ReferenceError" });
const module = new SourceTextModule(readFileSync(new URL("./browser-bundle.mjs", import.meta.url), "utf8"), { context, identifier: "https://app.example.test/couchdb-bundle.mjs", importModuleDynamically() { throw new Error("no external dynamic exception is allowed"); } });
await module.link(() => { throw new Error("unexpected browser static external"); });
await module.evaluate({ timeout: 5000 });
assert.deepEqual(JSON.parse(JSON.stringify(await module.namespace.verifyBrowserRoots())), { coreAndErrorIdentity: true, lazy: true });
assert.equal(absent.runInContext(context), true);
const blocked = error => error?.code === "ERR_NATIVE_PACKED_BROWSER_IMPORT";
await assert.rejects(import("mongodb"), blocked);
const fromAdapter = createRequire(import.meta.resolve("@dalgo/dalgo2couchdb"));
assert.throws(() => fromAdapter("node:net"), blocked, "actual package graph must reject CommonJS builtins too");
assert.equal(fetches, 0); assert.equal(workers, 0);
console.log(JSON.stringify({ packageGraphGuard: true, guardNegativeControls: true, coreAndErrorIdentity: true, lazy: true, fetches, workers }));
