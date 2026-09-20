import { AlreadyExistsError, UnsupportedError, identityCodec, type Codec, type Database as DalDatabase, type ExistingRecord, type Key, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery, type UpdateData } from "@dal-go/dalgo";
import { get, ref, remove, runTransaction, set, update, type DataSnapshot, type Database, type DatabaseReference } from "firebase/database";
import { assertSafeKey, keyFromRtdbPath, rtdbCollectionPath } from "./path.js";
import { compileRtdbQuery } from "./query.js";

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }
function assertJson(value: unknown, seen = new Set<object>()): void { if (value === null || typeof value === "string" || typeof value === "boolean") return; if (typeof value === "number") { if (Number.isFinite(value) && !Object.is(value, -0)) return; } else if (Array.isArray(value)) { if (seen.has(value)) throw new UnsupportedError("RTDB cyclic write data"); seen.add(value); value.forEach((entry) => { assertJson(entry, seen); }); seen.delete(value); return; } else if (typeof value === "object") { if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new UnsupportedError("RTDB writes require plain JSON records"); if (seen.has(value)) throw new UnsupportedError("RTDB cyclic write data"); seen.add(value); for (const [key, entry] of Object.entries(value)) { if (key.length === 0 || /[.#$[\]/]/.test(key)) throw new UnsupportedError("RTDB update field paths"); assertJson(entry, seen); } seen.delete(value); return; } throw new UnsupportedError("RTDB writes require JSON-safe data"); }
function recordFromSnapshot<T>(snapshot: DataSnapshot, key: Key, codec?: Codec<T>): RecordSnapshot<T> { return snapshot.exists() ? { key, exists: true, data: codecOrIdentity(codec).decode(snapshot.val()) } : { key, exists: false }; }

export class RealtimeDatabase implements DalDatabase {
  public readonly database: Database;
  public constructor(database: Database) { this.database = database; }
  private reference(key: Key): DatabaseReference { assertSafeKey(key); return ref(this.database, key.path); }
  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return recordFromSnapshot(await get(this.reference(key)), key, codec); }
  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { if (keys.length > 100) throw new UnsupportedError("RTDB getMany accepts at most 100 keys"); const records: RecordSnapshot<T>[] = []; for (const key of keys) records.push(await this.get(key, codec)); return records; }
  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const encoded = codecOrIdentity(codec).encode(data); assertJson(encoded); const result = await runTransaction(this.reference(key), (current) => current === null ? encoded : undefined);
    if (!result.committed) throw new AlreadyExistsError(key);
  }
  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { const encoded = codecOrIdentity(codec).encode(data); assertJson(encoded); return set(this.reference(key), encoded); }
  public update(key: Key, data: UpdateData): Promise<void> { assertJson(data); return update(this.reference(key), data); }
  public delete(key: Key): Promise<void> { return remove(this.reference(key)); }
  public async query<T>(value: StructuredQuery<T>): Promise<QueryPage<T>> {
    const source = value.source;
    if (source.kind !== "collection") throw new UnsupportedError("RTDB collection-group queries");
    const collectionPath = rtdbCollectionPath(source);
    const snapshot = await get(compileRtdbQuery(ref(this.database, collectionPath), value));
    const records: ExistingRecord<T>[] = [];
    snapshot.forEach((child) => { records.push({ key: keyFromRtdbPath(`${collectionPath}/${child.key}`), exists: true, data: codecOrIdentity(source.codec).decode(child.val()) }); return false; });
    return { records };
  }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> { if (typeof callback !== "function") throw new TypeError("transaction callback is required"); return Promise.reject(new UnsupportedError("RTDB DALgo callback transactions: only single-location synchronous RTDB transactions exist")); }
}
