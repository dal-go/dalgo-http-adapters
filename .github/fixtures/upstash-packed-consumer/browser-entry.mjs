import * as runtime from "@dalgo/adapter-runtime";
import * as protocol from "@dalgo/dalgo2redis-resp/protocol";
import * as upstash from "@dalgo/dalgo2upstash-redis";
import * as core from "@dalgo/core";

export async function verifyBrowserRoots() {
  if (upstash.RedisReadError !== protocol.RedisReadError) throw new Error("browser protocol identity split");
  const db = new upstash.UpstashRedisExecutor({ endpoint: "https://fixture.upstash.io", token: () => { throw new Error("unexpected token acquisition"); } });
  if (!db.readOnly || "RedisNodeExecutor" in upstash || "queryOrdinal" in db || "get" in db) throw new Error("REST public capability changed");
  const controller = new AbortController(); controller.abort("owned-secret-cause");
  let error;
  try { await db.execute(["GET", "fixture"], controller.signal); } catch (value) { error = value; }
  if (!(error instanceof runtime.QueryCancelledError) || error.reason !== "caller" || error.message.includes("owned-secret-cause")) throw new Error("browser cancellation identity split");
  if (!(core.key("items", "fixture") instanceof core.Key)) throw new Error("core identity changed");
  return { publicErrorIdentity: true, lazy: true };
}
