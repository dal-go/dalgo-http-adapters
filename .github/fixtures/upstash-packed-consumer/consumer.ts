import { type RedisReadExecutor, type RedisValue, scopeRedisRead, parseRedisReply } from "@dalgo/dalgo2redis-resp/protocol";
import { UpstashRedisExecutor, type UpstashRedisOptions } from "@dalgo/dalgo2upstash-redis";
import { QueryCancelledError, cancelQuietly, createAbortScope, raceAbort } from "@dalgo/adapter-runtime";
import { key } from "@dalgo/core";

declare const signal: AbortSignal;
const options: UpstashRedisOptions = { endpoint: "https://fixture.upstash.io", token: tokenSignal => { tokenSignal.throwIfAborted(); return "fixture-token"; }, scanPrefix: "fixture:" };
const executor: RedisReadExecutor = new UpstashRedisExecutor(options);
const value: Promise<RedisValue> = executor.execute(["GET", "fixture:key"], signal);
const command: readonly string[] = scopeRedisRead(["SCAN", "0"], "fixture:");
const parsed = parseRedisReply(new TextEncoder().encode(":1\r\n"), 100);
const scope = createAbortScope(signal, 1000);
const raced: Promise<string> = raceAbort(Promise.resolve("ok"), scope.signal, () => new QueryCancelledError("caller"));
cancelQuietly(null); scope.dispose();
const nodeBuffer: Buffer = Buffer.from("node consumer");
void [value, command, parsed, raced, nodeBuffer, key("items", "fixture")];
