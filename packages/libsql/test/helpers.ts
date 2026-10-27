import type { LibSQLFetch } from "../src/index.js";

export interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export interface PipelineBody {
  readonly baton: null;
  readonly requests: readonly {
    readonly type: string;
    readonly stmt?: {
      readonly sql: string;
      readonly args: readonly { readonly type: string; readonly value?: unknown }[];
      readonly want_rows: boolean;
    };
  }[];
}

export function text(value: string): unknown { return { type: "text", value }; }
export function integer(value: number | string): unknown { return { type: "integer", value: String(value) }; }
export function float(value: number): unknown { return { type: "float", value }; }
export function nullValue(): unknown { return { type: "null" }; }
export function blob(base64 = "AA=="): unknown { return { type: "blob", base64 }; }

export function executed(
  cols: readonly string[],
  rows: readonly (readonly unknown[])[],
  affected = 0,
): Record<string, unknown> {
  return { type: "execute", result: { cols: cols.map((name) => ({ name })), rows, affected_row_count: affected } };
}

export function ok(result: Record<string, unknown>): Record<string, unknown> {
  return { type: "ok", response: result };
}

export function failed(code = "SQLITE_ERROR", extended = "SQLITE_ERROR"): Record<string, unknown> {
  return { type: "error", error: { code, extended_code: extended, message: "secret server text" } };
}

export function pipeline(parts: readonly Record<string, unknown>[], baton: unknown = null): unknown {
  return { baton, results: [...parts, { type: "ok", response: { type: "close" } }] };
}

export function json(value: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

/** One HTTP response for a pipeline whose statements produced `parts` in order. */
export function response(parts: readonly Record<string, unknown>[], status = 200, headers?: Record<string, string>): Response {
  return json(pipeline(parts), status, headers);
}

export function mockFetch(responses: readonly Response[], calls: Call[]): LibSQLFetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected fetch ${String(calls.length)}`);
    return next;
  };
}

export function body(call: Call | undefined): PipelineBody {
  if (call === undefined) throw new Error("request call missing");
  return JSON.parse(String(call.init?.body)) as PipelineBody;
}

export function statements(call: Call | undefined): readonly NonNullable<PipelineBody["requests"][number]["stmt"]>[] {
  const parsed = body(call);
  return parsed.requests.flatMap((request) => request.type === "execute" && request.stmt !== undefined ? [request.stmt] : []);
}

export function firstStatement(call: Call | undefined): NonNullable<PipelineBody["requests"][number]["stmt"]> {
  const [first] = statements(call);
  if (first === undefined) throw new Error("execute statement missing");
  return first;
}

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A response whose injected body reader rejects with `error`. It records the
 * cancel and release calls so a test can prove the adapter cleans the reader up
 * instead of leaking a locked stream after redacting an external failure.
 */
export function failingBody(error: unknown): {
  readonly response: Response;
  readonly state: { cancelled: number; released: number };
} {
  const state = { cancelled: 0, released: 0 };
  const reader = {
    read: () => Promise.reject(error),
    cancel: () => { state.cancelled += 1; return Promise.resolve(); },
    releaseLock: () => { state.released += 1; },
  };
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader: () => reader },
  } as unknown as Response;
  return { response, state };
}

/** A real streamed response with no content-length, used to prove the byte cap. */
export function streamedBody(bytes: number, status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  }), { status, headers: { "content-type": "application/json" } });
}

export function never<T>(): Promise<T> { return new Promise<T>(() => undefined); }
