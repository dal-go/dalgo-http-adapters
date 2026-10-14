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
} from "./canonical.js";

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

/**
 * Restores the OPFS working copy from the pristine copy: closes the
 * connection, replaces the working file (dropping its journal), reopens it
 * and checks that it is byte-identical to the pin. A pristine copy that no
 * longer matches its pin is downloaded again.
 */
export async function resetWorkingCopy(
  pool: DatasetPool,
  pin: CanonicalPin,
  current: ClosableOo1Db,
  download: () => Promise<Uint8Array>,
): Promise<OpenedDatabase> {
  current.close();
  await importWorking(pool, pin, await pristineBytes(pool, pin, download));
  const working = workingPath(pin);
  return openVerified(() => pool.open(working), () => pool.exportFile(working), pin.sha256);
}

/** Restores an in-memory fallback database from the verified canonical bytes it was opened from. */
export function resetInMemory(
  current: ClosableOo1Db,
  pristine: Uint8Array,
  sha256: string,
  memory: { open(bytes: Uint8Array): ClosableOo1Db; export(db: ClosableOo1Db): Uint8Array },
): Promise<OpenedDatabase> {
  current.close();
  return openVerified(() => memory.open(pristine), (db) => memory.export(db), sha256);
}
