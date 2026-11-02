import { CloudflareKvDatabase, type Authority, type Backend, type RawList } from "./database.js";
import { CloudflareKvError, type KvEntry, type KvOptions, type WorkersKvNamespaceLike } from "./types.js";
import type { Operation } from "./operation.js";
import { copiedArray, encoder, jsonCopy, only, positive, utf8 } from "./validation.js";

function returnedStream(value: unknown): ReadableStream<Uint8Array> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "value");
  const stream: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  return stream instanceof ReadableStream ? stream as ReadableStream<Uint8Array> : undefined;
}
class BindingBackend implements Backend {
  public readonly kind = "binding";
  readonly #binding: WorkersKvNamespaceLike;
  readonly #cacheTtl: number | undefined;
  public constructor(binding: WorkersKvNamespaceLike, options: KvOptions) {
    const candidate: unknown = binding;
    if (candidate === null || typeof candidate !== "object" || typeof binding.getWithMetadata !== "function" || typeof binding.list !== "function") throw new CloudflareKvError("configuration");
    this.#binding = binding;
    this.#cacheTtl = options.cacheTtl === undefined ? undefined : positive(options.cacheTtl, 60, 2_147_483_647);
    if (this.#cacheTtl !== undefined && this.#cacheTtl < 30) throw new CloudflareKvError("configuration");
  }
  public authorize(operation: Operation): Promise<Authority> { operation.check(); return Promise.resolve({ fingerprint: "borrowed-binding-instance" }); }
  public admitKeys(keys: readonly string[], operation: Operation): void {
    let bytes = 0;
    for (const key of keys) { operation.check(); bytes += encoder.encode(key).byteLength; if (bytes > operation.limits.maxRequestBytes) throw new CloudflareKvError("bounds"); }
  }
  public checkCursor(prefix: string, limit: number, cursor: string, operation: Operation): void {
    operation.check();
    if (encoder.encode(prefix).byteLength + encoder.encode(cursor).byteLength + String(limit).length > operation.limits.maxRequestBytes) throw new CloudflareKvError("bounds");
  }
  public async get(key: string, operation: Operation): Promise<KvEntry | null> {
    operation.request();
    let owned: unknown;
    let reading = false;
    try {
      const raw: unknown = await operation.foreign(() => Promise.resolve(this.#binding.getWithMetadata(key, { type: "stream", ...(this.#cacheTtl === undefined ? {} : { cacheTtl: this.#cacheTtl }) })).then((value) => { owned = value; return value; }), (late) => { operation.cleanup(returnedStream(late)); });
      const result = only(raw, ["value", "metadata", "cacheStatus"]);
      operation.check();
      if (result.value === null) return null;
      const stream = returnedStream(result);
      if (stream === undefined) throw new CloudflareKvError("protocol");
      const metadata = jsonCopy(result.metadata, 1024, () => { operation.check(); });
      operation.charge(metadata.bytes);
      reading = true;
      const value = await operation.bytes(stream, operation.limits.maxValueBytes);
      operation.check(); return { key, value, metadata: metadata.value };
    } finally { if (!reading) operation.cleanup(returnedStream(owned)); }
  }
  public async list(prefix: string, limit: number, cursor: string, operation: Operation): Promise<RawList> {
    operation.request();
    const raw = await operation.foreign(() => this.#binding.list({ prefix, limit, ...(cursor === "" ? {} : { cursor }) }));
    const result = only(raw, ["keys", "list_complete", "cursor", "cacheStatus"]);
    const keys = copiedArray(result.keys, limit);
    // The platform already decoded these objects; this is a logical copied
    // budget, not a claim about an inaccessible provider wire allocation.
    let copied: ReturnType<typeof jsonCopy>;
    try { copied = jsonCopy(keys, operation.limits.maxResponseBytes, () => { operation.check(); }); }
    catch (error) { if (error instanceof CloudflareKvError && error.code === "bounds") operation.exhaust(); throw error; }
    operation.charge(copied.bytes);
    if (typeof result.list_complete !== "boolean") throw new CloudflareKvError("protocol");
    const token = result.cursor === undefined ? "" : utf8(result.cursor, 16_384, true);
    if (!Array.isArray(copied.value)) throw new CloudflareKvError("protocol");
    return { keys: copied.value, complete: result.list_complete, cursor: token };
  }
}

/** Borrowed native namespace, no SDK token, global env or runtime side effects. */
export class WorkersKvDatabase extends CloudflareKvDatabase {
  public constructor(binding: WorkersKvNamespaceLike, options: KvOptions) { super(new BindingBackend(binding, options), options); }
}
