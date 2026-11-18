import { vi } from "vitest";
import { NativeCosmosNoSqlDatabase, nativeCosmosResourceToken, type NativeCosmosNoSqlOptions } from "../src/index.js";

export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const nativeKey = { id: "original", partition: "tenant:a" };
export const nativeDocument = '{"id":"original","tenant":"tenant:a","_etag":"revision","wide":9223372036854775807,"fraction":1.230000000000000001,"zero":-0,"nested":[true,null,"😀"]}';
export function response(raw = nativeDocument, headers?: HeadersInit, status = 200): Response {
  return new Response(raw, { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
}
export function page(ids: readonly string[], token?: string, headers?: HeadersInit): Response {
  const documents = ids.map(id => nativeDocument.replace('"original"', JSON.stringify(id)));
  return response(`{"Documents":[${documents.join(",")}],"_count":${String(ids.length)}}`, { ...Object.fromEntries(new Headers(headers)), ...(token === undefined ? {} : { "x-ms-continuation": token }) });
}
export function setup(options: Partial<NativeCosmosNoSqlOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const authorization = vi.fn(() => nativeCosmosResourceToken("type=resource&ver=1.0&sig=owned+/="));
  const database = new NativeCosmosNoSqlDatabase({ endpoint: "https://owned.documents.azure.com", databaseId: "app", containerId: "items", partitionKeyField: "tenant", authScopeId: "owned-user", authorization, fetch, collections: { items: { partition: "tenant:a" } }, ...options });
  return { database, fetch, authorization };
}
export function requestHeaders(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, at = 0): Headers { return new Headers(fetch.mock.calls[at]?.[1]?.headers); }
