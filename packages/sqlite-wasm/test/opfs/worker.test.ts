import { afterEach, describe, expect, it, vi } from "vitest";
import { mapSqliteError } from "../../src/errors.js";
import { reviveError, serializeError, type WorkerResponse } from "../../src/opfs/protocol.js";
import { serveDemoDbWorker, type WorkerScopeLike } from "../../src/opfs/worker.js";
import { pinFor, sampleBytes, serve, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);

afterEach(() => { vi.unstubAllGlobals(); });

class FakeScope implements WorkerScopeLike {
  readonly #target = new EventTarget();
  public readonly sent: WorkerResponse[] = [];
  #waiters: (() => void)[] = [];

  public addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    this.#target.addEventListener(type, listener as EventListener);
  }

  public postMessage(message: unknown): void {
    this.sent.push(message as WorkerResponse);
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  public send(data: unknown): void { this.#target.dispatchEvent(new MessageEvent("message", { data })); }

  public async reply(data: { readonly id: number } & Record<string, unknown>): Promise<WorkerResponse> {
    this.send(data);
    for (;;) {
      const found = this.sent.find((response) => response.id === data.id);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    }
  }
}

describe("serveDemoDbWorker", () => {
  it("answers open, exec, reset and close in order", async () => {
    const scope = new FakeScope();
    serveDemoDbWorker({ scope, sqlite3: () => Promise.resolve(sqliteLike), fetch: serve({ [pin.url]: sample }), getDirectory: null });
    scope.send("not a request");
    scope.send({ id: "1", op: "open" });
    expect(await scope.reply({ id: 1, op: "open", pin })).toMatchObject({ id: 1, ok: true, value: { persistent: false } });
    expect(await scope.reply({ id: 2, op: "exec", sql: "UPDATE Artist SET Name = ? WHERE ArtistId = 1", binds: ["x"] }))
      .toEqual({ id: 2, ok: true, value: { rows: [], changes: 1 } });
    expect(await scope.reply({ id: 3, op: "reset" })).toEqual({ id: 3, ok: true, value: { canonical: { sha256: pin.sha256 } } });
    expect(await scope.reply({ id: 4, op: "close" })).toEqual({ id: 4, ok: true, value: undefined });
    const failed = await scope.reply({ id: 5, op: "exec", sql: "SELECT 1" });
    expect(failed).toEqual({ id: 5, ok: false, error: { name: "Error", message: "the dataset is not open" } });
  });

  it("sends SQLite errors with their result codes", async () => {
    const scope = new FakeScope();
    serveDemoDbWorker({ scope, sqlite3: () => Promise.resolve(sqliteLike), fetch: serve({ [pin.url]: sample }), getDirectory: null });
    await scope.reply({ id: 1, op: "open", pin });
    const response = await scope.reply({ id: 2, op: "exec", sql: "DELETE FROM Artist WHERE ArtistId = 1" });
    expect(response).toMatchObject({ ok: false, error: { name: "SQLite3Error", resultCode: 787 } });
    if (response.ok) throw new Error("expected a failure");
    expect(mapSqliteError(reviveError(response.error))).toMatchObject({ code: "constraint_violation", constraint: "foreign_key" });
  });

  it("loads sqlite-wasm and listens on the worker global by default", async () => {
    const scope = new FakeScope();
    vi.stubGlobal("addEventListener", scope.addEventListener.bind(scope));
    vi.stubGlobal("postMessage", scope.postMessage.bind(scope));
    serveDemoDbWorker({ fetch: serve({ [pin.url]: sample }) });
    expect(await scope.reply({ id: 1, op: "open", pin })).toMatchObject({ ok: true, value: { persistent: false, fallback: { reason: "missing-api" } } });
  });
});

describe("error serialization", () => {
  it("keeps the fields error mapping and retries read", () => {
    const error = Object.assign(new Error("locked"), { name: "PoolUnavailableError", resultCode: 5, code: "opfs_unavailable", reason: "locked", retriable: true });
    const serialized = serializeError(error);
    expect(serialized).toEqual({ name: "PoolUnavailableError", message: "locked", resultCode: 5, code: "opfs_unavailable", reason: "locked", retriable: true });
    expect(reviveError(serialized)).toMatchObject(serialized);
    expect(serializeError(new TypeError("bad"))).toEqual({ name: "TypeError", message: "bad" });
    expect(reviveError({ name: "TypeError", message: "bad" })).not.toHaveProperty("code");
    expect(serializeError("text")).toEqual({ name: "Error", message: "text" });
  });
});
