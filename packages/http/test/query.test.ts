import { collection, validateProviderReads } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";
import { ECB_DAILY_URL, ECBQueryExecutor, MAX_XML_BYTES } from "../src/index.js";
import { readECBXML } from "../src/transport.js";
import { bytes, parser, plan, response, xml } from "./fixture.js";
const daily = collection<{ time: string; currency: string; rate: string }>("daily");
async function executor(fetcher: typeof fetch) {
  const admission = await plan();
  return { admission, db: new ECBQueryExecutor({ collectionName: "daily", executorId: "synthetic-browser",
    providerReadPlan: admission, fetch: fetcher, parser: new parser() }) };
}
describe("admitted direct ECB query", () => {
  it("queries native strings and returns detached validated observations even for empty matches", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const { db, admission } = await executor(fetcher);
    const page = await db.query(daily.query().where("currency", "==", "AAA").limit(1).build());
    expect(page.records[0]?.data.rate).toBe("001.23000");
    expect(page.records[0]?.key.path).toBe("daily/AAA");
    expect(await validateProviderReads(page, admission)).toMatchObject({ sourceRights: admission.sourceRights });
    expect(page.providerReads?.reads[0]).toMatchObject({ bytes: bytes(xml).length, referenceDate: "2037-02-03", attestation: "direct-executor-observed" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(ECB_DAILY_URL);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", mode: "cors", cache: "no-store", redirect: "error", credentials: "omit" });
    Object.assign(admission.sourceRights[0]?.declaration ?? {}, { text: "changed" });
    expect(page.sourceRights?.[0]?.declaration.text).toBe("Synthetic permission\n preserve whitespace");
    const empty = await db.query(daily.query().where("currency", "==", "BBB").build());
    expect(empty.records).toEqual([]); expect(empty.providerReads?.reads).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2); // each query observes a fresh read
  });
  it("captures query inputs before the first asynchronous gate and honors pre-cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const { db } = await executor(fetcher);
    const query = daily.query().where("currency", "==", "AAA").build();
    const pending = db.query(query);
    Object.assign(query.source, { name: "tampered" });
    Object.assign(query.filters[0] ?? {}, { value: "ZZZ" });
    const page = await pending;
    expect(page.records[0]?.key.path).toBe("daily/AAA");
    expect(page.records[0]?.data.currency).toBe("AAA");
    const controller = new AbortController(); controller.abort();
    await expect(db.query(daily.query().build(), { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses unsupported queries before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>(); const { db } = await executor(fetcher);
    for (const query of [daily.query().orderBy("rate").build(), daily.query().offset(1).build(),
      daily.query().startAt("AAA").build(), daily.query().where("rate", ">", "1").build(),
      daily.query().where("rate", "==", 1).build(), collection("other").query().build()]) {
      await expect(db.query(query)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses invalid admission and budgets before HTTP", async () => {
    for (const field of ["rights", "url", "mode", "digest", "budget", "params"] as const) {
      const admission = await plan();
      if (field === "rights") Object.assign(admission.sourceRights[0]?.declaration ?? {}, { text: "tampered" });
      if (field === "url") Object.assign(admission.requests[0] ?? {}, { upstreamUrl: ECB_DAILY_URL + "?x=1" });
      if (field === "mode") Object.assign(admission.execution, { mode: "proxy" });
      if (field === "digest") Object.assign(admission.bindings[0] ?? {}, { decoderDigest: "invalid" });
      if (field === "budget") Object.assign(admission, { maxReads: 0 });
      if (field === "params") Object.assign(admission.requests[0] ?? {}, { params: { x: 1 } });
      const fetcher = vi.fn<typeof fetch>();
      const db = new ECBQueryExecutor({ collectionName: "daily", executorId: "synthetic-browser", providerReadPlan: admission, fetch: fetcher, parser: new parser() });
      await expect(db.query(daily.query().build())).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("does not call the codec after a failed decoder and has no fallback", async () => {
    const decode = vi.fn((value: unknown) => value); const { db } = await executor(() => Promise.resolve(response("<bad/>")));
    await expect(db.query(collection("daily", { codec: { decode, encode: (value: unknown) => value } }).query().build())).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });
});
describe("bounded injected Fetch", () => {
  it("rejects HTTP, MIME, redirect and content-length errors", async () => {
    for (const res of [new Response("bad", { status: 500 }), new Response("bad", { headers: { "Content-Type": "text/html" } }),
      new Response(xml, { headers: { "Content-Type": "text/xml", "Content-Length": String(MAX_XML_BYTES + 1) } })]) {
      await expect(readECBXML({ fetch: () => Promise.resolve(res) })).rejects.toThrow();
    }
    const res = response(); Object.defineProperty(res, "redirected", { value: true });
    await expect(readECBXML({ fetch: () => Promise.resolve(res) })).rejects.toThrow();
  });
  it("cancels oversize streams and refuses fetch/CORS failures without retry", async () => {
    const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_XML_BYTES + 1)); }, cancel });
    await expect(readECBXML({ fetch: () => Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/xml" } })) })).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalled();
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Synthetic CORS refusal")));
    await expect(readECBXML({ fetch: fetcher })).rejects.toThrow("CORS"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds a hanging Fetch and cancels a stalled body", async () => {
    await expect(readECBXML({ fetch: () => new Promise<Response>(() => undefined), timeoutMs: 10 })).rejects.toThrow("deadline");
    const cancel = vi.fn();
    await expect(readECBXML({ fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "text/xml" } })), timeoutMs: 10 })).rejects.toThrow("deadline");
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects pre-abort without Fetch and forwards in-flight cancellation", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn<typeof fetch>();
    await expect(readECBXML({ fetch: fetcher }, controller.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController(); const operation = readECBXML({ fetch: () => new Promise<Response>(() => undefined) }, active.signal);
    active.abort(); await expect(operation).rejects.toThrow();
  });
});
