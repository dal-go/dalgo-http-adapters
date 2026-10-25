import { AlreadyExistsError, NotFoundError, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { NeptuneDatabase } from "../src/index.js";

interface Call { readonly input: URL | RequestInfo; readonly init?: RequestInit; }

function reply(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, ...(headers === undefined ? {} : { headers }) });
}

function node(id: string, properties: Record<string, unknown> = {}): object {
  return { "~id": id, "~entityType": "node", "~labels": ["Item"], "~properties": properties };
}

function fakeFetch(...responses: Response[]): { readonly fetch: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetch = ((input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    return Promise.resolve(responses.shift() ?? reply({ results: [] }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function database(recording: ReturnType<typeof fakeFetch>): NeptuneDatabase {
  return new NeptuneDatabase({
    baseUrl: "https://cluster.neptune.amazonaws.com:8182",
    collections: { items: { label: "Item" } },
    headers: () => ({ authorization: "AWS4-HMAC-SHA256 redacted" }),
    fetch: recording.fetch,
  });
}

function body(recording: ReturnType<typeof fakeFetch>, index = 0): URLSearchParams {
  const value = recording.calls[index]?.init?.body;
  if (typeof value !== "string") throw new Error("expected encoded request string");
  return new URLSearchParams(value);
}

function url(input: URL | RequestInfo | undefined): string | undefined {
  if (input instanceof URL || typeof input === "string") return input.toString();
  return input?.url;
}

describe("NeptuneDatabase", () => {
  it("uses POST form parameters and Neptune custom IDs for point reads", async () => {
    const recording = fakeFetch(reply({ results: [{ node: node("items:milk", { title: "Milk" }) }] }));
    await expect(database(recording).get(collection<{ title: string }>("items").key("milk"))).resolves.toMatchObject({ exists: true, data: { title: "Milk" } });
    expect(url(recording.calls[0]?.input)).toBe("https://cluster.neptune.amazonaws.com:8182/openCypher");
    expect(body(recording).get("query")).toBe("MATCH (n:`Item` {`~id`: $id}) RETURN n AS node LIMIT 2");
    expect(body(recording).get("parameters")).toBe('{"id":"items:milk"}');
    expect(recording.calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(recording.calls[0]?.init?.headers).get("authorization")).toContain("AWS4-HMAC-SHA256");
  });

  it("maps CRUD to one parameterized openCypher request each", async () => {
    const recording = fakeFetch(
      reply({ results: [{ node: node("items:milk", { title: "Milk" }) }] }),
      reply({ results: [{ node: node("items:milk", { title: "Oat milk" }) }] }),
      reply({ results: [{ node: node("items:milk", { done: true }) }] }),
      reply({ results: [{ deleted: 1 }] }),
    );
    const db = database(recording);
    const items = collection<{ title: string }>("items");
    await db.insert(items.key("milk"), { title: "Milk" });
    await db.set(items.key("milk"), { title: "Oat milk" });
    await db.update(items.key("milk"), { done: true });
    await db.delete(items.key("milk"));
    expect(body(recording, 0).get("query")).toContain("CREATE (n:`Item` {`~id`: $id}) SET n = $properties");
    expect(body(recording, 1).get("query")).toContain("MERGE (n:`Item` {`~id`: $id}) SET n = $properties");
    expect(body(recording, 2).get("query")).toContain("MATCH (n:`Item` {`~id`: $id}) SET n += $properties");
    expect(body(recording, 3).get("query")).toContain("DELETE n RETURN count(n) AS deleted");
  });

  it("maps Neptune duplicate custom IDs and missing mutations to DALgo errors", async () => {
    const duplicate = fakeFetch(reply({ code: "DuplicateDataException", message: "must not surface" }, 400));
    await expect(database(duplicate).insert(collection("items").key("milk"), { title: "Milk" })).rejects.toBeInstanceOf(AlreadyExistsError);
    const absent = fakeFetch(reply({ results: [] }));
    await expect(database(absent).update(collection("items").key("milk"), { done: true })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("compiles scalar query filters, stable IDs, and safe cursors", async () => {
    const recording = fakeFetch(reply({ results: [{ node: node("items:a", { rank: 2 }) }, { node: node("items:b", { rank: 3 }) }] }));
    const query = collection<{ rank: number }>("items").query().where("rank", ">=", 1).orderBy("rank").limit(1).build();
    const page = await database(recording).query(query);
    expect(body(recording).get("query")).toContain("n.`rank` >= $filter0 RETURN n AS node ORDER BY n.`rank` ASC, id(n) ASC LIMIT 2");
    expect(page.nextCursor).toEqual({ values: [2, "a"] });
  });

  it("rejects unsupported transactions, non-string IDs, arrays, and insecure targets before network I/O", async () => {
    const recording = fakeFetch();
    const db = database(recording);
    await expect(db.runReadwriteTransaction()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.get(key("items", 1))).rejects.toThrow("string IDs");
    await expect(db.insert(collection("items").key("a"), { tags: ["x"] })).rejects.toThrow("non-null finite");
    expect(() => new NeptuneDatabase({ baseUrl: "http://example.com", collections: { items: { label: "Item" } } })).toThrow("HTTPS");
    expect(recording.calls).toHaveLength(0);
  });

  it("uses a bounded sentinel page and rejects forged query interpolation values", async () => {
    const recording = fakeFetch(reply({ results: [{ node: node("items:a", { rank: 1 }) }, { node: node("items:b", { rank: 2 }) }] }));
    const db = new NeptuneDatabase({
      baseUrl: "https://cluster.neptune.amazonaws.com:8182", collections: { items: { label: "Item" } }, fetch: recording.fetch, maxRows: 1,
    });
    const page = await db.query(collection<{ rank: number }>("items").query().orderBy("rank").build());
    expect(body(recording).get("query")).toContain("LIMIT 2");
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toEqual({ values: [1, "a"] });
    const forged = collection("items").query().build() as unknown as { orders: { field: string; direction: string }[]; offset?: number; limit?: number };
    forged.orders = [{ field: "rank", direction: "DESC; DELETE n" }];
    await expect(db.query(forged as never)).rejects.toThrow("direction");
    forged.orders = [];
    forged.offset = -1;
    await expect(db.query(forged as never)).rejects.toThrow("offset");
    forged.offset = 0;
    forged.limit = Number.POSITIVE_INFINITY;
    await expect(db.query(forged as never)).rejects.toThrow("limit");
  });

  it("does not create a cursor when the exact bounded page has no sentinel row", async () => {
    const recording = fakeFetch(reply({ results: [{ node: node("items:a", { rank: 1 }) }] }));
    const db = new NeptuneDatabase({
      baseUrl: "https://cluster.neptune.amazonaws.com:8182", collections: { items: { label: "Item" } }, fetch: recording.fetch, maxRows: 1,
    });
    const page = await db.query(collection<{ rank: number }>("items").query().orderBy("rank").build());
    expect(body(recording).get("query")).toContain("LIMIT 2");
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it("rejects prefix-overlapping mappings and oversized response bodies", async () => {
    expect(() => new NeptuneDatabase({
      baseUrl: "https://cluster.neptune.amazonaws.com:8182",
      collections: { items: { label: "Item", idPrefix: "item:" }, other: { label: "Other", idPrefix: "item:other:" } },
    })).toThrow("must not overlap");
    const recording = fakeFetch(reply({ results: [{ node: node("items:a", { title: "x".repeat(100) }) }] }));
    const db = new NeptuneDatabase({
      baseUrl: "https://cluster.neptune.amazonaws.com:8182", collections: { items: { label: "Item" } }, fetch: recording.fetch, maxResponseBytes: 20,
    });
    await expect(db.get(collection("items").key("a"))).rejects.toThrow("exceeds 20 bytes");
  });

  it("rejects oversized encoded requests before transport and cancels a hung stream", async () => {
    const oversized = fakeFetch();
    const smallRequest = new NeptuneDatabase({
      baseUrl: "https://cluster.neptune.amazonaws.com:8182", collections: { items: { label: "Item" } }, fetch: oversized.fetch, maxRequestBytes: 20,
    });
    await expect(smallRequest.get(collection("items").key("this-key-is-too-long"))).rejects.toThrow("request exceeds 20 bytes");
    expect(oversized.calls).toHaveLength(0);

    let cancelled = false;
    const hungFetch = (() => Promise.resolve(new Response(new ReadableStream({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => { cancelled = true; },
    })))) as typeof fetch;
    const hung = new NeptuneDatabase({
      baseUrl: "https://cluster.neptune.amazonaws.com:8182", collections: { items: { label: "Item" } }, fetch: hungFetch, timeoutMs: 5,
    });
    await expect(hung.get(collection("items").key("a"))).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });
});
