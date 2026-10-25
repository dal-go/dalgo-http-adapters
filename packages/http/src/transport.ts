import { MAX_XML_BYTES } from "./ecb-xml.js";

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export interface ECBTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  /** Whole HTTP/body deadline, bounded to at most 30 seconds. */
  readonly timeoutMs?: number;
}
export interface XMLRead { readonly bytes: Uint8Array; readonly response: Response; readonly fetchedAt: string }

export async function readECBXML(options: ECBTransportOptions, signal?: AbortSignal): Promise<XMLRead> {
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new RangeError("invalid HTTP deadline");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => { controller.abort(signal?.reason); };
  signal?.addEventListener("abort", abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const timer = setTimeout(() => { controller.abort(new DOMException("HTTP deadline exceeded", "TimeoutError")); }, timeout);
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void cancelled.catch(() => undefined);
  const onAbort = (): void => { rejectAbort?.(controller.signal.reason); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const request = options.fetch(ECB_DAILY_URL, {
      method: "GET", mode: "cors", cache: "no-store", redirect: "error", credentials: "omit", signal: controller.signal,
    });
    // A misbehaving injected Fetch cannot keep the caller waiting or retain a late body.
    void request.then((late) => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
    response = await Promise.race([request, cancelled]);
    if (response.type === "opaque" || response.type === "opaqueredirect" || response.redirected
      || (response.url !== "" && response.url !== ECB_DAILY_URL) || !response.ok) throw new TypeError("refused ECB HTTP response");
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/^(?:text|application)\/xml(?:\s*;|$)/iu.test(contentType)) throw new TypeError("ECB response is not XML");
    const length = response.headers.get("Content-Length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_XML_BYTES)) throw new RangeError("XML response exceeds byte limit");
    if (response.body === null) throw new TypeError("missing XML response body");
    reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_XML_BYTES);
    let size = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), cancelled]);
      if (chunk.done) break;
      if (chunk.value.byteLength > MAX_XML_BYTES - size) throw new RangeError("XML response exceeds byte limit");
      buffer.set(chunk.value, size); size += chunk.value.byteLength;
    }
    controller.signal.throwIfAborted();
    return { bytes: buffer.slice(0, size), response, fetchedAt: new Date().toISOString() };
  } catch (error) {
    controller.abort(error);
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    else void response?.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer); reader?.releaseLock();
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
