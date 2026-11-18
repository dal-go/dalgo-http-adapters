import { afterEach, expect, it, vi } from "vitest";
import { AthenaNativeClient } from "../src/client.js";
import { AthenaHttpClient } from "../src/browser.js";
import { createAthenaHttpHandler } from "../src/http.js";
import type { AthenaNativePage } from "../src/types.js";
import { Fixture, query, result, source } from "./fixture.js";
afterEach(() => { vi.unstubAllGlobals(); });
function request(input: unknown, signal?: AbortSignal): Request {
  return new Request("https://bridge.invalid/athena", { method: "POST", body: JSON.stringify(input), headers: { origin: "https://app.invalid", "content-type": "application/json", authorization: "Bearer bridge-reader" }, ...(signal === undefined ? {} : { signal }) });
}
it("uses a server-fixed authority and refuses unknown descriptors/origins before authorization", async () => {
  const f = new Fixture(), client = new AthenaNativeClient({ source, transport: f }); let auth = 0;
  const handler = createAthenaHttpHandler({ allowedOrigins: ["https://app.invalid"], authorize: req => { auth++; return req.headers.get("authorization") === "Bearer bridge-reader" ? client : undefined; } });
  try {
    expect((await handler(request({ operation: "next", cursor: "raw-token", queryId: "foreign" }))).status).toBe(400);
    expect(auth).toBe(0); expect(f.auth).toBe(0);
    const invalidOrigin = new Request("https://bridge.invalid/athena", { method: "POST", headers: { origin: "https://foreign.invalid", "content-type": "application/json" }, body: "{}" });
    expect((await handler(invalidOrigin)).status).toBe(403); expect(auth).toBe(0);
    const valid = await handler(request({ operation: "query", query: query(), pageSize: 100 })); expect(valid.status).toBe(200);
    const page = await valid.json() as AthenaNativePage; expect(page.rows[0]?.[1]).toBe("9007199254740993.0001");
  } finally { client.close(); }
});
it("serializes and constructs the response before native cursor ACK, preserving failed delivery", async () => {
  const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]])]; const client = new AthenaNativeClient({ source, transport: f });
  const handler = createAthenaHttpHandler({ allowedOrigins: ["https://app.invalid"], authorize: () => client });
  try {
    const first = await (await handler(request({ operation: "query", query: query() }))).json() as AthenaNativePage;
    if (first.nextCursor === undefined) throw new Error("cursor"); const cursor = first.nextCursor; const controller = new AbortController();
    const Original = globalThis.Response; let entered = false;
    vi.stubGlobal("Response", class extends Original {
      public constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init);
        if (typeof body === "string" && body.includes('"ordinalStart"') && init?.status === 200) { entered = true; controller.abort(new Error("PRIVATE")); throw new Error("PRIVATE_FACTORY"); }
      }
    });
    const failed = await handler(request({ operation: "next", cursor }, controller.signal)); expect(entered).toBe(true); expect(failed.status).toBe(408);
    expect(await failed.text()).not.toContain("PRIVATE"); vi.unstubAllGlobals();
    const success = await handler(request({ operation: "next", cursor })); expect(success.status).toBe(200);
    const page = await success.json() as AthenaNativePage; expect(page.rows).toEqual([["a", "1", null]]); expect(page.ordinalStart).toBe(0);
    expect(f.calls.filter(value => value.action === "GetQueryResults")).toHaveLength(2);
    expect((await handler(request({ operation: "next", cursor }))).status).toBe(400);
  } finally { vi.unstubAllGlobals(); client.close(); }
});
it("uses the browser-safe bridge client for native pages without exposing AWS authority", async () => {
  const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]])]; const native = new AthenaNativeClient({ source, transport: f });
  const handler = createAthenaHttpHandler({ allowedOrigins: ["https://app.invalid"], authorize: req => req.headers.get("authorization") === "Bearer bridge-reader" ? native : undefined });
  const browser = new AthenaHttpClient({ endpoint: "https://bridge.invalid/athena", headers: () => ({ origin: "https://app.invalid", authorization: "Bearer bridge-reader" }),
    fetch: (input, init) => handler(new Request(input, init)) });
  try {
    const first = await browser.queryPage(query(), { pageSize: 1 }); expect(first.hasMore).toBe(true);
    if (first.nextCursor === undefined) throw new Error("cursor"); expect((await browser.nextPage(first.nextCursor)).rows).toEqual([["a", "1", null]]);
    expect(f.calls.every(value => !JSON.stringify(value.input).includes("bridge-reader"))).toBe(true);
  } finally { browser.close(); native.close(); }
});
