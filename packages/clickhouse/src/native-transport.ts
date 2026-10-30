import { cancelQuietly, raceAbort } from "@dalgo/adapter-runtime";
import { ClickHouseNativeError } from "./native-errors.js";
import { assertNoExceptionTrailer, requireExceptionTag } from "./http-exception.js";
import { hasAsciiControl } from "./native-query.js";

export interface NativeRequestContext { readonly signal: AbortSignal; readonly cancelled: () => Error; }
export const ROW_BINARY_FORMAT = "RowBinaryWithNamesAndTypes";
// Read afresh after asynchronous work: AbortSignal changes outside TS control flow.
export function isAborted(signal: AbortSignal): boolean { return signal.aborted; }
export function isObjectMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function joinedBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function nativeOrigin(value: string, insecure: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("serverUrl must be an absolute origin"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(insecure && loopback && url.protocol === "http:")) throw new TypeError("serverUrl requires HTTPS or explicit loopback HTTP");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") throw new TypeError("serverUrl must be a credential-free origin");
  return url.origin;
}

export function nativeHeaders(value: unknown): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (value !== undefined && !isObjectMap(value)) throw new ClickHouseNativeError("permission");
  for (const [name, content] of Object.entries(value ?? {})) {
    const lower = name.toLowerCase();
    if (!["authorization", "x-clickhouse-user", "x-clickhouse-key"].includes(lower) || Object.hasOwn(result, lower)
      || typeof content !== "string" || content.length > 8192 || hasAsciiControl(content)) throw new ClickHouseNativeError("permission");
    result[lower] = content;
  }
  return Object.freeze(result);
}

/** Bounded fetch, including implementations that ignore AbortSignal. */
export async function nativeRequest(fetcher: typeof fetch, url: string, sql: string, headers: Readonly<Record<string, string>>, context: NativeRequestContext, maximum: number): Promise<Uint8Array> {
  if (isAborted(context.signal)) throw context.cancelled();
  const pending = Promise.resolve().then(() => fetcher(url, {
    method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: context.signal,
    headers: { ...headers, accept: "application/octet-stream", "content-type": "text/plain; charset=utf-8", "x-clickhouse-format": ROW_BINARY_FORMAT }, body: sql,
  }));
  void pending.then((late) => { if (isAborted(context.signal)) cancelQuietly(late.body); }, () => undefined);
  let response: Response;
  try { response = await raceAbort(pending, context.signal, context.cancelled); } catch {
    if (isAborted(context.signal)) throw context.cancelled();
    throw new ClickHouseNativeError("transport");
  }
  if (!response.ok) { cancelQuietly(response.body); throw new ClickHouseNativeError("response", response.status); }
  if (response.headers.get("x-clickhouse-format") !== ROW_BINARY_FORMAT) { cancelQuietly(response.body); throw new ClickHouseNativeError("unsupported"); }
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum)) { cancelQuietly(response.body); throw new ClickHouseNativeError("bounds"); }
  if (response.headers.has("x-clickhouse-exception-code")) { cancelQuietly(response.body); throw new ClickHouseNativeError("response"); }
  let exceptionTag: string;
  try { exceptionTag = requireExceptionTag(response.headers.get("x-clickhouse-exception-tag")); } catch (error) { cancelQuietly(response.body); throw error; }
  if (response.body === null) throw new ClickHouseNativeError("response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await raceAbort(reader.read(), context.signal, context.cancelled); } catch {
        if (isAborted(context.signal)) throw context.cancelled();
        throw new ClickHouseNativeError("transport");
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new ClickHouseNativeError("bounds");
      chunks.push(next.value);
    }
  } catch (error) {
    cancelQuietly(reader);
    // ClickHouse intentionally breaks chunked/fixed-length HTTP after writing
    // a late exception. Attribute a captured exact nonce prefix to framing,
    // while retaining transport failure when no such bytes were received.
    if (!isAborted(context.signal) && error instanceof ClickHouseNativeError && error.code === "transport") {
      assertNoExceptionTrailer(joinedBytes(chunks, size), exceptionTag, false);
    }
    throw error;
  } finally {
    if (isAborted(context.signal) || size > maximum) cancelQuietly(reader);
    try { reader.releaseLock(); } catch { /* Hostile or mocked pending reads. */ }
  }
  const bytes = joinedBytes(chunks, size);
  assertNoExceptionTrailer(bytes, exceptionTag);
  return bytes;
}
