import { AlreadyExistsError, UnsupportedError, collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { Neo4jDatabase } from "../src/database.js";

function response(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status: 202, ...(headers === undefined ? {} : { headers }) });
}

function result(values: readonly unknown[][], fields: readonly string[] = ["node"]): object {
  return { data: { fields, values } };
}

function node(id: string, properties: Record<string, unknown> = {}): object {
  return { elementId: `node-${id}`, labels: ["Item"], properties: { id, ...properties } };
}

interface FetchCall {
  readonly input: URL | RequestInfo;
  readonly init: RequestInit | undefined;
}

interface RecordedFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FetchCall[];
}

function fetchSequence(...responses: Response[]): RecordedFetch {
  const calls: FetchCall[] = [];
  const fetch = ((input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return Promise.resolve(responses.shift() ?? response(result([])));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function requestBody(recording: RecordedFetch, index = 0): Record<string, unknown> {
  const init = recording.calls[index]?.init;
  if (init?.body === undefined || typeof init.body !== "string") throw new Error("missing JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function requestUrl(input: URL | RequestInfo | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (input instanceof URL || typeof input === "string") return input.toString();
  return input.url;
}

function database(recording: RecordedFetch, options: Partial<ConstructorParameters<typeof Neo4jDatabase>[0]> = {}): Neo4jDatabase {
  return new Neo4jDatabase({
    baseUrl: "https://example.databases.neo4j.io",
    database: "neo4j",
    collections: { items: { label: "Item" } },
    headers: () => ({ authorization: "Bearer fresh-token" }),
    fetch: recording.fetch,
    ...options,
  });
}

describe("Neo4jDatabase", () => {
  it("uses safe point-read request settings and decodes a node", async () => {
    const recording = fetchSequence(response(result([[node("milk", { title: "Milk" })]])));
    const db = database(recording);
    await expect(db.get(collection<{ title: string }>("items").key("milk"))).resolves.toMatchObject({
      exists: true,
      data: { id: "milk", title: "Milk" },
    });
    expect(requestUrl(recording.calls[0]?.input)).toBe("https://example.databases.neo4j.io/db/neo4j/query/v2");
    expect(requestBody(recording)).toEqual({
      statement: "MATCH (n:`Item`) WHERE n.`id` = $id RETURN n AS node LIMIT 2",
      parameters: { id: "milk" },
    });
    const init = recording.calls[0]?.init;
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
  });

  it("maps CRUD operations to safe parameterized Cypher", async () => {
    const recording = fetchSequence(
      response(result([[node("milk")]])),
      response(result([[node("milk")]])),
      response(result([[node("milk", { done: true })]])),
      response(result([[1]], ["deleted"])),
    );
    const db = database(recording);
    const items = collection<{ title: string }>("items");
    await db.insert(items.key("milk"), { title: "Milk" });
    await db.set(items.key("milk"), { title: "Oat milk" });
    await db.update(items.key("milk"), { done: true });
    await db.delete(items.key("milk"));
    expect(requestBody(recording, 0)).toMatchObject({ statement: "CREATE (n:`Item`) SET n = $properties RETURN n AS node", parameters: { properties: { id: "milk", title: "Milk" } } });
    expect(requestBody(recording, 1)).toMatchObject({ statement: "MERGE (n:`Item` {`id`: $id}) SET n = $properties RETURN n AS node" });
    expect(requestBody(recording, 2)).toMatchObject({ statement: "MATCH (n:`Item`) WHERE n.`id` = $id SET n += $patch RETURN n AS node" });
    expect(requestBody(recording, 3)).toMatchObject({ statement: "MATCH (n:`Item`) WHERE n.`id` = $id WITH n LIMIT 2 DELETE n RETURN count(n) AS deleted" });
  });

  it("maps a uniqueness-constraint create error to DALgo AlreadyExistsError", async () => {
    const recording = fetchSequence(response({ errors: [{ code: "Neo.ClientError.Schema.ConstraintValidationFailed" }] }));
    await expect(database(recording).insert(collection("items").key("milk"), { title: "Milk" })).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("preserves Aura transaction affinity through statement, commit, and rollback paths", async () => {
    const recording = fetchSequence(
      response({ transaction: { id: "tx1" } }, { "neo4j-cluster-affinity": "member-1" }),
      response(result([[node("milk")]])),
      response({ bookmarks: ["bookmark"] }),
    );
    const db = database(recording, { transactionDeployment: "aura" });
    await db.runReadwriteTransaction(async (tx) => tx.set(collection("items").key("milk"), { title: "Milk" }));
    expect(recording.calls).toHaveLength(3);
    for (const call of recording.calls.slice(1)) {
      expect(new Headers(call.init?.headers).get("neo4j-cluster-affinity")).toBe("member-1");
    }
    expect(requestUrl(recording.calls[2]?.input)).toContain("/tx/tx1/commit");
  });

  it("rolls back a configured transaction when its callback fails", async () => {
    const recording = fetchSequence(response({ transaction: { id: "tx1" } }), response({}));
    const db = database(recording, { transactionDeployment: "single-instance" });
    await expect(db.runReadwriteTransaction(async () => { await Promise.resolve(); throw new Error("stop"); })).rejects.toThrow("stop");
    expect(requestUrl(recording.calls[1]?.input)).toContain("/tx/tx1");
    expect(recording.calls[1]?.init?.method).toBe("DELETE");
  });

  it("rejects transactions without an operator-declared safe deployment", async () => {
    await expect(database(fetchSequence()).runReadwriteTransaction(async () => {
      await Promise.resolve();
      return undefined;
    })).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("rejects insecure targets and unconfigured collections", () => {
    expect(() => new Neo4jDatabase({ baseUrl: "http://example.com", database: "neo4j", collections: { items: { label: "Item" } } })).toThrow("HTTPS");
    const db = database(fetchSequence());
    return expect(db.get(collection("unknown").key("a"))).rejects.toThrow("not configured");
  });
});
