import { type RedisReadExecutor, type RedisValue, scopeRedisRead, parseRedisReply } from "@dalgo/dalgo2redis-resp/protocol";
import { UpstashRedisExecutor, type UpstashRedisOptions } from "@dalgo/dalgo2upstash-redis";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { key } from "@dalgo/core";
// @ts-expect-error Node Buffer must not enter this DOM-only program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter this DOM-only program.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS namespace must not enter this DOM-only program.
type ForbiddenNamespace = NodeJS.Process;
// @ts-expect-error The REST root never exposes a TCP executor.
import { RedisNodeExecutor } from "@dalgo/dalgo2upstash-redis";

declare const signal: AbortSignal;
const options: UpstashRedisOptions = { endpoint: "https://fixture.upstash.io", token: () => "fixture-token", scanPrefix: "fixture:" };
const executor: RedisReadExecutor = new UpstashRedisExecutor(options);
const result: Promise<RedisValue> = executor.execute(["GET", "fixture:key"], signal);
const command: readonly string[] = scopeRedisRead(["SCAN", "0"], "fixture:");
const parsed = parseRedisReply(new TextEncoder().encode(":1\r\n"), 100);
void [result, command, parsed, QueryCancelledError, key("items", "fixture"), RedisNodeExecutor];
