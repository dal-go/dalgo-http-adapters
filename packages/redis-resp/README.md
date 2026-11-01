# Redis RESP read execution

Independent TypeScript implementation of Redis native read commands. `RedisNodeExecutor` connects using RESP2 over Node TCP/TLS. `RedisHttpExecutor` is the browser-safe client for a trusted application route backed by that TypeScript executor. This package does not expose SQL, fabricated DALgo record identities, unrestricted commands, or an Upstash REST adapter.

```ts
// Trusted server code only. Endpoint and credentials come from server-owned configuration.
import { RedisNodeExecutor, createRedisHttpHandler } from '@dalgo/dalgo2redis-resp/node';

const executor = new RedisNodeExecutor({
  host: 'redis.example.test', tls: true,
  username: 'reader', password: serverSecret, scanPrefix: 'customer:',
});

const handle = createRedisHttpHandler({
  authorize: async (request, signal) => {
    // Your existing auth must check the session, this saved resource and CSRF/origin.
    await requireResourceReadAccess(request, signal);
    return executor;
  },
});
```

Mount `handle(Request)` in your existing server. Authorization is required and runs before body processing. It must resolve an executor from trusted resource configuration; request bodies contain only `command`. Do not use this route as an unauthenticated Redis proxy. Redis ACL credentials must also restrict accessible key patterns and permitted reads. Plain TCP is supported for trusted local service networks; TLS verifies the platform trust store. Connection options never enter the browser.

```ts
// Selected-only browser code: no Redis TCP driver or Node imports.
import { RedisHttpExecutor } from '@dalgo/dalgo2redis-resp';
const redis = new RedisHttpExecutor({ endpoint: 'https://app.example.test/resources/42/redis' });
const value = await redis.execute(['GET', 'customer:42'], abortController.signal);
const page = await redis.execute(['SCAN', '0', 'MATCH', 'customer:*', 'COUNT', '100']);
```

Read commands: GET/MGET, HGET/HMGET/HEXISTS, EXISTS, TYPE, TTL/PTTL, STRLEN, HLEN, LLEN, SCARD, ZCARD, ZSCORE and SCAN. Commands and arity are checked before opening a socket. Writes, scripting, administrative and transaction commands, KEYS, blocking commands and unbounded collection reads are refused. Native keys and field arguments are UTF-8 strings. Arbitrary result bytes are `{kind:'bytes',base64:'...'}`; RESP integers are `{kind:'integer',value:'9223372036854775807'}`; arrays are `{kind:'array',values:[...]}`; absent values are null. Values are never JSON-decoded automatically. Successful simple strings such as TYPE remain strings.

SCAN is refused unless the server-owned executor specifies a nonempty literal `scanPrefix`. Redis ACL key patterns do not filter SCAN output, so the executor forces an escaped `<literal prefix>*` MATCH and rejects any caller-supplied different pattern. Glob metacharacters in the configured prefix are escaped. Ordinary reads still require key-scoped Redis ACLs.

SCAN executes exactly one server page and preserves its cursor and keys as the native array reply. Cursors must be decimal uint64 values. The executor verifies the returned two-element page, bulk cursor, key array and every key's literal UTF-8 prefix bytes. A malformed page or any foreign key fails the whole response before Node or authorized HTTP delivery; keys are never filtered or truncated. Binary bytes after the prefix remain exact. COUNT is a hint, not a result limit: Redis may return more keys, repeat keys, return an empty nonterminal page, and does not offer snapshot ordering. Oversized replies fail as a whole; no keys are silently discarded. Continuation, deduplication and a whole-journey scan-work/page budget belong to the explicit caller journey and remain integration gates. SCAN metadata is key enumeration, not a relational schema. No cluster routing or complete DALgo CRUD/query interface is claimed.

Defaults are one 10-second end-to-end deadline, 128 arguments, 64 KiB command text, 1 MiB native/HTTP reply and SCAN COUNT at most 1,000. RESP reply bytes are capped before bulk allocation/decoding; nesting and total value nodes are capped. HTTP JSON/base64 adds overhead, so a native reply near its native cap can exceed the HTTP cap and fail explicitly. One operation owns one socket; auth, database selection, query, cancellation and cleanup use that socket. Aborting destroys local transport and does not claim remote Redis command cancellation. Redis/server errors are redacted. No retry is automatic.

This is SDK source plus focused fixtures, not a released package, actual application UI integration, or deployed browser acceptance. The host must supply authorization, per-user rate limits, saved-resource resolution and secrets. Apps integration and registry pins are separate gates.

The additive `@dalgo/dalgo2redis-resp/protocol` export is transport-independent and browser-safe. It exposes the existing bounded RESP2 parser, native value/read contracts and shared literal-prefix SCAN request/reply validation. It imports no TCP/server module. SCAN has an additional actual 256-key page ceiling independent of COUNT; oversized pages fail whole. Independent REST transports can share this contract without importing private files or loading the Node executor.
