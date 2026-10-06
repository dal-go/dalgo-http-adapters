import { describe, expect, it } from "vitest";
import { bounds } from "../src/analytical.js";
import { realClock, Transport, type OperationScope, type TrustedIdentity } from "../src/analytical/transport.js";
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
