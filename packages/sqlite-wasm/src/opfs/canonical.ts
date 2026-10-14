import { enableForeignKeys, type SqliteDriver } from "../driver.js";
import { fromOo1Db, type Oo1DatabaseLike } from "../oo1.js";
import type { ProgressReporter } from "./progress.js";

/** One byte range of a split canonical file, verified before it is joined. */
export interface CanonicalPart {
  /** Resolved against the pin's `url`. */
  readonly url: string;
  /** Lowercase hex SHA-256 of the part's bytes as served. */
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Identifies the pristine copy of a demo dataset. `sha256` and `bytes` describe
 * the decoded SQLite file; a changed `sha256` is a new version of the dataset.
 */
export interface CanonicalPin {
  /** Dataset name: letters, digits, `_` and `-` (it names storage paths and locks). */
  readonly dataset: string;
  /** The file to fetch, or the base the `parts` URLs resolve against. */
  readonly url: string;
  /** Lowercase hex SHA-256 of the decoded SQLite file. */
  readonly sha256: string;
  /** Byte length of the decoded SQLite file. */
  readonly bytes: number;
  /** How the served bytes are encoded. Default: none. */
  readonly compression?: "gzip";
  /** The served bytes split into parts, joined in order before decoding. */
  readonly parts?: readonly CanonicalPart[];
}

/** The fetched canonical bytes do not match their pin. Never retried silently. */
export class CanonicalIntegrityError extends Error {
  public readonly code = "canonical_integrity" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanonicalIntegrityError";
  }
}

/** The canonical file (or one of its parts) could not be downloaded. */
export class CanonicalFetchError extends Error {
  public readonly code = "canonical_fetch" as const;
  public readonly status: number | undefined;

