import type { WorkersKvNamespaceLike } from "../src/types.js";

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error("deferred not initialized"); };
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
export async function bounded<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("owned fixture acknowledgement missing")); }, milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
export function stream(value: readonly number[] = [0, 255, 128]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from(value)); controller.close(); } });
}
export function namespace(): WorkersKvNamespaceLike {
  return {
    getWithMetadata: (key) => Promise.resolve(key.endsWith("missing") ? { value: null, metadata: null } : { value: stream(key.endsWith("empty") ? [] : [0, 255, 128]), metadata: { nested: [false, null, 3] } }),
    list: () => Promise.resolve({ keys: [{ name: "tenant:a", metadata: false, expiration: 123 }], list_complete: true }),
  };
}
export const options = { allowedPrefixes: ["tenant:"] };
