# Upstash Redis REST reads

Independent TypeScript REST transport implementing `RedisReadExecutor`. The root entry uses Web APIs in Node or a browser and loads no TCP driver, Node builtin, native addon or Go bridge. It shares the reviewed Redis RESP2 value/parser and read-policy subpath rather than decoding native integers as JSON numbers. This is source implementation; package publication, actual hosted Upstash, CORS, browser and Apps acceptance are **UNVERIFIED**.

```ts
// Lazy-load only after selecting this saved, authorized source.
const { UpstashRedisExecutor } = await import('@dalgo/dalgo2upstash-redis');
const redis = new UpstashRedisExecutor({
  endpoint: savedUpstashEndpoint,
  token: signal => acquireScopedReadToken(signal),
  scanPrefix: 'customer:', // optional: SCAN refused when absent
});
const value = await redis.execute(['GET', 'customer:42'], controller.signal);
```

Endpoint/token configuration belongs to the trusted host and its saved-resource authorization. Do not pass arbitrary request-body URLs or provider secrets into untrusted browser code. A browser requires a user-scoped credential that its application is authorized to expose, and exact provider CORS configuration. Never substitute an admin/Standard token when a read credential is denied.

The [official REST contract](https://upstash.com/docs/redis/features/restapi) accepts one command array in a root POST with header bearer authentication. This adapter requests raw binary RESP2 with `Upstash-Response-Format: resp2`, avoiding JSON numeric rounding and UTF-8 replacement. It does not combine the mutually exclusive base64 encoding header. Upstash's default Read Only token restricts SCAN; a separately supplied ACL-user REST token must explicitly allow the intended command. Such tokens still do not scope SCAN enumeration automatically. The adapter never generates tokens or changes ACLs.

GET/MGET, HGET/HMGET/HEXISTS, EXISTS, TYPE, TTL/PTTL, STRLEN, HLEN, LLEN, SCARD, ZCARD, ZSCORE and one SCAN page reuse the RESP read allowlist. Malformed UTF16 command arguments or prefixes are refused before credentials or HTTP; valid astral characters retain their exact UTF8 key identity. Multi-get replies must have exactly one bulk/null value per requested key/field, and each command must return its native scalar/array type. Malformed or partial replies fail as a whole. Results preserve native bytes as `{kind:'bytes',base64:'...'}`, signed64 integers as decimal `{kind:'integer',value:'...'}`, arrays recursively, nulls and simple status strings. There is no fabricated record identity, keyed DALgo Database facade, SQL/TugQL or generic schema API. Writes, scripting, administrative commands, KEYS, pipeline/multi-exec and transaction callbacks are **not implemented** by this read-only adapter; their existence in Redis/Upstash is not disputed.

SCAN requires a nonempty literal `scanPrefix`; wildcard/backslash characters are escaped in forced MATCH. Conflicting caller MATCH is refused before token acquisition. A whole reply must have a uint64 bulk cursor, at most 256 bulk keys, and the exact literal UTF-8 prefix on every key. Foreign/malformed/oversized pages fail; no filtering or truncation. Duplicate keys and empty nonterminal pages are retained. COUNT is a hint, not a hard result count. Prefix configuration is not credential authorization. This single-page API gives no snapshot, cluster-wide ordering, deduplication or whole-scan-work guarantee.

One deadline starts before the token supplier and covers fetch, headers, streamed body, parsing and final delivery. Caller cancellation uses the same scope. Late response bodies are owned and canceled; cleanup is rejection-safe and never awaited. The final check also covers synchronous cleanup callbacks and elapsed time before a timer runs. HTTP abort stops local waiting/transport; remote Redis execution cancellation is not independently established. Subsequent reads have a fresh scope and no automatic retry.

Defaults: 10s, 128 arguments, 64KiB command limit (including actual JSON POST bytes), 1MiB reply, SCAN COUNT ceiling 1000, plus RESP nesting/node limits and a 256-key SCAN page cap. Configurable maxima are 60s, 1024 arguments, 1MiB command and 16MiB response. Rows are never silently truncated. An explicitly enabled literal-loopback HTTP option exists only for owned disposable fixtures; normal endpoints require a credential-free HTTPS root with no query/fragment. Redirects and ambient cookies are forbidden. Provider bodies, endpoint details and token/cancellation causes are omitted from errors.

`pnpm --filter @dalgo/dalgo2upstash-redis check` covers mocked protocol/security/cancellation regressions and a browser bundle inspection. Root must separately validate normal Changesets preview, strict packed Node+DOM consumers and actual provider/browser journeys. Public adapter-runtime 0.1.2 already provides the cancellation APIs used here; no ordinal API is required. The Redis RESP protocol subpath requires its coordinated 0.2 release. No registry/installed-release claim is made for this adapter.
