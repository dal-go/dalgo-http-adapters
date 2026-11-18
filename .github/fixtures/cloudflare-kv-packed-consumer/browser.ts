import { Key, type Database, type RecordSnapshot, type Codec } from "@dalgo/core";
import { QueryCancelledError as PublicCancellation } from "@dalgo/adapter-runtime";
import { WorkersKvDatabase, CloudflareKvError, QueryCancelledError, type WorkersKvNamespaceLike, type KvReader, type KvEntry, type KvListPage, type KvJson } from "@dalgo/cloudflare-kv";
import { CloudflareKvHttpDatabase } from "@dalgo/cloudflare-kv/browser";

declare const namespace: WorkersKvNamespaceLike;
declare const signal: AbortSignal;
const binding = new WorkersKvDatabase(namespace, { allowedPrefixes: ["tenant:"], maxConcurrent: 1 });
const reader: KvReader = binding;
const entry: Promise<KvEntry | null> = binding.get("tenant:a", signal);
const entries: Promise<readonly (KvEntry | null)[]> = binding.getMany(["tenant:a", "tenant:missing", "tenant:a"], signal);
const page: Promise<KvListPage> = binding.list({ prefix: "tenant:", limit: 10 }, signal);
const connection: Promise<void> = binding.testConnection("tenant:a", signal);
const core: Database = binding.asDatabase("items");
const codec: Codec<Uint8Array> = { encode: value => value, decode: value => { if (!(value instanceof Uint8Array)) throw new Error("expected native bytes"); return value; } };
const row: Promise<RecordSnapshot<Uint8Array>> = binding.asDatabase("items").getWithSignal(new Key("items", "tenant:a"), signal, codec);
const http = new CloudflareKvHttpDatabase({ endpoint: "https://app.example.test/kv", headers: () => ({ authorization: "Bearer synthetic-application-session" }) });
const browserReader: KvReader = http;
const metadata: KvJson = { native: [false, null, 1] };
void [reader, entry, entries, page, connection, core, row, browserReader, metadata, CloudflareKvError, QueryCancelledError === PublicCancellation];
import * as browserExports from "@dalgo/cloudflare-kv/browser";
// @ts-expect-error REST/API credentials are absent from the browser entry.
void browserExports.CloudflareKvRestDatabase;
// @ts-expect-error Node Buffer must not enter this DOM-only adapter program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter this DOM-only adapter program.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS must not enter this DOM-only adapter program.
type ForbiddenNamespace = NodeJS.Process;
