// Only this fixture uses Node; the package bundle enters a realm without Node.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createContext, Script, SourceTextModule } from "node:vm";
let fetches = 0, workers = 0;
const context = createContext({
  URL, TextEncoder, TextDecoder, AbortController, AbortSignal, crypto: webcrypto, performance, atob, btoa,
  Request, Response, Headers, ReadableStream, setTimeout, clearTimeout,
  fetch() { fetches++; throw new Error("unexpected browser fixture fetch"); },
  Worker: class { constructor() { workers++; throw new Error("unexpected browser worker"); } },
});
const absent = new Script("typeof process === 'undefined' && typeof Buffer === 'undefined' && typeof require === 'undefined' && typeof global === 'undefined'");
assert.equal(absent.runInContext(context), true);
assert.throws(() => new Script("process").runInContext(context), { name: "ReferenceError" });
assert.throws(() => new Script("Buffer").runInContext(context), { name: "ReferenceError" });
const module = new SourceTextModule(readFileSync(new URL("./browser-bundle.mjs", import.meta.url), "utf8"), {
  context, identifier: "https://app.example.test/cloudflare-kv-bundle.mjs",
  importModuleDynamically() { throw new Error("no dynamic external exception allowed"); },
});
await module.link(() => { throw new Error("no static external exception allowed"); });
await module.evaluate({ timeout: 5000 });
assert.deepEqual(JSON.parse(JSON.stringify(await module.namespace.verifyBrowserRoots())), { coreAndPublicErrorIdentity: true, lazy: true });
assert.equal(absent.runInContext(context), true);
const blocked = error => error?.code === "ERR_NATIVE_PACKED_BROWSER_IMPORT";
await assert.rejects(import("mongodb"), blocked);
const fromAdapter = createRequire(import.meta.resolve("@dalgo/cloudflare-kv"));
assert.throws(() => fromAdapter("node:net"), blocked);
assert.equal(fetches, 0); assert.equal(workers, 0);
console.log(JSON.stringify({ packageGraphGuard: true, guardNegativeControls: true, coreAndPublicErrorIdentity: true, lazy: true, fetches, workers, actualBrowserQuery: false }));
