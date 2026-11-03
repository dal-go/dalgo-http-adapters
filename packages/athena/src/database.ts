import { Key, identityCodec, type Codec, type Database, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { AthenaNativeClient } from "./client.js";
import { fail, unsupported } from "./errors.js";
import type { AthenaNativePage, AthenaTable } from "./types.js";
import { array, field, text } from "./validation.js";
interface Captured { readonly key: Key; readonly table: AthenaTable; readonly idColumn: string; readonly id: string }
function rowData(page: AthenaNativePage, index: number): Record<string, string | null> {
  const row = page.rows[index]; if (row === undefined) throw fail("protocol");
  const result: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (let i = 0; i < page.columns.length; i++) { const column = page.columns[i]; if (column === undefined) throw fail("protocol"); result[column.name] = row[i] ?? null; } return result;
}
/** Optional configured string-key facade. Arbitrary native rows use ordinal pages. */
export class AthenaDatabase implements Database {
  readonly #client: AthenaNativeClient;
  public constructor(client: AthenaNativeClient) { this.#client = client; }
  public close(): void { this.#client.close(); }
  private capture(value: Key, check: () => void): Captured {
    check(); const collection = text(field(value, "collection"), 256), id = field(value, "id"), parent = field(value, "parent"); check();
    if (parent !== undefined || typeof id !== "string" || id.length > 16_384) throw fail("input");
    const table = this.#client.configuredTable(collection), idColumn = table.idColumn; if (idColumn === undefined) throw unsupported();
    return { key: new Key(collection, id), id, table, idColumn };
  }
  private queryFor(key: Captured): StructuredQuery<unknown> { return { source: { kind: "collection", name: key.key.collection }, filters: [{ field: key.idColumn, operator: "==", value: key.id }], orders: [], limit: 2 }; }
  private snapshot<T>(key: Captured, page: AthenaNativePage, codec: Codec<T> | undefined, check: () => void): RecordSnapshot<T> {
    check(); if (page.rows.length > 1) throw fail("protocol");
    if (page.rows.length === 0) return { key: key.key, exists: false };
    const data = rowData(page, 0); if (data[key.idColumn] !== key.id) throw fail("protocol");
    const decoder = codec ?? identityCodec; const result = decoder.decode(data); check(); return { key: key.key, exists: true, data: result as T };
  }
  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.getWithSignal(key, undefined, codec); }
  public getWithSignal<T>(key: Key, signal?: AbortSignal, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    let admitted: Captured | undefined;
    return this.#client.mapQueries(check => { admitted = this.capture(key, check); return [this.queryFor(admitted)]; }, (pages, check) => {
      const page = pages[0]; if (admitted === undefined || page === undefined) throw fail("protocol"); return this.snapshot(admitted, page, codec, check);
    }, signal);
  }
  public exists(key: Key, signal?: AbortSignal): Promise<boolean> {
    let admitted: Captured | undefined;
    return this.#client.mapQueries(check => { admitted = this.capture(key, check); return [this.queryFor(admitted)]; }, (pages, check) => {
      const page = pages[0]; if (page === undefined || admitted === undefined) throw fail("protocol");
      check(); if (page.rows.length > 1) throw fail("protocol"); if (page.rows.length === 0) return false;
      const data = rowData(page, 0); if (data[admitted.idColumn] !== admitted.id) throw fail("protocol"); check(); return true;
    }, signal);
  }
  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.getManyWithSignal(keys, undefined, codec); }
  public getManyWithSignal<T>(keys: readonly Key[], signal?: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    let admitted: Captured[] = [];
    return this.#client.mapQueries(check => {
      const copied = array(keys, 100); admitted = copied.map(value => this.capture(value as Key, check)); return admitted.map(value => this.queryFor(value));
    }, (pages, check) => admitted.map((key, index) => { check(); const page = pages[index]; if (page === undefined) throw fail("protocol"); return this.snapshot(key, page, codec, check); }), signal);
  }
  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> { return this.queryWithSignal(query, undefined); }
  public queryWithSignal<T>(query: StructuredQuery<T>, signal?: AbortSignal): Promise<QueryPage<T>> {
    let collection = "", idColumn = ""; let codec: Codec<T> = identityCodec as Codec<T>;
    return this.#client.mapQueries(check => {
      const source = field(query, "source"); collection = text(field(source, "name"), 256);
      const table = this.#client.configuredTable(collection); if (table.idColumn === undefined) throw unsupported(); idColumn = table.idColumn;
      const supplied = field(source, "codec"); if (supplied !== undefined) codec = supplied as Codec<T>; check(); return [query as StructuredQuery<unknown>];
    }, (pages, check) => {
      const page = pages[0]; if (page === undefined) throw fail("protocol"); const ids = new Set<string>();
      const records = page.rows.map((_row, index) => {
        check(); const data = rowData(page, index), id = data[idColumn];
        if (typeof id !== "string" || ids.has(id)) throw fail("protocol"); ids.add(id);
        const result = codec.decode(data); check(); return { key: new Key(collection, id), exists: true as const, data: result };
      }); check(); return { records };
    }, signal);
  }
  public runReadwriteTransaction<T>(callback: (transaction: ReadwriteTransaction) => Promise<T>): Promise<T> { void callback; return Promise.reject(unsupported()); }
}
