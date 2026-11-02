# Native Cloudflare Workers KV reads

Source implementation for existing namespaces. This package is separate from
Cloudflare D1: ordinary KV exposes byte values and prefix listing, not a SQL
engine. Original UTF8 keys and raw value bytes are retained without a DALgo
storage envelope or automatic JSON/text coercion.
This profile covers ordinary Workers KV, not Workers KV Instant private beta or
Durable Objects.

Source, registry availability, and execution qualification are separate. No
Cloudflare account, namespace, API token, deployment, hosted authorization,
eventual-consistency behavior, Workers engine or actual browser/CORS acceptance
has been verified by this source change. The source tests include an owned local
HTTP protocol fixture and injected native bindings. They are not a KV service.

## Native borrowed Workers binding

```ts
import { WorkersKvDatabase } from "@dalgo/cloudflare-kv/binding";

const db = new WorkersKvDatabase(env.EXISTING_KV, {
  allowedPrefixes: ["tenant:123:"],
  cacheTtl: 30,
});
const entry = await db.get("tenant:123:settings", request.signal);
// entry === null means native binding missing. An empty Uint8Array is present.
const ordered = await db.getMany([
  "tenant:123:settings", "tenant:123:missing", "tenant:123:settings",
], request.signal);
const page = await db.list({ prefix: "tenant:123:", limit: 100 }, request.signal);
if (page.nextCursor !== undefined) {
  await db.list({ prefix: "tenant:123:", limit: 100, cursor: page.nextCursor });
}
```

`WorkersKvNamespaceLike` is structural and has no provider package/Node type
dependency. Its borrowed receiver is retained; `close()` never destroys the
binding. Reads call individual `getWithMetadata(key, {type: "stream"})` and
preserve arbitrary JSON metadata, including scalar/array/null values. Native
binary `getMany` uses bounded individual reads: the provider's bulk text/JSON
methods cannot return arbitrary binary bytes. Duplicate input positions receive
independent value copies; missing positions stay null; one shared deadline and
aggregate result/work budget cover the complete call.

Allowed prefixes are explicit literal grants and are copied at construction.
Every input and returned list key must match the selected grant. No regex/glob,
prefix rewriting, filtering-away foreign results, implicit namespace scan or
admin/KEYS fallback occurs. A namespace-wide empty prefix grant requires both
`allowedPrefixes: [""]` and `allowNamespaceAccess: true`.

Native keys are valid UTF8, at most512 bytes, excluding only empty string and
exact `.`/`..`. Valid astral, slash, percent, whitespace and control characters
remain unchanged. Unpaired UTF16 surrogates are refused before binding I/O.
The binding's cache TTL has a local30..2147483647-second profile; omitting it
leaves the platform default. Cache configuration is not a freshness guarantee.

## Server-only REST

```ts
import { CloudflareKvRestDatabase } from "@dalgo/cloudflare-kv/node";

const db = new CloudflareKvRestDatabase({
  accountId: configuredAccount,
  namespaceId: configuredExistingNamespace,
  allowedPrefixes: ["tenant:123:"],
  token: (signal) => credentialBroker.readOnlyKvToken(signal),
});
const bytes = (await db.get("tenant:123:settings"))?.value;
```

The default Node transport owns standard verified HTTPS agents with no
environment proxy/global fetch dispatcher, redirects, cookies, decompression or
retry. `close()` aborts owned requests and closes only owned agents. A custom
`fetch` is borrowed trusted infrastructure: the package sets no-redirect/omit
credentials/identity encoding but cannot attest a custom implementation's TLS,
proxy or cookie internals. Optional trusted endpoint overrides remain in server
configuration, never in read descriptors. Loopback HTTP requires a named testing
opt-in. The normal API root is `https://api.cloudflare.com/client/v4`.

