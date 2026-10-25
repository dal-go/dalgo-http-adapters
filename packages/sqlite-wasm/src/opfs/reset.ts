import {
  CanonicalIntegrityError,
  importWorking,
  prepareConnection,
  pristineBytes,
  sha256Hex,
  workingPath,
  type CanonicalPin,
  type ClosableOo1Db,
  type DatasetPool,
  type OpenedDatabase,
  type StoragePolicy,
} from "./canonical.js";
import type { ProgressReporter } from "./progress.js";

/** What `reset()` restored. */
export interface ResetResult {
  readonly canonical: { readonly sha256: string };
}

async function openVerified(open: () => ClosableOo1Db, exportBytes: (db: ClosableOo1Db) => Uint8Array, sha256: string): Promise<OpenedDatabase> {
  const db = open();
  try {
    const opened = await prepareConnection(db);
    const actual = await sha256Hex(exportBytes(db));
    if (actual !== sha256) throw new CanonicalIntegrityError(`reset produced SHA-256 ${actual}, expected ${sha256}`);
    return opened;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface ResetWorkingCopyOptions {
  /** Default `"working-and-pristine"`. */
  readonly storagePolicy?: StoragePolicy | undefined;
  readonly progress?: ProgressReporter | undefined;
}

/**
 * Restores the OPFS working copy and reopens it, checking that it is
 * byte-identical to the pin. The working file is unlinked before the import
 * (dropping its journal), so a crash in between leaves no working copy and
 * the next open writes it again.
 *
 * - `"working-and-pristine"`: closes the connection, then restores from the
 *   pristine copy; a pristine copy that no longer matches its pin is
 *   downloaded again.
 * - `"single-copy"`: downloads and verifies the pinned file first, while the
 *   connection is still open, so a failed download leaves the working copy
 *   and the connection as they were (the error is thrown with `current`
 *   still open); then closes the connection and replaces the file.
 */
export async function resetWorkingCopy(
  pool: DatasetPool,
  pin: CanonicalPin,
  current: Pick<ClosableOo1Db, "close">,
  download: () => Promise<Uint8Array>,
  options: ResetWorkingCopyOptions = {},
): Promise<OpenedDatabase> {
  const { progress } = options;
  let bytes: Uint8Array;
  if (options.storagePolicy === "single-copy") {
    bytes = await download();
    current.close();
  } else {
    current.close();
    bytes = await pristineBytes(pool, pin, download, progress);
  }
  await importWorking(pool, pin, bytes, progress);
  const working = workingPath(pin);
  progress?.({ phase: "open" });
  return openVerified(() => pool.open(working), () => pool.exportFile(working), pin.sha256);
}

/** Restores an in-memory fallback database from the verified canonical bytes it was opened from. */
export function resetInMemory(
  current: Pick<ClosableOo1Db, "close">,
  pristine: Uint8Array,
  sha256: string,
  memory: { open(bytes: Uint8Array): ClosableOo1Db; export(db: ClosableOo1Db): Uint8Array },
): Promise<OpenedDatabase> {
  current.close();
  return openVerified(() => memory.open(pristine), (db) => memory.export(db), sha256);
}