  public constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanonicalFetchError";
    this.status = status;
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const datasetPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function validSize(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0;
}

/** Throws a `TypeError` describing the first problem of a malformed pin. */
export function validatePin(pin: CanonicalPin): void {
  if (!datasetPattern.test(pin.dataset)) throw new TypeError(`invalid dataset name: ${JSON.stringify(pin.dataset)}`);
  if (typeof pin.url !== "string" || pin.url === "") throw new TypeError("pin.url must be a non-empty string");
  if (!sha256Pattern.test(pin.sha256)) throw new TypeError("pin.sha256 must be 64 lowercase hex characters");
  if (!validSize(pin.bytes)) throw new TypeError("pin.bytes must be a positive safe integer");
  const compression: unknown = pin.compression;
  if (compression !== undefined && compression !== "gzip") throw new TypeError(`unsupported compression: ${JSON.stringify(compression)}`);
  if (pin.parts === undefined) return;
  if (pin.parts.length === 0) throw new TypeError("pin.parts must not be empty");
  pin.parts.forEach((part, index) => {
    if (typeof part.url !== "string" || part.url === "") throw new TypeError(`pin.parts[${String(index)}].url must be a non-empty string`);
    if (!sha256Pattern.test(part.sha256)) throw new TypeError(`pin.parts[${String(index)}].sha256 must be 64 lowercase hex characters`);
    if (!validSize(part.bytes)) throw new TypeError(`pin.parts[${String(index)}].bytes must be a positive safe integer`);
  });
}

/** The storage directory of a dataset: `/demodb/<dataset>/`. */
export function datasetDirectory(dataset: string): string {
  return `/demodb/${dataset}/`;
}

/** The editable working copy: `/demodb/<dataset>/<sha256>.sqlite`. */
export function workingPath(pin: Pick<CanonicalPin, "dataset" | "sha256">): string {
  return `${datasetDirectory(pin.dataset)}${pin.sha256}.sqlite`;
}

/** The pristine copy used by reset: `/demodb/<dataset>/<sha256>.canonical`. */
export function canonicalPath(pin: Pick<CanonicalPin, "dataset" | "sha256">): string {
  return `${datasetDirectory(pin.dataset)}${pin.sha256}.canonical`;
}

/** SQLite's rollback journal of the working copy. */
export function journalPath(pin: Pick<CanonicalPin, "dataset" | "sha256">): string {
  return `${workingPath(pin)}-journal`;
}

/** Lowercase hex SHA-256 of the bytes (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Decodes a gzip stream with the platform's `DecompressionStream`. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    // DecompressionStream fails with a TypeError.
    throw new CanonicalIntegrityError(`canonical gzip stream is corrupt: ${(error as Error).message}`);
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readBody(response: Response, onChunk: ((bytes: number) => void) | undefined): Promise<Uint8Array> {
  const body = response.body;
  if (onChunk === undefined || body === null) return new Uint8Array(await response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onChunk(value.byteLength);
  }
  return concat(chunks);
}

interface DownloadObserver {
  readonly response?: (response: Response) => void;
  readonly chunk: (bytes: number) => void;
}

async function download(fetchFn: Fetch, url: string, observer: DownloadObserver | undefined): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new CanonicalFetchError(`failed to fetch ${url}`, undefined, { cause: error });
  }
  if (!response.ok) throw new CanonicalFetchError(`failed to fetch ${url}: HTTP ${String(response.status)}`, response.status);
  observer?.response?.(response);
  return readBody(response, observer?.chunk);
}

async function verify(bytes: Uint8Array, expected: { readonly sha256: string; readonly bytes: number }, label: string): Promise<void> {
  if (bytes.byteLength !== expected.bytes) {
    throw new CanonicalIntegrityError(`${label} is ${String(bytes.byteLength)} bytes, expected ${String(expected.bytes)}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected.sha256) throw new CanonicalIntegrityError(`${label} has SHA-256 ${actual}, expected ${expected.sha256}`);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const sqliteMagic = "SQLite format 3\u0000";

/**
 * A canonical file must be a SQLite database in rollback-journal mode: the
 * OPFS pool rewrites WAL headers on import, which would make the stored copy
 * differ from its pin.
 */
function checkSqliteHeader(bytes: Uint8Array, label: string): void {
  const magic = String.fromCharCode(...bytes.subarray(0, 16));
  if (magic !== sqliteMagic) throw new CanonicalIntegrityError(`${label} is not a SQLite database`);
  if (bytes[18] !== 1 || bytes[19] !== 1) throw new CanonicalIntegrityError(`${label} is in WAL mode; publish it in rollback-journal mode`);
}

function resolveUrl(url: string, base: string | undefined): string {
  return new URL(url, base).href;
}

/** A response's `Content-Length` when it is the length of the body as read (no `Content-Encoding`). */
function bodyLength(response: Response): number | undefined {
  if (response.headers.get("content-encoding") !== null) return undefined;
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/** Counts the bytes of a download and reports them as `fetch` progress (see {@link DemoDbProgressEvent}). */
function fetchProgress(pin: CanonicalPin, progress: ProgressReporter): DownloadObserver & { report(force: boolean): void } {
  let loaded = 0;
  let total: number | undefined = pin.parts !== undefined
    ? pin.parts.reduce((sum, part) => sum + part.bytes, 0)
    : pin.compression === undefined ? pin.bytes : undefined;
  const report = (force: boolean): void => {
    if (total !== undefined && loaded > total) total = undefined;
    progress({ phase: "fetch", loaded, ...(total === undefined ? {} : { total }) }, force);
  };
  return {
    report,
    ...(total === undefined ? { response: (response: Response) => { total = bodyLength(response); } } : {}),
    chunk: (bytes) => {
      loaded += bytes;
      report(false);
    },
  };
}

/**
 * Downloads and verifies a pinned canonical file: each part's size and SHA-256,
 * the gzip stream, and the decoded size and SHA-256. Relative URLs resolve
 * against `globalThis.location`. `progress` receives the `fetch` and `verify`
 * phases.
 */
export async function fetchCanonical(pin: CanonicalPin, fetchFn: Fetch = globalThis.fetch.bind(globalThis), progress?: ProgressReporter): Promise<Uint8Array> {
  validatePin(pin);
  const location = (globalThis as { readonly location?: { readonly href: string } }).location;
  const base = resolveUrl(pin.url, location?.href);
  const observer = progress === undefined ? undefined : fetchProgress(pin, progress);
  observer?.report(true);
  let served: Uint8Array;
  if (pin.parts === undefined) {
    served = await download(fetchFn, base, observer);
    observer?.report(true);
    progress?.({ phase: "verify" });
  } else {
    const parts = await Promise.all(pin.parts.map(async (part) => ({ part, bytes: await download(fetchFn, resolveUrl(part.url, base), observer) })));
    observer?.report(true);
    progress?.({ phase: "verify" });
    for (const [index, { part, bytes }] of parts.entries()) await verify(bytes, part, `${pin.dataset} part ${String(index + 1)}`);
    served = concat(parts.map(({ bytes }) => bytes));
  }
  const decoded = pin.compression === "gzip" ? await gunzip(served) : served;
  await verify(decoded, pin, `${pin.dataset} canonical file`);
  checkSqliteHeader(decoded, `${pin.dataset} canonical file`);
  return decoded;
}

/** An oo1 database that can be closed. */
export interface ClosableOo1Db extends Oo1DatabaseLike {
  close(): void;
}

/** The operations of the OPFS SAH pool (`SAHPoolUtil`) the dataset store uses. */
export interface DatasetPool {
  getFileNames(): string[];
  importDb(name: string, bytes: Uint8Array): Promise<number>;
  exportFile(name: string): Uint8Array;
  unlink(name: string): boolean;
  /** Opens (creating if needed) a database file of the pool. */
  open(name: string): ClosableOo1Db;
}

/** An open working copy. */
export interface OpenedDatabase {
  readonly db: ClosableOo1Db;
  readonly driver: SqliteDriver;
}

/** The outcome of {@link openCanonical}. */
export interface OpenedCanonical extends OpenedDatabase {
  /** True when files of another pinned version were deleted (the user's edits to it are gone). */
  readonly replacedPreviousVersion: boolean;
  /** True when the canonical file was downloaded and imported during this open. */
  readonly imported: boolean;
}

/** The working copy is damaged: `PRAGMA quick_check` failed, or SQLite reported it corrupt or not a database. */
export class CorruptDatabaseError extends Error {
  public readonly code = "corrupt_database" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptDatabaseError";
  }
}

/**
 * A dataset file could not be written or opened for a reason other than
 * corruption (quota, I/O, a full pool, foreign keys that cannot be enabled).
 * The working copy is left as it is.
 */
export class DatasetStorageError extends Error {
  public readonly code = "dataset_storage" as const;
  public readonly operation: "import" | "open";

