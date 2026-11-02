import { afterEach, expect, it, vi } from "vitest";
import { WorkersKvDatabase } from "../src/index.js";
import { bounded, deferred, namespace, options } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); });
it("uses native list_complete, not empty/short length, and consumes only successful cursors", async () => {
  let requests = 0; const binding = namespace();
  binding.list = (input) => { expect(input.prefix).toBe("tenant:"); expect(input.limit).toBe(2); return Promise.resolve(++requests === 1 ? { keys: [], list_complete: false, cursor: "native-a" } : { keys: [{ name: "tenant:a", metadata: [false, null] }], list_complete: true, cursor: "ignored-terminal" }); };
  const database = new WorkersKvDatabase(binding, options);
  const first = await database.list({ prefix: "tenant:", limit: 2 }); expect(first.complete).toBe(false); expect(first.keys).toEqual([]); expect(first.nextCursor).toMatch(/^[a-f0-9]{48}$/u);
  if (first.nextCursor === undefined) throw new Error("no cursor");
  const second = await database.list({ prefix: "tenant:", limit: 2, cursor: first.nextCursor }); expect(second.complete).toBe(true); expect(second.nextCursor).toBeUndefined();
  await expect(database.list({ prefix: "tenant:", limit: 2, cursor: first.nextCursor })).rejects.toMatchObject({ code: "input" }); expect(requests).toBe(2); database.close();
});
it("preserves a prior cursor after malformed/foreign returned keys and failed delivery", async () => {
  let requests = 0; const binding = namespace();
  binding.list = (input) => { requests++; return Promise.resolve(input.cursor === undefined ? { keys: [], list_complete: false, cursor: "native-a" } : requests === 2 ? { keys: [{ name: "foreign:a" }], list_complete: true } : { keys: [{ name: "tenant:a" }], list_complete: true }); };
  const database = new WorkersKvDatabase(binding, options); const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  const request = { prefix: "tenant:", limit: 1, cursor: first.nextCursor };
  await expect(database.list(request)).rejects.toMatchObject({ code: "permission" });
  const caller = new AbortController(); await expect(database.mapList(request, () => { caller.abort(); return 1; }, caller.signal)).rejects.toMatchObject({ reason: "caller" });
  expect((await database.list(request)).keys[0]?.name).toBe("tenant:a"); expect(requests).toBe(4); database.close();
});
it("preserves the last ACKed UTF8 boundary across resumed and empty pages before callbacks or ACK", async () => {
  for (const intermediateEmpty of [false, true]) {
    let calls = 0; let bad = true; const binding = namespace();
    binding.list = (request) => {
      calls++;
      if (request.cursor === undefined) return Promise.resolve({ keys: [{ name: "tenant:z" }], list_complete: false, cursor: "owned-a" });
      if (intermediateEmpty && request.cursor === "owned-a") return Promise.resolve({ keys: [], list_complete: false, cursor: "owned-b" });
      expect(request.cursor).toBe(intermediateEmpty ? "owned-b" : "owned-a");
      if (bad) { bad = false; return Promise.resolve({ keys: [{ name: "tenant:a" }], list_complete: true }); }
      return Promise.resolve({ keys: [{ name: "tenant:zz" }], list_complete: true });
    };
    const database = new WorkersKvDatabase(binding, { ...options, maxPages: intermediateEmpty ? 4 : 3 });
    let prior = await database.list({ prefix: "tenant:", limit: 1 });
    if (prior.nextCursor === undefined) throw new Error("missing source cursor");
    if (intermediateEmpty) { prior = await database.list({ prefix: "tenant:", limit: 1, cursor: prior.nextCursor }); expect(prior.keys).toEqual([]); }
    if (prior.nextCursor === undefined) throw new Error("missing continued cursor");
    const request = { prefix: "tenant:", limit: 1, cursor: prior.nextCursor }; const factory = vi.fn(() => 1);
    await expect(database.mapList(request, factory)).rejects.toMatchObject({ code: "protocol" }); expect(factory).not.toHaveBeenCalled();
    const recovered = await database.list(request); expect(recovered.keys[0]?.name).toBe("tenant:zz"); expect(recovered.complete).toBe(true); expect(calls).toBe(intermediateEmpty ? 4 : 3);
    await expect(database.list(request)).rejects.toMatchObject({ code: "input" }); database.close();
  }
});
it("compares source keys in UTF8 byte order and rejects repeated/nonprogressing cursors", async () => {
  const binding = namespace(); binding.list = () => Promise.resolve({ keys: [{ name: "tenant:\ue000" }, { name: "tenant:𐀀" }], list_complete: true });
  const database = new WorkersKvDatabase(binding, options); expect((await database.list({ prefix: "tenant:", limit: 2 })).keys).toHaveLength(2);
  binding.list = () => Promise.resolve({ keys: [{ name: "tenant:𐀀" }, { name: "tenant:\ue000" }], list_complete: true });
  await expect(database.list({ prefix: "tenant:", limit: 2 })).rejects.toMatchObject({ code: "protocol" });
  binding.list = () => Promise.resolve({ keys: [], list_complete: false, cursor: "same" });
  const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  await expect(database.list({ prefix: "tenant:", limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "protocol" }); database.close();
});
it("binds prefix/page/instance, retains whole-journey page budgets and scopes namespace access explicitly", async () => {
  const binding = namespace(); let calls = 0; binding.list = () => Promise.resolve({ keys: [], list_complete: false, cursor: `next-${String(++calls)}` });
  const database = new WorkersKvDatabase(binding, { ...options, maxPages: 2 }); const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  await expect(database.list({ prefix: "tenant:x", limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "input" });
  await expect(database.list({ prefix: "tenant:", limit: 2, cursor: first.nextCursor })).rejects.toMatchObject({ code: "input" });
  const other = new WorkersKvDatabase(binding, options); await expect(other.list({ prefix: "tenant:", limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "input" });
  const second = await database.list({ prefix: "tenant:", limit: 1, cursor: first.nextCursor }); if (second.nextCursor === undefined) throw new Error("no cursor");
  await expect(database.list({ prefix: "tenant:", limit: 1, cursor: second.nextCursor })).rejects.toMatchObject({ code: "bounds" });
  await expect(database.list({ prefix: "" })).rejects.toMatchObject({ code: "permission" }); expect(calls).toBe(2); database.close(); other.close();
});
it("bounds aggregate retained nodes and preserves a refused prior cursor plus spent work", async () => {
  let requests = 0; const binding = namespace();
  binding.list = () => { const n = ++requests; return Promise.resolve(n === 1 ? { keys: [{ name: "tenant:a" }], list_complete: false, cursor: "a" } : n === 2 ? { keys: [{ name: "tenant:b" }], list_complete: false, cursor: "b" } : { keys: [{ name: "tenant:b" }], list_complete: true }); };
  const database = new WorkersKvDatabase(binding, { ...options, maxCursorNodes: 8, maxPages: 3 });
  const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  const request = { prefix: "tenant:", limit: 1, cursor: first.nextCursor };
  await expect(database.list(request)).rejects.toMatchObject({ code: "bounds" });
  expect((await database.list(request)).complete).toBe(true); expect(requests).toBe(3);
  expect((await database.list({ prefix: "tenant:", limit: 1 })).complete).toBe(true); database.close();
});
it("atomically admits concurrent cursor ACKs, refunds Close and expires fixed journeys", async () => {
  const ready = deferred<undefined>(); const release = deferred<undefined>(); let calls = 0;
  const binding = namespace(); binding.list = () => { if (++calls === 2) ready.resolve(undefined); return release.promise.then(() => ({ keys: [], list_complete: false, cursor: "next" })); };
  const database = new WorkersKvDatabase(binding, { ...options, maxCursorNodes: 8 });
  const a = database.list({ prefix: "tenant:", limit: 1 }); const b = database.list({ prefix: "tenant:x", limit: 1 });
  await bounded(ready.promise); release.resolve(undefined); const results = await Promise.allSettled([a, b]); expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  database.close(); await expect(database.list({ prefix: "tenant:", limit: 1 })).rejects.toMatchObject({ code: "closed" });
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  binding.list = () => Promise.resolve({ keys: [], list_complete: false, cursor: "next" });
  const expiring = new WorkersKvDatabase(binding, { ...options, cursorTtlMs: 10, maxCursorNodes: 7 });
  const first = await expiring.list({ prefix: "tenant:", limit: 1 }); now = 11;
  expect((await expiring.list({ prefix: "tenant:", limit: 1 })).nextCursor).toBeDefined();
  if (first.nextCursor === undefined) throw new Error("no cursor"); await expect(expiring.list({ prefix: "tenant:", limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "input" }); expiring.close();
});
