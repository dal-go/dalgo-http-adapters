import { Key, UnsupportedError, identityCodec, type Codec, type Database, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { CloudflareKvError, type KvEntry } from "./types.js";
import { copiedArray, utf8 } from "./validation.js";

export interface MappedKvReader {
  mapRead<T>(admit: (maximumKeys: number, check: () => void) => readonly string[], deliver: (values: readonly (KvEntry | null)[], check: () => void) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T>;
}

/** Explicit one configured logical collection; payload is original raw bytes. */
export class KvCoreDatabase implements Database {
  readonly #native: MappedKvReader;
  readonly #collection: string;
  public constructor(native: MappedKvReader, collection: string) { this.#native = native; this.#collection = utf8(collection, 128); }
  private key(value: unknown, check: () => void): Key {
    check(); if (!(value instanceof Key)) throw new UnsupportedError("KV original core key");
    const parent = value.parent; check(); const collection = value.collection; check(); const id: unknown = value.id; check();
    if (parent !== undefined || collection !== this.#collection || typeof id !== "string") throw new UnsupportedError("KV configured collection and original string key");
    return new Key(this.#collection, id);
  }
  private snapshot<T>(key: Key, row: KvEntry | null | undefined, codec: Codec<T> | undefined): RecordSnapshot<T> {
    if (row === null || row === undefined) return { key, exists: false };
    if (row.key !== key.id) throw new CloudflareKvError("protocol");
    const decoder = (codec ?? identityCodec) as Codec<T>;
    return { key, exists: true, data: decoder.decode(new Uint8Array(row.value)) };
  }
  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.getWithSignal(key, undefined, codec); }
  public getWithSignal<T>(key: Key, signal?: AbortSignal, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    let admitted: Key | undefined;
    return this.#native.mapRead((_maximumKeys, check) => { admitted = this.key(key, check); return [String(admitted.id)]; }, (rows, check) => { check(); if (admitted === undefined) throw new CloudflareKvError("protocol"); const result = this.snapshot(admitted, rows[0], codec); check(); return result; }, signal);
  }
  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.getManyWithSignal(keys, undefined, codec); }
  public getManyWithSignal<T>(keys: readonly Key[], signal?: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    let admitted: Key[] = [];
    return this.#native.mapRead((maximumKeys, check) => { admitted = copiedArray(keys, maximumKeys).map((key) => this.key(key, check)); return admitted.map((key) => String(key.id)); }, (rows, check) => rows.map((row, index) => { check(); const key = admitted[index]; if (key === undefined) throw new CloudflareKvError("protocol"); const result = this.snapshot(key, row, codec); check(); return result; }), signal);
  }
  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>>;
  public query<T>(): Promise<QueryPage<T>> { return Promise.reject(new UnsupportedError("Ordinary KV has native prefix listing, not a SQL/structured query engine")); }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result>;
  public runReadwriteTransaction<Result>(): Promise<Result> { return Promise.reject(new UnsupportedError("Ordinary KV does not provide atomic cross-key transactions")); }
}
