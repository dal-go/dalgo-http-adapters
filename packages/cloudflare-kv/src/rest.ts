import { CloudflareKvDatabase, type Authority, type Backend, type RawList } from "./database.js";
import { CloudflareKvError, type KvEntry, type KvOptions } from "./types.js";
import type { Operation } from "./operation.js";
import { copiedArray, encoder, jsonCopy, only, utf8 } from "./validation.js";
import { ownedFetch } from "./node-fetch.js";
import { limits } from "./operation.js";
import { parseJson } from "./json.js";

export interface CloudflareKvRestOptions extends KvOptions {
  readonly accountId: string;
  readonly namespaceId: string;
  /** Read-only bearer, obtained per operation, never a request descriptor. */
  readonly token: (signal: AbortSignal) => string | Promise<string>;
  readonly fetch?: typeof fetch;
  /** Trusted server configuration only. The default is Cloudflare's API. */
  readonly endpoint?: string;
  readonly allowLoopbackHttpForTesting?: boolean;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(value)) throw new CloudflareKvError("configuration");
  return value;
}
function segment(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
class RestBackend implements Backend {
  public readonly kind = "rest";
  readonly #root: string;
  readonly #token: CloudflareKvRestOptions["token"];
  readonly #fetch: typeof fetch;
  readonly #close: (() => void) | undefined;
  public constructor(options: CloudflareKvRestOptions) {
    const url = new URL(options.endpoint ?? "https://api.cloudflare.com/client/v4");
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(options.allowLoopbackHttpForTesting === true && loopback && url.protocol === "http:")) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/client/v4") throw new CloudflareKvError("configuration");
    if (typeof options.token !== "function") throw new CloudflareKvError("configuration");
    if (options.cacheTtl !== undefined) throw new CloudflareKvError("configuration");
    this.#root = `${url.origin}/client/v4/accounts/${identifier(options.accountId)}/storage/kv/namespaces/${identifier(options.namespaceId)}`;
    this.#token = options.token;
    const owned = options.fetch === undefined ? ownedFetch(limits(options).maxConcurrent) : undefined;
    this.#fetch = options.fetch ?? owned?.fetch ?? (() => Promise.reject(new CloudflareKvError("configuration")));
    this.#close = owned?.close;
  }
  public close(): void { this.#close?.(); }
  public admitKeys(keys: readonly string[], operation: Operation): void {
    let bytes = 0;
    for (const key of keys) { operation.check(); bytes += encoder.encode(`${this.#root}/values/${segment(key)}`).byteLength; if (bytes > operation.limits.maxRequestBytes) throw new CloudflareKvError("bounds"); }
  }
  private listPath(prefix: string, limit: number, cursor: string): string {
    const query = new URLSearchParams({ prefix, limit: String(limit) });
    if (cursor !== "") query.set("cursor", cursor);
    return `/keys?${query.toString()}`;
  }
  public checkCursor(prefix: string, limit: number, cursor: string, operation: Operation): void {
    if (encoder.encode(this.#root + this.listPath(prefix, limit, cursor)).byteLength > operation.limits.maxRequestBytes) throw new CloudflareKvError("bounds");
  }
  public async authorize(operation: Operation): Promise<Authority> {
    const token = await operation.foreign(() => this.#token(operation.signal));
    if (typeof token !== "string" || token.length === 0 || token.length > 8192 || !/^[\x21-\x7e]+$/u.test(token)) throw new CloudflareKvError("authentication");
    const digest = await operation.foreign(() => crypto.subtle.digest("SHA-256", encoder.encode(token)));
    return { token, fingerprint: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  }
  private async response(path: string, operation: Operation, authority: Authority, maximum: number): Promise<{ bytes: Uint8Array; expiration?: number }> {
    if (encoder.encode(this.#root + path).byteLength > operation.limits.maxRequestBytes) throw new CloudflareKvError("bounds");
    operation.request();
    let owned: Response | undefined;
    let reading = false;
    try {
      const response = await operation.foreign(() => Promise.resolve(this.#fetch(this.#root + path, { method: "GET", headers: { authorization: `Bearer ${authority.token ?? ""}`, "accept-encoding": "identity" }, signal: operation.signal, redirect: "error", credentials: "omit", cache: "no-store" })).then((value) => { owned = value; return value; }), (late) => { operation.cleanup(late.body); });
      // No generic404->missing conversion: this endpoint also404s for namespace
      // and authority failures. No invented provider numeric error identity.
      if (response.status !== 200) throw new CloudflareKvError(response.status === 401 ? "authentication" : response.status === 403 ? "permission" : "http", response.status);
      if (response.headers.get("content-encoding") !== null && response.headers.get("content-encoding") !== "identity") throw new CloudflareKvError("protocol");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) throw new CloudflareKvError("bounds");
      reading = true;
      const bytes = await operation.bytes(response.body, maximum);
      const rawExpiration = response.headers.get("expiration");
      const expiration = rawExpiration === null ? undefined : Number(rawExpiration);
      if (expiration !== undefined && (!/^\d+$/u.test(rawExpiration ?? "") || !Number.isSafeInteger(expiration) || expiration < 0)) throw new CloudflareKvError("protocol");
      operation.check(); return { bytes, ...(expiration === undefined ? {} : { expiration }) };
    } finally { if (!reading) operation.cleanup(owned?.body); }
  }
  public async get(key: string, operation: Operation, authority: Authority): Promise<KvEntry> {
    const result = await this.response(`/values/${segment(key)}`, operation, authority, operation.limits.maxValueBytes);
    return { key, value: result.bytes, ...(result.expiration === undefined ? {} : { expiration: result.expiration }) };
  }
  public async list(prefix: string, limit: number, cursor: string, operation: Operation, authority: Authority): Promise<RawList> {
    const response = await this.response(this.listPath(prefix, limit, cursor), operation, authority, operation.limits.maxResponseBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
    const value: unknown = parseJson(text, () => { operation.check(); });
    const result = only(value, ["success", "result", "errors", "messages", "result_info"]);
    if (result.success !== true || copiedArray(result.errors ?? [], 1000).length !== 0) throw new CloudflareKvError("protocol");
    const keys = copiedArray(result.result, limit);
    const info = result.result_info === undefined ? {} : only(result.result_info, ["count", "cursor"]);
    if (info.count !== undefined && (typeof info.count !== "number" || info.count !== keys.length)) throw new CloudflareKvError("protocol");
    const token = info.cursor === null || info.cursor === undefined ? "" : utf8(info.cursor, 16_384, true);
    // Raw bytes were capped before parse. Closed logical metadata is validated
    // again without calling payload getters before returning native key info.
    const copied = jsonCopy(keys, operation.limits.maxResponseBytes, () => { operation.check(); });
    if (!Array.isArray(copied.value)) throw new CloudflareKvError("protocol");
    return { keys: copied.value, complete: token === "", cursor: token };
  }
}

/** Server/Node entry only. Browser entry cannot construct credentialed REST. */
export class CloudflareKvRestDatabase extends CloudflareKvDatabase {
  public constructor(options: CloudflareKvRestOptions) { super(new RestBackend(options), options); }
}
