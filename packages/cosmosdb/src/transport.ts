import { cancelQuietly } from "@dalgo/adapter-runtime";
import { CosmosOperation } from "./operation.js";

const discarded = new WeakSet();
/** A late/unused body has one owner. Hostile cancellation never blocks delivery. */
export function discardBody(response: Response): void {
  if (response.body === null || discarded.has(response.body)) return;
  discarded.add(response.body);
  cancelQuietly(response.body);
}

export async function ownedFetch(op: CosmosOperation, effect: () => Response | Promise<Response>): Promise<Response> {
  op.check();
  let received: Response | undefined;
  const pending = Promise.resolve().then(() => { op.check(); return effect(); }).then((response) => {
    received = response;
    if (op.stopped) discardBody(response);
    return response;
  });
  try { return await op.io(() => pending); }
  catch (error: unknown) { if (received !== undefined) discardBody(received); throw error; }
}

export function boundedHeaders(headers: Headers): void {
  let bytes = 0;
  for (const [name, value] of headers) {
    if (name.length + value.length > 65_536) throw new RangeError("Cosmos response headers exceed the supported bound");
    bytes += new TextEncoder().encode(name).byteLength + new TextEncoder().encode(value).byteLength;
    if (bytes > 65_536) throw new RangeError("Cosmos response headers exceed the supported bound");
  }
}

export async function responseText(response: Response, op: CosmosOperation): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > op.remainingResponseBytes)) {
    discardBody(response);
    throw new RangeError("Cosmos response exceeds maxResponseBytes");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  discarded.add(response.body); // Reader owns cleanup from this point onward.
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await op.io(() => reader.read());
      if (next.done) { complete = true; break; }
      op.responseBytes(next.value.byteLength);
      total += next.value.byteLength;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    op.check();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    if (!complete) cancelQuietly(reader);
    // A throwing releaseLock must never replace cancellation/budget failures.
    try { reader.releaseLock(); } catch { /* Best-effort owned cleanup. */ }
  }
}
