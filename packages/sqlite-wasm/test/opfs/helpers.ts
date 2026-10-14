import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { CanonicalPin, ClosableOo1Db, DatasetPool } from "../../src/opfs/canonical.js";
import type { Sqlite3Like } from "../../src/opfs/engine.js";
import type { ProbeDirectoryHandle, SahPoolUtilLike } from "../../src/opfs/pool.js";
import { serveDemoDbWorker, type ServeDemoDbWorkerOptions } from "../../src/opfs/worker.js";
import type { WorkerLike } from "../../src/opfs/client.js";

export const sqlite3 = await sqlite3InitModule();
// oo1 logs every failed sqlite3_step(); constraint failures are expected in these tests.
(sqlite3.config as { warn: (...args: unknown[]) => void }).warn = () => undefined;
export const sqliteLike = sqlite3 as unknown as Sqlite3Like;

/** A private in-memory database, loaded from bytes when given. */
export function memoryDb(bytes?: Uint8Array): ClosableOo1Db {
  const db = new sqlite3.oo1.DB(":memory:");
  if (bytes !== undefined) {
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = sqlite3.capi.sqlite3_deserialize(db, "main", pointer, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc !== 0) throw new Error(`deserialize ${String(rc)}`);
  }
  return db;
}

export function exportDb(db: ClosableOo1Db): Uint8Array {
  return sqlite3.capi.sqlite3_js_db_export(db as unknown as InstanceType<typeof sqlite3.oo1.DB>);
}

/** A small database file: artists and albums with a foreign key. */
export function sampleBytes(extra = ""): Uint8Array {
  const db = memoryDb();
  (db as unknown as { exec(sql: string): void }).exec(`
    CREATE TABLE Artist (ArtistId INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE Album (AlbumId INTEGER PRIMARY KEY, Title TEXT NOT NULL, ArtistId INTEGER NOT NULL REFERENCES Artist (ArtistId));
    INSERT INTO Artist VALUES (1, 'AC/DC'), (2, 'Accept'), (3, 'Unreferenced');
    INSERT INTO Album VALUES (1, 'For Those About To Rock', 1), (2, 'Balls to the Wall', 2);
    ${extra}`);
  const bytes = exportDb(db);
  db.close();
  return bytes;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pinFor(bytes: Uint8Array, dataset = "sample", url = "https://demo.test/sample.sqlite"): CanonicalPin {
  return { dataset, url, sha256: sha256(bytes), bytes: bytes.length };
}

export function gzip(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(bytes));
}

/** A fetch that serves the given bodies by absolute URL (a number is an HTTP status). */
export function serve(files: Readonly<Record<string, Uint8Array | number>>): ((input: string) => Promise<Response>) & { readonly calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (input: string): Promise<Response> => {
    calls.push(input);
    const body = Object.hasOwn(files, input) ? files[input] : 404;
    if (typeof body === "number") return Promise.resolve(new Response(null, { status: body }));
    return Promise.resolve(new Response(body as Uint8Array<ArrayBuffer>));
  };
  return Object.assign(fetchFn, { calls });
}

/**
 * An in-memory stand-in for the OPFS SAH pool: files are byte arrays, an open
 * file is a deserialized database written back on close.
 */
export class FakePool implements DatasetPool, SahPoolUtilLike {
  public readonly files = new Map<string, Uint8Array>();
  public readonly opened = new Map<string, ClosableOo1Db>();
  public paused = false;
  public readonly calls: string[] = [];
  /** Makes the next `open` calls of these paths throw. */
  public readonly failOpen = new Map<string, number>();
  public readonly OpfsSAHPoolDb: new (filename: string) => ClosableOo1Db;

  public constructor() {
    const open = this.open.bind(this);
    // Called with `new`; returning an object from a constructor makes it the result.
    this.OpfsSAHPoolDb = function OpfsSAHPoolDb(filename: string) { return open(filename); } as unknown as new (filename: string) => ClosableOo1Db;
  }

  public getFileNames(): string[] { return [...this.files.keys()]; }

  public importDb(name: string, bytes: Uint8Array): Promise<number> {
    this.calls.push(`import ${name}`);
    this.files.set(name, bytes.slice());
    return Promise.resolve(bytes.length);
  }

  public exportFile(name: string): Uint8Array {
    const live = this.opened.get(name);
    if (live !== undefined) return exportDb(live);
    const bytes = this.files.get(name);
    if (bytes === undefined) throw new Error(`no such file ${name}`);
    return bytes.slice();
  }

  public unlink(name: string): boolean {
    this.calls.push(`unlink ${name}`);
    return this.files.delete(name);
  }

  public open(name: string): ClosableOo1Db {
    const failures = this.failOpen.get(name) ?? 0;
    if (failures > 0) {
      this.failOpen.set(name, failures - 1);
      throw new Error(`file is not a database: ${name}`);
    }
    // Like OPFS, another context sees the writes of a connection that is still open.
    const live = this.opened.get(name);
    const db = memoryDb(live === undefined ? this.files.get(name) : exportDb(live));
    const wrapper: ClosableOo1Db = {
      exec: (options) => db.exec(options),
      changes: () => db.changes(),
      close: () => {
        if (this.opened.get(name) === db) {
          this.files.set(name, exportDb(db));
          this.opened.delete(name);
        }
        db.close();
      },
    };
    this.opened.set(name, db);
    return wrapper;
  }