Bearer acquisition is per operation. No global API key/email, admin token,
anonymous downgrade or default credential chain exists. Use the provider's
Workers KV Storage Read token permission, scoped to the intended account by
the host. This is not proof of a hosted namespace/prefix ACL: local fixed
namespace and prefix enforcement are independent authority boundaries. Token
contents, endpoint, keys, provider bodies and underlying causes are absent from
errors. Cancellation reasons never expose `AbortSignal.reason`.

REST point values are raw bytes. This first REST slice does not issue a separate
metadata GET or pretend value+metadata separate calls would form an atomic
`getWithMetadata`; list results can include observed metadata/expiration.
The REST documentation's narrower printable/non-whitespace key prose differs
from native binding semantics. The REST transport percent-encodes each complete
valid native key as one path segment, including slash, percent and punctuation,
and preserves provider refusal as a typed HTTP failure. No hosted acceptance
of undocumented REST key forms is claimed.

REST404 remains `CloudflareKvError("http",404)` and is never converted to missing
success, false `exists`, or null in a batch. The official REST reference and
Wrangler do not establish a unique missing-key code distinct from a missing
namespace/authority failure. No numeric error identity is invented. Consequently
REST missing-position/false-exists semantics remain unqualified; the native
binding's explicit null missing result is supported. HTTP401/403/429 and3xx are
safe failures;429 is not retried.

REST list limits are10..1000; native binding limits are1..1000. Requests below10
are refused by REST before token acquisition. Pages are never truncated to a
smaller logical limit while advancing a server cursor past undisclosed keys.
The configured `maxRows` must admit the fixed requested page size on each resume;
otherwise the whole attempt refuses before provider work.

## Pagination and retained resources

Native EOF follows `list_complete`, including empty/short unfinished pages.
REST EOF follows an absent/empty `result_info.cursor`. Listing returns key
metadata rather than values. Keys are checked in their source UTF8-byte order
across acknowledged pages, retaining the prior boundary through empty pages,
not JavaScript UTF16 ordering. The boundary is derived from the already charged
insertion-ordered seen-key journal, without another retained field. Foreign keys, duplicate acknowledged keys,
nonprogressing/cyclic tokens, malformed JSON/metadata and over-return refuse the
whole page. Eventual concurrent writes can still cause omissions or refusal:
this is not a snapshot or an exactly-once traversal guarantee.

Cursors are random instance-local handles binding exact prefix/page size,
transport and authority fingerprint. Raw provider tokens are private. Changed
auth tokens, prefix/page size, another instance, expired handles and successful
single-use replay are refused. The original journey TTL and spent
request/page/row/result-byte budgets are retained across resumes and failures.
No silent retry, budget refund or deadline extension occurs.

Final delivery performs one atomic net cursor replacement after caller response
factories/codecs and fresh cancellation checks. A failed pre-ACK delivery keeps
the prior handle usable while retaining incurred work. Client-wide logical
cursor byte/node admission includes IDs, tokens and fixed entry charges; expiry,
terminal pages and Close refund membership exactly once. This accounting is not
an RSS/heap or Cloudflare service-memory guarantee.
Response-factory promises are awaited inside retained admission before ACK;
cancellation stops waiting promptly but keeps the prior journey busy until an
ignored factory actually settles. Caller-owned signal-listener removal and
owned timer cleanup complete idempotently before the final delivery guard/ACK.
Throwing cleanup is redacted and cannot skip timer/lease release. Fresh caller,
deadline and Close classifications take priority over an earlier safe failure.
Nested bridge operations preserve the outer original deadline and cleanup guard
through the inner operation's final ACK. Prepared success has no caller-owned
cleanup callback left in `finally`.

## Browser bridge

```ts
// Server route: application must authenticate user, origin/CSRF and authority.
import { createCloudflareKvHttpHandler } from "@dalgo/cloudflare-kv/node";
const handle = createCloudflareKvHttpHandler({
  authorize: (request, signal) => authorizedDatabaseForPrincipal(request, signal),
});

// Browser bundle: application bridge token/cookies only, never Cloudflare token.
import { CloudflareKvHttpDatabase } from "@dalgo/cloudflare-kv/browser";
const client = new CloudflareKvHttpDatabase({ endpoint: "/api/kv" });
```

