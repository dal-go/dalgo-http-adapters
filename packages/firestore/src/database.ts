import {
  AlreadyExistsError,
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dalgo/core";
import {
  doc,
  getDoc,
  getDocs,
  runTransaction,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
  type UpdateData as FirestoreUpdateData,
  type WithFieldValue,
} from "firebase/firestore";
import { keyFromDocumentPath } from "./path.js";
import { compileFirestoreQuery, cursorFromSnapshot } from "./query.js";

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function documentReference(firestore: Firestore, key: Key): DocumentReference {
  return doc(firestore, key.path);
}

function recordFromSnapshot<T>(
  snapshot: DocumentSnapshot,
  requestedKey: Key | undefined,
  codec?: Codec<T>,
): RecordSnapshot<T> {
  const key = requestedKey ?? keyFromDocumentPath(snapshot.ref.path);
  const metadata = {
    fromCache: snapshot.metadata.fromCache,
    hasPendingWrites: snapshot.metadata.hasPendingWrites,
  };
  if (!snapshot.exists()) {
    return { key, exists: false, metadata };
  }
  return {
    key,
    exists: true,
    data: codecOrIdentity(codec).decode(snapshot.data()),
    metadata,
  };
}

class FirestoreReadwriteTransaction implements ReadwriteTransaction {
  readonly #firestore: Firestore;
  readonly #transaction: Transaction;
  #hasWrites = false;

  public constructor(firestore: Firestore, transaction: Transaction) {
    this.#firestore = firestore;
    this.#transaction = transaction;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    this.assertCanRead();
    const snapshot = await this.#transaction.get(documentReference(this.#firestore, key));
    return recordFromSnapshot(snapshot, key, codec);
  }

  public async getMany<T>(
    keys: readonly Key[],
    codec?: Codec<T>,
  ): Promise<readonly RecordSnapshot<T>[]> {
    const records: RecordSnapshot<T>[] = [];
    for (const key of keys) {
      records.push(await this.get(key, codec));
    }
    return records;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const existing = await this.get(key);
    if (existing.exists) {
      throw new AlreadyExistsError(key);
    }
    this.#transaction.set(
      documentReference(this.#firestore, key),
      codecOrIdentity(codec).encode(data) as WithFieldValue<DocumentData>,
    );
    this.#hasWrites = true;
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    this.#transaction.set(
      documentReference(this.#firestore, key),
      codecOrIdentity(codec).encode(data) as WithFieldValue<DocumentData>,
    );
    this.#hasWrites = true;
    return Promise.resolve();
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    this.#transaction.update(
      documentReference(this.#firestore, key),
      data as FirestoreUpdateData<DocumentData>,
    );
    this.#hasWrites = true;
    return Promise.resolve();
  }

  public delete(key: Key): Promise<void> {
    this.#transaction.delete(documentReference(this.#firestore, key));
    this.#hasWrites = true;
    return Promise.resolve();
  }

  private assertCanRead(): void {
    if (this.#hasWrites) {
      throw new UnsupportedError("Firestore transaction reads after writes");
    }
  }
}

export class FirestoreDatabase implements Database {
  public readonly firestore: Firestore;

  public constructor(firestore: Firestore) {
    this.firestore = firestore;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const snapshot = await getDoc(documentReference(this.firestore, key));
    return recordFromSnapshot(snapshot, key, codec);
  }

  public async getMany<T>(
    keys: readonly Key[],
    codec?: Codec<T>,
  ): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map(async (key) => this.get(key, codec)));
  }

  public async query<T>(dalQuery: StructuredQuery<T>): Promise<QueryPage<T>> {
    const compiled = compileFirestoreQuery(this.firestore, dalQuery);
    const snapshot = await getDocs(compiled.query);
    const records = snapshot.docs.map((document): ExistingRecord<T> => {
      const record = recordFromSnapshot(document, undefined, dalQuery.source.codec);
      if (!record.exists) {
        throw new Error(`query returned a missing Firestore document: ${document.ref.path}`);
      }
      return record;
    });
    const last = snapshot.docs.at(-1);
    const nextCursor = dalQuery.limit !== undefined && snapshot.size === dalQuery.limit && last !== undefined
      ? cursorFromSnapshot(last, compiled.orders)
      : undefined;
    return {
      records,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  public runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    return runTransaction(this.firestore, async (transaction) => callback(
      new FirestoreReadwriteTransaction(this.firestore, transaction),
    ));
  }
}