  public reserveMinimumCapacity(minCapacity: number): Promise<number> { return Promise.resolve(minCapacity); }

  public isPaused(): boolean { return this.paused; }

  public pauseVfs(): unknown {
    this.paused = true;
    return this;
  }

  public unpauseVfs(): Promise<unknown> {
    this.paused = false;
    return Promise.resolve(this);
  }
}

/** A directory with no files, for the pool's lock probe. */
export const emptyDirectory: ProbeDirectoryHandle = {
  getDirectoryHandle: () => Promise.resolve(emptyDirectory),
  values: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }),
};

/** Web Locks with exclusive, first-come grants. */
interface LockRequest { readonly name: string; readonly callback: (lock: unknown) => Promise<void>; resolve(value: unknown): void; reject(error: unknown): void }

export class FakeLocks {
  readonly #queue: LockRequest[] = [];
  readonly #held = new Set<string>();

  public request(name: string, options: { readonly signal: AbortSignal }, callback: (lock: unknown) => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = { name, callback, resolve, reject };
      options.signal.addEventListener("abort", () => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
      this.#queue.push(entry);
      this.#pump(name);
    });
  }

  public held(name: string): boolean { return this.#held.has(name); }

  #pump(name: string): void {
    if (this.#held.has(name)) return;
    const index = this.#queue.findIndex((entry) => entry.name === name);
    if (index < 0) return;
    const [entry] = this.#queue.splice(index, 1) as [LockRequest];
    this.#held.add(name);
    void Promise.resolve().then(() => entry.callback({ name })).then(
      (value) => { this.#held.delete(name); entry.resolve(value); this.#pump(name); },
      (error: unknown) => { this.#held.delete(name); entry.reject(error); this.#pump(name); },
    );
  }
}

/** BroadcastChannels connected through one hub; delivery is asynchronous and skips the sender. */
export class ChannelHub {
  readonly #channels = new Set<FakeChannel>();
  public readonly log: unknown[] = [];

  public create(): FakeChannel {
    const channel = new FakeChannel(this);
    this.#channels.add(channel);
    return channel;
  }

  public broadcast(from: FakeChannel, message: unknown): void {
    this.log.push(message);
    for (const channel of this.#channels) {
      if (channel === from) continue;
      const data = structuredClone(message);
      setTimeout(() => { channel.deliver(data); }, 0);
    }
  }

  public remove(channel: FakeChannel): void { this.#channels.delete(channel); }
}

export class FakeChannel {
  readonly #hub: ChannelHub;
  readonly #target = new EventTarget();
  public closed = false;

  public constructor(hub: ChannelHub) { this.#hub = hub; }

  public postMessage(message: unknown): void {
    if (this.closed) throw new Error("channel closed");
    this.#hub.broadcast(this, message);
  }

  public deliver(data: unknown): void {
    if (!this.closed) this.#target.dispatchEvent(new MessageEvent("message", { data }));
  }

  public addEventListener(type: "message", listener: (event: MessageEvent) => void): void { this.#target.addEventListener(type, listener as EventListener); }

  public removeEventListener(type: "message", listener: (event: MessageEvent) => void): void { this.#target.removeEventListener(type, listener as EventListener); }

  public close(): void {
    this.closed = true;
    this.#hub.remove(this);
  }
}

/** Lets 20 rounds of zero-delay timers (message hops) and then `ms` more run. */
export async function settle(ms = 5): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A dataset worker running in this thread, with structured-clone message passing. */
export class InProcessWorker implements WorkerLike {
  readonly #inbox = new EventTarget();
  readonly #outbox = new EventTarget();
  public terminated = false;
  public readonly posted: unknown[] = [];

  public constructor(options: ServeDemoDbWorkerOptions) {
    serveDemoDbWorker({
      ...options,
      scope: {
        addEventListener: (type, listener) => { this.#inbox.addEventListener(type, listener as EventListener); },
        postMessage: (message) => {
          if (this.terminated) return;
          const data = structuredClone(message);
          setTimeout(() => { if (!this.terminated) this.#outbox.dispatchEvent(new MessageEvent("message", { data })); }, 0);
        },
      },
    });
  }

  public postMessage(message: unknown): void {
    if (this.terminated) return;
    this.posted.push(message);
    const data = structuredClone(message);
    setTimeout(() => { this.#inbox.dispatchEvent(new MessageEvent("message", { data })); }, 0);
  }

  public addEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void {
    this.#outbox.addEventListener(type, listener);
  }

  public terminate(): void { this.terminated = true; }

  /** Fires the worker's `error` event, as an uncaught exception or a crash does. */
  public crash(message?: string): void {
    this.#outbox.dispatchEvent(Object.assign(new Event("error"), message === undefined ? {} : { message }));
  }
}
