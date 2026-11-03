import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";
import { SignatureV4 } from "@smithy/signature-v4";
import { AthenaNativeClient } from "./client.js";
import { fail } from "./errors.js";
import { signalAborted } from "./operation.js";
import type { AthenaAuthority, AthenaLimits, AthenaSource, AthenaTransport } from "./types.js";
import { field, text } from "./validation.js";
export * from "./index.js";
export { createAthenaHttpHandler } from "./http.js";
export type { AthenaHttpHandlerOptions } from "./http.js";
type Data = string | ArrayBuffer | ArrayBufferView;
function bytes(value: Data): string | Uint8Array {
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}
/** Crypto primitive adapter only; AWS SigV4 construction is the official signer. */
class Sha256 {
  #value: Hash | Hmac; readonly #secret: Data | undefined;
  public constructor(secret?: Data) { this.#secret = secret; this.#value = secret === undefined ? createHash("sha256") : createHmac("sha256", bytes(secret)); }
  public reset(): void { this.#value = this.#secret === undefined ? createHash("sha256") : createHmac("sha256", bytes(this.#secret)); }
  public update(value: Data): void { this.#value.update(bytes(value)); }
  public digest(): Promise<Uint8Array> { return Promise.resolve(new Uint8Array(this.#value.digest())); }
}
export interface AthenaNodeCredential {
  readonly principal: string; readonly generation: string;
  readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; readonly expiresAt?: number;
}
export interface AthenaNodeOptions extends AthenaLimits {
  readonly source: AthenaSource;
  /** Explicit trusted authority; no environment/profile/IMDS/provider fallback. */
  readonly credentials: (signal: AbortSignal) => AthenaNodeCredential | Promise<AthenaNodeCredential>;
  readonly fetch?: typeof fetch;
}
function credential(value: unknown): AthenaNodeCredential {
  const principal = text(field(value, "principal"), 1024), generation = text(field(value, "generation"), 256);
  const accessKeyId = text(field(value, "accessKeyId"), 128), secretAccessKey = text(field(value, "secretAccessKey"), 256);
  const sessionToken = field(value, "sessionToken"), expiresAt = field(value, "expiresAt");
  if (!/^[A-Za-z0-9]+$/u.test(accessKeyId) || /[^!-~]/u.test(secretAccessKey) || sessionToken !== undefined && (typeof sessionToken !== "string" || sessionToken.length > 32_768 || /[^!-~]/u.test(sessionToken)) || expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt))) throw fail("configuration");
  return { principal, generation, accessKeyId, secretAccessKey, ...(typeof sessionToken === "string" ? { sessionToken } : {}), ...(typeof expiresAt === "number" ? { expiresAt } : {}) };
}
export function createAthenaNodeTransport(options: AthenaNodeOptions): AthenaTransport {
  const region = text(options.source.region, 64); if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region) || typeof options.credentials !== "function") throw fail("configuration");
  const hostname = "athena." + region + (region.startsWith("cn-") ? ".amazonaws.com.cn" : ".amazonaws.com");
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const credentials = new WeakMap<object, AthenaNodeCredential>();
  return {
    async authorize(signal) {
      const supplied = credential(await options.credentials(signal));
      if (signalAborted(signal)) throw fail("closed");
      const authority = Object.freeze({ principal: supplied.principal, generation: supplied.generation }); credentials.set(authority, supplied); return authority;
    },
    captureAuthority(original, admitted) {
      const supplied = credentials.get(original);
      if (supplied === undefined) throw fail("permission");
      credentials.set(admitted, supplied);
    },
    async request(action, body, authority: AthenaAuthority, signal) {
      const supplied = credentials.get(authority);
      if (supplied === undefined || supplied.expiresAt !== undefined && Date.now() >= supplied.expiresAt) throw fail("permission");
      const signer = new SignatureV4({ credentials: { accessKeyId: supplied.accessKeyId, secretAccessKey: supplied.secretAccessKey, ...(supplied.sessionToken === undefined ? {} : { sessionToken: supplied.sessionToken }) }, region, service: "athena", sha256: Sha256 });
      const request = await signer.sign({ protocol: "https:", hostname, method: "POST", path: "/", query: {}, headers: { host: hostname, "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonAthena." + action }, body });
      if (signalAborted(signal)) throw fail("closed");
      return fetcher("https://" + hostname + "/", { method: "POST", body, headers: request.headers, signal, redirect: "error", cache: "no-store" });
    }
  };
}
export function createAthenaNodeClient(options: AthenaNodeOptions): AthenaNativeClient { return new AthenaNativeClient({ ...options, transport: createAthenaNodeTransport(options) }); }
