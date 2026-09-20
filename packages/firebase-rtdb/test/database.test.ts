/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- Firebase SDK module boundary is intentionally mocked */
import { AlreadyExistsError, Key, UnsupportedError, collection, type Codec } from "@dal-go/dalgo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  endAt: vi.fn(), endBefore: vi.fn(), equalTo: vi.fn(), get: vi.fn(), limitToFirst: vi.fn(), orderByChild: vi.fn(), orderByKey: vi.fn(), query: vi.fn((reference) => reference), ref: vi.fn((_database, path: string) => ({ path })), remove: vi.fn(), runTransaction: vi.fn(), set: vi.fn(), startAfter: vi.fn(), startAt: vi.fn(), update: vi.fn(),
}));
vi.mock("firebase/database", () => sdk);
const { RealtimeDatabase } = await import("../src/database.js");

const database = {} as never;
const key = new Key("items", "milk");
const codec: Codec<{ title: string }> = { encode: (value) => ({ name: value.title }), decode: (value) => ({ title: (value as { name: string }).name }) };
function snapshot(exists: boolean, value: unknown, children: readonly { key: string; value: unknown }[] = []) { return { exists: () => exists, val: () => value, forEach: (visitor: (child: ReturnType<typeof snapshot>) => boolean) => { children.forEach((child) => { visitor(snapshot(true, child.value, [] as const) as ReturnType<typeof snapshot> & { key: string }); }); }, key: "ignored" }; }

describe("RealtimeDatabase Web SDK contract", () => {
  beforeEach(() => { vi.clearAllMocks(); sdk.ref.mockImplementation((_database, path: string) => ({ path })); sdk.query.mockImplementation((reference) => reference); });
  it("maps existing/missing reads and codecs", async () => { const db = new RealtimeDatabase(database); sdk.get.mockResolvedValueOnce(snapshot(true, { name: "Milk" })).mockResolvedValueOnce(snapshot(false, null)); await expect(db.get(key, codec)).resolves.toMatchObject({ exists: true, data: { title: "Milk" }, key }); await expect(db.get(key)).resolves.toMatchObject({ exists: false, key }); expect(sdk.ref).toHaveBeenCalledWith(database, "items/milk"); });
  it("reads getMany in requested order and bounds fanout", async () => { const db = new RealtimeDatabase(database); sdk.get.mockResolvedValue(snapshot(true, { name: "x" })); const keys = [key, new Key("items", "bread")]; const records = await db.getMany(keys, codec); expect(records.map((record) => record.key.path)).toEqual(["items/milk", "items/bread"]); await expect(db.getMany(Array.from({ length: 101 }, (_, index) => new Key("items", String(index))))).rejects.toThrow(UnsupportedError); });
  it("uses atomic insert and surfaces conflicts", async () => { const db = new RealtimeDatabase(database); sdk.runTransaction.mockResolvedValueOnce({ committed: true }).mockResolvedValueOnce({ committed: false }); await db.insert(key, { title: "Milk" }, codec); expect(sdk.runTransaction).toHaveBeenCalledWith({ path: "items/milk" }, expect.any(Function)); expect(sdk.runTransaction.mock.calls[0]?.[1](null)).toEqual({ name: "Milk" }); await expect(db.insert(key, { title: "Milk" }, codec)).rejects.toThrow(AlreadyExistsError); });
  it("maps set/update/delete arguments", async () => { const db = new RealtimeDatabase(database); await db.set(key, { title: "Milk" }, codec); await db.update(key, { done: true }); await db.delete(key); expect(sdk.set).toHaveBeenCalledWith({ path: "items/milk" }, { name: "Milk" }); expect(sdk.update).toHaveBeenCalledWith({ path: "items/milk" }, { done: true }); expect(sdk.remove).toHaveBeenCalledWith({ path: "items/milk" }); });
  it("decodes queried child paths", async () => { const db = new RealtimeDatabase(database); sdk.get.mockResolvedValue({ forEach: (visitor: (child: { key: string; val: () => unknown }) => boolean) => { visitor({ key: "milk", val: () => ({ name: "Milk" }) }); }, exists: () => true, val: () => null }); const page = await db.query(collection<{ title: string }>("items", { codec }).query().orderBy("title").build()); expect(page.records).toEqual([{ key, exists: true, data: { title: "Milk" } }]); });
  it("rejects transactions without invoking their callback", async () => { const db = new RealtimeDatabase(database); const callback = vi.fn(); await expect(db.runReadwriteTransaction(callback)).rejects.toThrow(UnsupportedError); expect(callback).not.toHaveBeenCalled(); });
  it("rejects unsafe keys and non-JSON writes before SDK calls", async () => { const db = new RealtimeDatabase(database); await expect(db.get(new Key("items", "bad.name"))).rejects.toThrow(UnsupportedError); expect(() => { void db.set(key, { bad: undefined }); }).toThrow(UnsupportedError); expect(sdk.ref).not.toHaveBeenCalled(); expect(sdk.set).not.toHaveBeenCalled(); });
});
