import {
  AlreadyExistsError,
  NotFoundError,
  identityCodec,
  type Codec,
  type Database,
  type Key,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type QueryPage,
  type UpdateData,
} from "@dalgo/core";
import { serializeKey } from "./path.js";
import { executeQuery, type StoredRecord } from "./query.js";

export const DALGO_RECORD_STORE = "__dalgo_records";

export interface IndexedDbDatabaseOptions {
  readonly name: string;
  readonly version?: number;
  readonly factory?: IDBFactory;
  /** When supplied, create one object store per named collection instead of the shared record store. */
  readonly collections?: readonly string[];
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function requestResult<T>(request: IDBRequest<T>, keepTransactionAlive = false): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve(request.result);
    }, { once: true });
    request.addEventListener("error", (event) => {
      if (keepTransactionAlive) {
        event.preventDefault();
        event.stopPropagation();
      }
      reject(request.error ?? new Error("IndexedDB request failed"));
    }, { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => {
      resolve();
    }, { once: true });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    }, { once: true });
  });
}

function storedRecord<T>(key: Key, data: T, codec?: Codec<T>): StoredRecord {
  return {
    path: key.path,
    collectionPath: key.collectionPath,
    collectionName: key.collection,
    id: key.id,
    keyParts: serializeKey(key),
    data: codecOrIdentity(codec).encode(data),
  };
}

function snapshot<T>(key: Key, stored: StoredRecord | undefined, codec?: Codec<T>): RecordSnapshot<T> {
  if (stored === undefined) return { key, exists: false, metadata: { source: "indexeddb" } };
  return {
    key,
    exists: true,
    data: codecOrIdentity(codec).decode(stored.data),
    metadata: { source: "indexeddb" },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyUpdate(data: unknown, update: UpdateData): unknown {
  if (!isObject(data)) throw new TypeError("DALgo updates require object record data");
  const result: Record<string, unknown> = { ...data };
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    if (parts.some((part) => part.length === 0)) throw new TypeError(`invalid update field path: ${path}`);
    let target = result;
    for (const part of parts.slice(0, -1)) {
      const child = target[part];
      target[part] = isObject(child) ? { ...child } : {};
      target = target[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1);
    if (leaf !== undefined) target[leaf] = value;
  }
  return result;
}

class IndexedDbReadwriteTransaction implements ReadwriteTransaction {
  readonly #storeForKey: (key: Key) => IDBObjectStore;

  public constructor(storeForKey: (key: Key) => IDBObjectStore) {
    this.#storeForKey = storeForKey;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const stored = await requestResult(this.#storeForKey(key).get(key.path)) as StoredRecord | undefined;
    return snapshot(key, stored, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    const records: RecordSnapshot<T>[] = [];
    for (const key of keys) records.push(await this.get(key, codec));
    return records;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    try {
      await requestResult(this.#storeForKey(key).add(storedRecord(key, data, codec)), true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "ConstraintError") {
        throw new AlreadyExistsError(key, { cause: error });
      }
      throw error;
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    await requestResult(this.#storeForKey(key).put(storedRecord(key, data, codec)));
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const store = this.#storeForKey(key);
    const existing = await requestResult(store.get(key.path)) as StoredRecord | undefined;
    if (existing === undefined) throw new NotFoundError(key);
    await requestResult(store.put({ ...existing, data: applyUpdate(existing.data, data) }));
  }

  public async delete(key: Key): Promise<void> {
    await requestResult(this.#storeForKey(key).delete(key.path));
  }
}

export class IndexedDbDatabase implements Database {
  public readonly name: string;
  public readonly version: number;
  readonly #factory: IDBFactory;
  readonly #collections: readonly string[] | undefined;
  #databasePromise: Promise<IDBDatabase> | undefined;

  public constructor(options: IndexedDbDatabaseOptions) {
    if (options.name.trim().length === 0) throw new TypeError("IndexedDB database name is required");
    if (options.version !== undefined && (!Number.isSafeInteger(options.version) || options.version <= 0)) {
      throw new RangeError("IndexedDB version must be a positive safe integer");
    }
    const factory = options.factory ?? globalThis.indexedDB;
    if (options.collections !== undefined) {
      if (options.collections.length === 0 || options.collections.some((name) =>
        name.trim().length === 0 || name.includes("/") || name === DALGO_RECORD_STORE
      ) || new Set(options.collections).size !== options.collections.length) {
        throw new TypeError("IndexedDB collections must be unique, nonempty collection names");
      }
    }
    this.name = options.name;
    this.version = options.version ?? 1;
    this.#factory = factory;
    this.#collections = options.collections === undefined ? undefined : [...options.collections];
  }

  private storeName(collection: string): string {
    if (this.#collections === undefined) return DALGO_RECORD_STORE;
    if (!this.#collections.includes(collection)) throw new TypeError(`IndexedDB collection is not configured: ${collection}`);
    return collection;
  }

  private storeNames(): readonly string[] {
    return this.#collections ?? [DALGO_RECORD_STORE];
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const database = await this.open();
    const storeName = this.storeName(key.collection);
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const record = await requestResult(transaction.objectStore(storeName).get(key.path)) as StoredRecord | undefined;
    await done;
    return snapshot(key, record, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    const database = await this.open();
    const transaction = database.transaction(this.storeNames(), "readonly");
    const done = transactionDone(transaction);
    const records = await Promise.all(keys.map(async (key) => {
      const record = await requestResult(transaction.objectStore(this.storeName(key.collection)).get(key.path)) as StoredRecord | undefined;
      return snapshot(key, record, codec);
    }));
    await done;
    return records;
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const database = await this.open();
    const storeName = this.storeName(query.source.name);
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const result = await executeQuery(transaction.objectStore(storeName), query);
    await done;
    return result;
  }

  public async runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    const database = await this.open();
    const nativeTransaction = database.transaction(this.storeNames(), "readwrite");
    const done = transactionDone(nativeTransaction);
    const transaction = new IndexedDbReadwriteTransaction((key) => nativeTransaction.objectStore(this.storeName(key.collection)));
    try {
      const result = await callback(transaction);
      await done;
      return result;
    } catch (error) {
      try {
        nativeTransaction.abort();
      } catch {
        // The transaction may already have aborted or completed.
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    const pending = this.#databasePromise;
    this.#databasePromise = undefined;
    if (pending !== undefined) (await pending).close();
  }

  private open(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise((resolve, reject) => {
      const request = this.#factory.open(this.name, this.version);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        for (const storeName of this.storeNames()) {
          const store = database.objectStoreNames.contains(storeName)
            ? request.transaction?.objectStore(storeName)
            : database.createObjectStore(storeName, { keyPath: "path" });
          if (store === undefined) throw new Error("IndexedDB upgrade transaction is unavailable");
          if (!store.indexNames.contains("collectionPath")) store.createIndex("collectionPath", "collectionPath");
          if (!store.indexNames.contains("collectionName")) store.createIndex("collectionName", "collectionName");
        }
      });
      request.addEventListener("success", () => {
        request.result.addEventListener("versionchange", () => {
          request.result.close();
        });
        resolve(request.result);
      }, { once: true });
      request.addEventListener("blocked", () => {
        reject(new Error(`opening IndexedDB database ${this.name} was blocked`));
      }, { once: true });
      request.addEventListener("error", () => {
        reject(request.error ?? new Error(`failed to open IndexedDB database ${this.name}`));
      }, { once: true });
    });
    return this.#databasePromise;
  }
}

export async function deleteIndexedDbDatabase(
  name: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<void> {
  await requestResult(factory.deleteDatabase(name));
}
