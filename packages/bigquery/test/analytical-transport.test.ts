import { describe, expect, it, vi } from "vitest";
import { bounds } from "../src/analytical.js";
import { abortable, realClock, Transport, type OperationScope, type TrustedIdentity } from "../src/analytical/transport.js";
const principal = {
  kind: "workload" as const, subject: "fixture", generation: "1"
};
const identity: TrustedIdentity = {
  principal, accessToken: "ephemeral", expiresAt: Date.now() + 60000, read: true, cancel: true
};
function scope(): OperationScope { return {
  principal, bounds: bounds({
    httpMs: 20
  }), executionDeadline: Date.now() + 1000, remaining: async () => 1000, debit: async () => { }
}; }
describe("bounded injected transport", () => {
  for (const stop of ["caller", "deadline"] as const) {
    it.each(["resolves", "throws", "rejects", "never"] as const)(`discards a fetch body arriving after ${stop} cancellation when cleanup %s`, async cleanup => {
      let resolveFetch: ((response: Response) => void) | undefined;
      const fetcher = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
      const controller = new AbortController();
      const transport = new Transport({ authorize: () => Promise.resolve(identity) }, fetcher, realClock);
      const pending = transport.call({ ...scope(), signal: controller.signal }, "GET", "projects/job-project/jobs/j", {});
      const stopped = expect(pending).rejects.toThrow("local_stopped");
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce(), { interval: 1 });
      if (stop === "caller") controller.abort("private-abort-reason");
      await stopped;
      const response = new Response(new ReadableStream());
      if (response.body === null) throw new Error("missing response body");
      const cancel = vi.spyOn(response.body, "cancel").mockImplementation(() => {
        if (cleanup === "throws") throw new Error("private-cleanup-error");
        if (cleanup === "rejects") return Promise.reject(new Error("private-cleanup-error"));
        if (cleanup === "never") return new Promise(() => { });
        return Promise.resolve();
      });
      if (resolveFetch === undefined) throw new Error("fetch was not dispatched");
      resolveFetch(response);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { interval: 1 });
      expect(fetcher).toHaveBeenCalledOnce();
    });
  }
  it("owns a fulfilled response before abortable resolves, so a completion/abort race still cancels its body", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream());
    if (response.body === null) throw new Error("missing response body");
    const cancel = vi.spyOn(response.body, "cancel").mockResolvedValue();
    const transport = new Transport({ authorize: () => Promise.resolve(identity) }, () => {
      const pending = Promise.resolve(response);
      void pending.then(() => { queueMicrotask(() => { controller.abort(); }); });
      return pending;
    }, realClock);
    await expect(transport.call({ ...scope(), signal: controller.signal }, "GET", "projects/job-project/jobs/j", {})).rejects.toThrow("local_stopped");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("consumes late fetch rejection after caller cancellation without an unhandled rejection", async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    const controller = new AbortController();
    const transport = new Transport({ authorize: () => Promise.resolve(identity) }, fetcher, realClock);
    const pending = transport.call({ ...scope(), signal: controller.signal }, "GET", "projects/job-project/jobs/j", {});
    const stopped = expect(pending).rejects.toThrow("local_stopped");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce(), { interval: 1 });
    controller.abort();
    await stopped;
    if (rejectFetch === undefined) throw new Error("fetch was not dispatched");
    rejectFetch(new Error("private-late-fetch-error"));
    await Promise.resolve();
  });
  it("consumes a synchronously aborted fetch rejection and a pre-aborted injected promise", async () => {
    const controller = new AbortController();
    const transport = new Transport({ authorize: () => Promise.resolve(identity) }, () => {
      controller.abort();
      return Promise.reject(new Error("private-fetch-error"));
    }, realClock);
    await expect(transport.call({ ...scope(), signal: controller.signal }, "GET", "projects/job-project/jobs/j", {})).rejects.toThrow("local_stopped");
    await expect(abortable(Promise.reject(new Error("private-input-error")), controller.signal)).rejects.toThrow("local_stopped");
  });
  it.each(["identity", "fetch", "stream"])("stops ignored abort signals in %s without an unbounded await", async (where) => {
    const never = <T>(): Promise<T> => new Promise(() => { });
    const transport = new Transport({
      authorize: () => where === "identity" ? never() : Promise.resolve(identity)
    }, () => where === "fetch" ? never() : Promise.resolve(new Response(new ReadableStream({
      pull: () => never()
    }))), realClock);
    await expect(transport.call(scope(), "GET", "projects/job-project/jobs/j", {})).rejects.toThrow("local_stopped");
  });
  it("charges received chunks before rejecting decompressed response overflow", async () => {
    let debit = 0;
    const operation = {
      ...scope(), bounds: bounds({
        responseBytes: 8
      }), debit: async (bytes: number) => { debit += bytes; }
    };
    const transport = new Transport({
      authorize: async () => identity
    }, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); controller.close(); }
    })), realClock);
    await expect(transport.call(operation, "GET", "projects/job-project/jobs/j", {})).rejects.toThrow("response_limit");
    expect(debit).toBe(9);
  });
});