No anonymous/default executor exists. The host returns a stable database per
authority; descriptors cannot supply endpoint/account/namespace/API credentials
or prefix grants. Host Node bridges must propagate actual upload/unfinished
response disconnection into `Request.signal`. Serialization and `Response`
construction occur before native cursor ACK. ACK is server API success, not an
atomic network receipt or a client-browser acknowledgement; an interrupted
network delivery after server success can lose a single-use response/cursor.
No cross-network exactly-once or resumable retry protocol is claimed.

The pure root/binding and browser exports do not import server REST/Node code.
The browser bundle graph gate checks both entries with browser conditions and
rejects Node builtins, server modules and external provider engines. It is a
bundle proof, not a Chromium/Workers-engine query or hosted CORS proof.

## Modern core facade and limits

`db.asDatabase("configured-logical-collection")` accepts only original string
keys in that explicit collection and returns raw byte payloads through caller
codecs. It does not store synthetic IDs/envelopes or reinterpret arbitrary
native keys. `getWithSignal`/`getManyWithSignal` cover the whole native call and
each codec callback. SQL/relational structured query and cross-key atomic
transactions are refused without invoking callbacks: ordinary KV has no SQL
engine or multi-key transaction contract. KV provider writes exist; adapter
writes, schema mutation and namespace provisioning are NOT_IMPLEMENTED.

| Local bound | Default / maximum |
| --- | --- |
| One end-to-end timeout |30s /120s |
| Physically active operations |4 /16 |
| GetMany positions |100 /1000 |
| Rows per call/journey |1000 /10000 |
| Pages/requests per journey |100 /1000 |
| One value materialization |4MiB /25MiB |
| Aggregate received/copied bytes |16MiB /32MiB |
| Request admission |64KiB /1MiB |
| Retained cursors |128 /1000 |
| Aggregate retained logical cursor bytes/nodes |16MiB /65536 |
| Cursor journey TTL |5min /10min |

Requests are admitted before serialization/authentication; REST GetMany admits
the aggregate full escaped URI sizes before token acquisition. Native binding
requests have logical string-size admission because their internal wire format
is not visible. Stream/REST reads cap bytes before materialization/parse.
Binding metadata/list results are already platform-decoded: structural copied
budgets do not bound a platform allocation that already occurred. Metadata is
closed JSON up to1024 serialized bytes, depth32 and bounded nodes; accessors,
custom iterators/classes, cycles, malformed Unicode and duplicate JSON fields
are refused. Metadata numbers have ordinary JavaScript JSON/IEEE semantics,
not exact arbitrary-precision decimal lexemes.

The operation starts before copying inputs, authentication, foreign waits or
codec delivery. Monotonic elapsed checks also detect synchronous callbacks that
cross a deadline before timers run. Native binding APIs expose no AbortSignal;
local cancellation is prompt but does not assert remote execution was killed.
Ignored promises/readers and hostile never-settling cancel promises retain finite
admission until physical settlement; no detached work allows unlimited new calls.
Late/unused resources are owned and cancelled once without awaiting cleanup on
the original caller. An uncooperative binding can exhaust its bounded local
capacity; Close aborts local scopes and invalidates cursors.

None of these limits caps KV backend work, billed requests, arbitrary application
callback allocation or whole Workers invocation resources. Ordinary KV caches
values and absence and is eventually consistent, even near writes.

Primary contracts: [native reads](https://developers.cloudflare.com/kv/api/read-key-value-pairs/),
[list](https://developers.cloudflare.com/kv/api/list-keys/),
[limits](https://developers.cloudflare.com/kv/platform/limits/),
[consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/),
[REST values](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/methods/get/),
[REST keys](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/keys/methods/list/).