  public constructor(operation: "import" | "open", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatasetStorageError";
    this.operation = operation;
  }
}

/** Checks the file's structure and turns foreign keys on. */
export async function prepareConnection(db: ClosableOo1Db): Promise<OpenedDatabase> {
  const driver = fromOo1Db(db);
  const { rows } = await driver.exec("PRAGMA quick_check");
  const verdict = rows.map((row) => String(row.quick_check)).join("; ");
  if (verdict !== "ok") throw new CorruptDatabaseError(`quick_check failed: ${verdict}`);
  await enableForeignKeys(driver);
  return { db, driver };
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an open failure means the file itself is damaged (and only then may it be replaced). */
export function isCorruption(error: unknown): boolean {
  if (error instanceof CorruptDatabaseError) return true;
  const code = (error as { readonly resultCode?: unknown } | null)?.resultCode;
  return typeof code === "number" && ((code & 0xff) === SQLITE_CORRUPT || (code & 0xff) === SQLITE_NOTADB);
}

/**
 * Opens and checks a pool file. A damaged file is returned as a
 * {@link CorruptDatabaseError}; any other failure is thrown as a
 * {@link DatasetStorageError}.
 */
async function tryOpen(pool: DatasetPool, path: string): Promise<OpenedDatabase | CorruptDatabaseError> {
  let db: ClosableOo1Db | undefined;
  try {
    db = pool.open(path);
    return await prepareConnection(db);
  } catch (error) {
    db?.close();
    if (error instanceof CorruptDatabaseError) return error;
    if (isCorruption(error)) return new CorruptDatabaseError(`${path} is damaged: ${message(error)}`, { cause: error });
    throw new DatasetStorageError("open", `could not open ${path}: ${message(error)}`, { cause: error });
  }
}

/**
 * Replaces a pool file. The pool's `importDb` overwrites a file in place and
 * never shrinks it, so the old file is unlinked first (the pool truncates its
 * slot). The pool names a slot only after the whole file is written, so a
 * crash during the import leaves the name missing rather than half-written.
 */
async function replaceFile(pool: DatasetPool, name: string, bytes: Uint8Array): Promise<void> {
  pool.unlink(name);
  try {
    await pool.importDb(name, bytes);
  } catch (error) {
    throw new DatasetStorageError("import", `could not write ${name}: ${message(error)}`, { cause: error });
  }
}

/** Writes the pristine copy. */
export function importPristine(pool: DatasetPool, pin: CanonicalPin, bytes: Uint8Array, progress?: ProgressReporter): Promise<void> {
  progress?.({ phase: "importPristine", total: bytes.byteLength });
  return replaceFile(pool, canonicalPath(pin), bytes);
}

/** Overwrites the working copy (and drops its journal, which belongs to the old file). */
export function importWorking(pool: DatasetPool, pin: CanonicalPin, bytes: Uint8Array, progress?: ProgressReporter): Promise<void> {
  progress?.({ phase: "importWorking", total: bytes.byteLength });
  pool.unlink(journalPath(pin));
  return replaceFile(pool, workingPath(pin), bytes);
}

/** The stored pristine copy when it still matches the pin. */
async function storedPristine(pool: DatasetPool, pin: CanonicalPin, progress: ProgressReporter | undefined): Promise<Uint8Array | undefined> {
  const path = canonicalPath(pin);
  if (!pool.getFileNames().includes(path)) return undefined;
  progress?.({ phase: "verify" });
  const stored = pool.exportFile(path);
  return stored.byteLength === pin.bytes && await sha256Hex(stored) === pin.sha256 ? stored : undefined;
}

/**
 * The pinned bytes: the stored pristine copy when it matches the pin,
 * otherwise downloaded and stored again as the pristine copy.
 */
export async function pristineBytes(pool: DatasetPool, pin: CanonicalPin, download: () => Promise<Uint8Array>, progress?: ProgressReporter): Promise<Uint8Array> {
  const stored = await storedPristine(pool, pin, progress);
  if (stored !== undefined) return stored;
  const bytes = await download();
  await importPristine(pool, pin, bytes, progress);
  return bytes;
}

/**
 * How many copies of the pinned version are kept in OPFS:
 *
 * - `"working-and-pristine"` (default): the working copy and a pristine copy;
 *   reset and repairs restore from the pristine copy without the network.
 * - `"single-copy"`: only the working copy (half the space). Reset and
 *   repairs download and verify the pinned file again.
 */
export type StoragePolicy = "working-and-pristine" | "single-copy";

export interface OpenCanonicalOptions {
  /** Default `"working-and-pristine"`. */
  readonly storagePolicy?: StoragePolicy | undefined;
  /** Receives the `importPristine`, `importWorking`, `verify` (of a stored pristine copy) and `open` phases. */
  readonly progress?: ProgressReporter | undefined;
}

/**
 * The bytes a working copy is written from in single-copy mode: a stored
 * pristine copy left by the other policy while it still matches the pin,
 * otherwise a download that is not stored.
 */
async function singleCopyBytes(pool: DatasetPool, pin: CanonicalPin, download: () => Promise<Uint8Array>, progress: ProgressReporter | undefined): Promise<Uint8Array> {
  return await storedPristine(pool, pin, progress) ?? download();
}

/**
 * Opens the working copy of the pinned version.
 *
 * - No working copy (first open, or a crash during an import): write it from
 *   the pristine copy, downloading that first when it is missing or altered.
 *   In single-copy mode the download is written as the working copy only.
 * - A working copy without a pristine copy: download and write only the
 *   pristine copy; the working copy and its edits are kept. In single-copy
 *   mode a missing pristine copy is expected and nothing is downloaded.
 * - A damaged working copy (see {@link isCorruption}): write it again from
 *   the pristine copy (single-copy: from a fresh download), once. Any other
 *   open failure is thrown as a {@link DatasetStorageError} and the working
 *   copy is not touched.
 *
 * Files of other versions of the dataset are deleted once the pinned version
 * is open; in single-copy mode, so is a pristine copy of the pinned version.
 */
export async function openCanonical(pool: DatasetPool, pin: CanonicalPin, download: () => Promise<Uint8Array>, options: OpenCanonicalOptions = {}): Promise<OpenedCanonical> {
  validatePin(pin);
  const { progress } = options;
  const single = options.storagePolicy === "single-copy";
  const working = workingPath(pin);
  const pristine = canonicalPath(pin);
  const names = pool.getFileNames();
  let imported = false;
  const fetchPin = (): Promise<Uint8Array> => {
    imported = true;
    return download();
  };
  const source = (): Promise<Uint8Array> => (single ? singleCopyBytes(pool, pin, fetchPin, progress) : pristineBytes(pool, pin, fetchPin, progress));
  let fresh = false;
  if (!names.includes(working)) {
    await importWorking(pool, pin, await source(), progress);
    fresh = true;
  } else if (!single && !names.includes(pristine)) {
    await importPristine(pool, pin, await fetchPin(), progress);
  }
  progress?.({ phase: "open" });
  let opened = await tryOpen(pool, working);
  if (opened instanceof CorruptDatabaseError && !fresh) {
    await importWorking(pool, pin, await source(), progress);
    progress?.({ phase: "open" });
    opened = await tryOpen(pool, working);
  }
  if (opened instanceof CorruptDatabaseError) throw opened;
  const directory = datasetDirectory(pin.dataset);
  const current = `${directory}${pin.sha256}.`;
  const stale = names.filter((name) => name.startsWith(directory) && !name.startsWith(current));
  for (const name of stale) pool.unlink(name);
  if (single && pool.getFileNames().includes(pristine)) pool.unlink(pristine);
  return { ...opened, imported, replacedPreviousVersion: stale.some((name) => name.endsWith(".sqlite")) };
}
