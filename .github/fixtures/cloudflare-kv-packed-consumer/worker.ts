// This separate official Worker ambient profile imports the REAL public type
// package. It never adds Node types or masks the adapter-only DOM gate.
import { WorkersKvDatabase, type WorkersKvNamespaceLike } from "@dalgo/cloudflare-kv/binding";
declare const officialNamespace: KVNamespace;
const assignment: WorkersKvNamespaceLike = officialNamespace;
const database = new WorkersKvDatabase(officialNamespace, { allowedPrefixes: ["tenant:"] });
const row = database.get("tenant:a");
void [assignment, row];
// The pinned official Worker declarations intentionally provide Buffer/process
// compatibility globals. Their presence is not an adapter declaration leak.
void [Buffer, process];
// @ts-expect-error Workers expose no browser document ambient global.
type ForbiddenWorkerDocument = typeof document;
// @ts-expect-error Workers expose no browser window ambient global.
type ForbiddenWorkerWindow = typeof window;
