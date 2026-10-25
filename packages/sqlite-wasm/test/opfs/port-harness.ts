// A stand-in for `@openvaultdb/inprocess`'s `fetchOverPort` and
// `serveFetchOverPort`, written here so this package's tests keep the bridge
// ports honest against that contract without depending on OVDB: the client
// listens for `message` AND `close` (and disposes itself on `close`), the
// server listens for `message` and stops on `close`. Used by the unit tests
// and by the browser fixture page.
import type { PortProtocol } from "../../src/opfs/tab-bridge.js";

/** The `FetchPort` shape: per-type listeners, `close` included. */
export interface ContractPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  start?(): void;
}

const requestType = "contract/request";
const responseType = "contract/response";

interface Request { readonly type: typeof requestType; readonly id: number; readonly payload: unknown }
type Response = { readonly type: typeof responseType; readonly id: number } & (
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly name: string; readonly message: string }
);

/** Which bridge messages are requests and answers (like DataTug's `fetchPortProtocol`). */
export const contractProtocol: PortProtocol = {
  requestId: (message) => ((message as { readonly type?: unknown }).type === requestType ? (message as Request).id : undefined),
  responseId: (message) => ((message as { readonly type?: unknown }).type === responseType ? (message as Response).id : undefined),
  failure: (message, error) => ({ type: responseType, id: (message as Request).id, ok: false, name: error.name, message: error.message }),
};

/** The client: a `call` whose pending requests reject when the port closes or `dispose()` is called. */
export interface ContractClient {
  call(payload: unknown): Promise<unknown>;
  dispose(): void;
  readonly disposed: boolean;
}

export function callOverPort(port: ContractPort): ContractClient {
  let nextId = 0;
  let disposed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const onMessage = (event: MessageEvent): void => {
    const reply = event.data as Partial<Response>;
    if (reply.type !== responseType || reply.id === undefined) return;
    const waiter = pending.get(reply.id);
    if (waiter === undefined) return;
    pending.delete(reply.id);
    if (reply.ok === true) waiter.resolve(reply.result);
    else waiter.reject(Object.assign(new Error((reply as { readonly message: string }).message), { name: (reply as { readonly name: string }).name }));
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    port.removeEventListener("message", onMessage);
    port.removeEventListener("close", dispose);
    for (const waiter of pending.values()) waiter.reject(new Error("the port is closed"));
    pending.clear();
  };
  port.addEventListener("message", onMessage);
  port.addEventListener("close", dispose);
  port.start?.();
  return {
    call: (payload) => {
      if (disposed) return Promise.reject(new Error("the port is closed"));
      nextId += 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ type: requestType, id, payload } satisfies Request, []);
      });
    },
    dispose,
    get disposed() { return disposed; },
  };
}

/** The server: answers each request with `handle`; stops on `close` or when the returned function is called. */
export function serveOverPort(handle: (payload: unknown) => Promise<unknown>, port: ContractPort): () => void {
  let stopped = false;
  const onMessage = (event: MessageEvent): void => {
    const request = event.data as Partial<Request>;
    if (request.type !== requestType || request.id === undefined) return;
    const id = request.id;
    void handle(request.payload).then(
      (result) => { if (!stopped) port.postMessage({ type: responseType, id, ok: true, result } satisfies Response, []); },
      (error: unknown) => {
        if (!stopped) port.postMessage({ type: responseType, id, ok: false, name: (error as Error).name, message: (error as Error).message } satisfies Response, []);
      },
    );
  };
  const stop = (): void => {
    stopped = true;
    port.removeEventListener("message", onMessage);
    port.removeEventListener("close", stop);
  };
  port.addEventListener("message", onMessage);
  port.addEventListener("close", stop);
  port.start?.();
  return stop;
}
