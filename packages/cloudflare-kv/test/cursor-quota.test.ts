import { expect, it } from "vitest";
import { WorkersKvDatabase } from "../src/index.js";
import { namespace, options } from "./helpers.js";

it("bounds aggregate retained bytes and keeps a rejected successor retryable", async () => {
  let calls = 0; const binding = namespace();
  binding.list = (input) => {
    const n = ++calls;
    if (input.cursor === undefined) return Promise.resolve({ keys: [{ name: "tenant:a" }], list_complete: false, cursor: "a" });
    expect(input.cursor).toBe("a");
    return Promise.resolve(n === 2 ? { keys: [{ name: "tenant:b" }], list_complete: false, cursor: "b" } : { keys: [{ name: "tenant:b" }], list_complete: true });
  };
  const database = new WorkersKvDatabase(binding, { ...options, maxCursorBytes: 900 });
  const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  await expect(database.list({ prefix: "tenant:", limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "bounds" });
  expect((await database.list({ prefix: "tenant:", limit: 1, cursor: first.nextCursor })).complete).toBe(true);
  expect((await database.list({ prefix: "tenant:", limit: 1 })).nextCursor).toBeDefined(); expect(calls).toBe(4); database.close();
});
it("admits net replacement cost without evicting another live journey", async () => {
  let calls = 0; const binding = namespace();
  binding.list = (input) => {
    calls++;
    if (input.prefix === "tenant:x") return Promise.resolve(input.cursor === undefined ? { keys: [], list_complete: false, cursor: "x1" } : { keys: [], list_complete: true });
    if (input.cursor === undefined) return Promise.resolve({ keys: [{ name: "tenant:a" }], list_complete: false, cursor: "c1" });
    return Promise.resolve(input.cursor === "c1" ? { keys: [], list_complete: false, cursor: "c2" } : { keys: [], list_complete: true });
  };
  const database = new WorkersKvDatabase(binding, { ...options, maxCursorBytes: 1600 });
  const a = await database.list({ prefix: "tenant:", limit: 1 }); const b = await database.list({ prefix: "tenant:x", limit: 1 });
  if (a.nextCursor === undefined || b.nextCursor === undefined) throw new Error("no cursor");
  const next = await database.list({ prefix: "tenant:", limit: 1, cursor: a.nextCursor }); expect(next.nextCursor).toBeDefined();
  await expect(database.list({ prefix: "tenant:", limit: 1, cursor: a.nextCursor })).rejects.toMatchObject({ code: "input" });
  expect((await database.list({ prefix: "tenant:x", limit: 1, cursor: b.nextCursor })).complete).toBe(true);
  if (next.nextCursor === undefined) throw new Error("no successor"); expect((await database.list({ prefix: "tenant:", limit: 1, cursor: next.nextCursor })).complete).toBe(true);
  expect(calls).toBe(5); database.close();
});
