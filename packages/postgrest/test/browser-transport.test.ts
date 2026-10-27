import { collection, key } from "@dalgo/core";
import { afterEach, describe, expect, it } from "vitest";

import { PostgrestDatabase, PostgrestHttpError } from "../src/index.js";

// The test itself is Node-only. A non-literal dynamic import keeps this file
// free of Node type dependencies while the adapter source remains browser-only.
interface TestRequest {
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly url: string | undefined;
}
interface TestResponse {
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}
interface TestServer {
  once(event: "error", listener: (error: Error) => void): void;
  listen(port: number, host: string, callback: () => void): void;
  address(): { readonly port: number } | string | null;
  close(callback: (error?: Error) => void): void;
}
const nodeModule = "node:http";
const { createServer } = await import(nodeModule) as {
  createServer(handler: (request: TestRequest, response: TestResponse) => void): TestServer;
};

const ORIGIN = "https://datatug.example";
const USER_TOKEN = "synthetic-user-jwt-not-a-secret";
const PUBLIC_ANON_KEY = "synthetic-publishable-key";

interface Observed {
  readonly origin: string | undefined;
  readonly authorization: string | undefined;
  readonly apikey: string | undefined;
  readonly acceptProfile: string | undefined;
  readonly url: string;
}

function sendJson(response: TestResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(new TextEncoder().encode(text).byteLength),
  });
  response.end(text);
}

function cors(response: TestResponse, origin: string | undefined): boolean {
  if (origin !== ORIGIN) {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("origin refused");
    return false;
  }
  response.setHeader("access-control-allow-origin", ORIGIN);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("vary", "Origin");
  return true;
}

function server(observed: Observed[], respond?: (request: TestRequest, response: TestResponse, url: URL) => boolean): TestServer {
  return createServer((request, response) => {
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      if (!cors(response, origin)) return;
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD",
        "access-control-allow-headers": "authorization, apikey, accept-profile, content-profile, prefer, content-type",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    observed.push({
      origin,
      authorization: request.headers.authorization,
      apikey: typeof request.headers.apikey === "string" ? request.headers.apikey : undefined,
      acceptProfile: typeof request.headers["accept-profile"] === "string" ? request.headers["accept-profile"] : undefined,
      url: url.toString(),
    });
    if (!cors(response, origin)) return;
    if (respond?.(request, response, url) === true) return;
    if (request.headers.authorization !== `Bearer ${USER_TOKEN}` || request.headers.apikey !== PUBLIC_ANON_KEY) {
      sendJson(response, 401, { details: "row values must not leak" });
      return;
    }
    if (url.pathname === "/rest/v1/") {
      sendJson(response, 200, {
        swagger: "2.0",
        info: { title: "Synthetic CORS PostgREST", version: "16.5" },
        paths: {
          "/": { get: {} },
          "/items": { get: {} },
        },
        definitions: {
          items: {
            type: "object",
            required: ["id", "title", "done"],
            properties: {
              id: { type: "string", format: "text", description: "Note:\nThis is a Primary Key.<pk/>" },
              title: { type: "string", format: "text" },
              done: { type: "boolean", format: "boolean" },
              score: { type: "number", format: "numeric" },
            },
          },
        },
      });
      return;
    }
    if (url.pathname === "/rest/v1/items" && request.method === "GET") {
      if (request.headers.authorization !== `Bearer ${USER_TOKEN}` || request.headers.apikey !== PUBLIC_ANON_KEY) {
        sendJson(response, 401, { details: "row values must not leak" });
        return;
      }
      sendJson(response, 200, [
        { id: "a", title: "Alpha", done: false, score: null },
        { id: "b", title: "Beta", done: false, score: 9.5 },
      ]);
      return;
    }
    sendJson(response, 404, { details: "not found" });
  });
}

async function listen(instance: TestServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve());
  });
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("test server did not get a TCP address");
  return address.port;
}

async function close(instance: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    instance.close((error) => error === undefined ? resolve() : reject(error));
  });
}

const running: TestServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(close));
});

describe("PostgrestDatabase browser transport", () => {
  it("uses the real fetch, real headers and an exact-origin CORS preflight against a local origin", async () => {
    const observed: Observed[] = [];
    const instance = server(observed);
    running.push(instance);
    const port = await listen(instance);
    const baseUrl = `http://127.0.0.1:${String(port)}/rest/v1`;

    const preflight = await globalThis.fetch(`${baseUrl}/items`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,apikey,accept-profile",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("accept-profile");

    const db = new PostgrestDatabase({
      baseUrl,
      allowInsecureLoopbackHttp: true,
      schema: "api",
      headers: () => ({ authorization: `Bearer ${USER_TOKEN}`, apikey: PUBLIC_ANON_KEY, origin: ORIGIN }),
    });

    await expect(db.testConnection()).resolves.toMatchObject({
      ok: true,
      status: "connected",
      relationCount: 1,
      schema: "api",
    });

    const items = collection<{ title: string; done: boolean; score: number | null }>("items");
    const page = await db.queryWithSignal(
      items.query().orderBy("title").limit(2).build(),
      new AbortController().signal,
    );
    expect(page.records).toEqual([
      { key: key("items", "a"), exists: true, data: { title: "Alpha", done: false, score: null } },
      { key: key("items", "b"), exists: true, data: { title: "Beta", done: false, score: 9.5 } },
    ]);
    expect(page.nextCursor).toBeDefined();

    expect(observed).toHaveLength(2);
    for (const request of observed) {
      expect(request.origin).toBe(ORIGIN);
      expect(request.authorization).toBe(`Bearer ${USER_TOKEN}`);
      expect(request.apikey).toBe(PUBLIC_ANON_KEY);
      expect(request.acceptProfile).toBe("api");
    }
    expect(observed[0]?.url).toBe(`${baseUrl}/`);
    const queryUrl = new URL(observed[1]?.url ?? "");
    expect(queryUrl.searchParams.get("order")).toBe("title.asc,id.asc");
    expect(queryUrl.searchParams.get("offset")).toBeNull();
  });

  it("reports a redacted bad-auth response instead of leaking the local error body", async () => {
    const observed: Observed[] = [];
    const instance = server(observed);
    running.push(instance);
    const port = await listen(instance);
    const db = new PostgrestDatabase({
      baseUrl: `http://127.0.0.1:${String(port)}/rest/v1`,
      allowInsecureLoopbackHttp: true,
      headers: () => ({ authorization: "Bearer wrong-synthetic-user", apikey: PUBLIC_ANON_KEY, origin: ORIGIN }),
    });

    const items = collection<{ title: string }>("items");
    const error = await db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).toEqual(new PostgrestHttpError(401));
    expect(String(error)).not.toContain("row values");
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });
  });

  it("does not add an allow-origin for a caller that bypasses the allowed boundary", async () => {
    const instance = server([]);
    running.push(instance);
    const port = await listen(instance);
    const refused = await globalThis.fetch(`http://127.0.0.1:${String(port)}/rest/v1/items`, {
      headers: { origin: "https://evil.example" },
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });
});
