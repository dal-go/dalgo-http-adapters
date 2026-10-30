import assert from "node:assert/strict";
import { NativeClickHouseDatabase } from "../dist/index.js";
import { aliasQuery, aliasRoundTripQuery, assertExact, assertFixtureVersion, assertLateFramingEvidence, exactQuery, fixtureUrl, lateErrorSql, nativeOptions, PINNED_IMAGE, prepareLateErrorFixture, recordProof, refusedSql, slowSql, unsafeAliasQueries, waitForProcess } from "./fixture-contract.mjs";

const serverUrl = fixtureUrl();
const version = await assertFixtureVersion(serverUrl);
const profileProof = await prepareLateErrorFixture(serverUrl);
const database = new NativeClickHouseDatabase(nativeOptions(serverUrl));
assertExact(await database.queryOrdinal(exactQuery));
const alias = await database.queryOrdinal(aliasQuery);
assert.deepEqual(alias, {
  columns: [{ name: "amount", nativeType: "UInt64" }],
  rows: [[{ kind: "integer", value: "7" }]],
});
const labels = await database.queryOrdinal(aliasRoundTripQuery);
assert.deepEqual(labels.columns.map((column) => column.name), ["a`b", "native id"]);
let unsafeRequests = 0;
const structuredOnly = new NativeClickHouseDatabase({ ...nativeOptions(serverUrl), allowNativeSql: false, fetch: (...args) => { unsafeRequests += 1; return fetch(...args); } });
for (const query of unsafeAliasQueries) await assert.rejects(structuredOnly.queryOrdinal(query), (error) => error.code === "unsupported");
assert.equal(unsafeRequests, 0, "unsafe aliases must refuse before HTTP");
let lateObserved;
const lateReader = new NativeClickHouseDatabase({ ...nativeOptions(serverUrl), fetch: async (value, init) => {
  // Exercise the actual early-response protocol without changing SQL or any
  // read/resource constraints. Do not normalize a broken stream into success.
  const url = new URL(value);
  url.searchParams.set("buffer_size", "1"); url.searchParams.set("wait_end_of_query", "0");
  const response = await fetch(url, init);
  const tag = response.headers.get("x-clickhouse-exception-tag");
  lateObserved = { status: response.status, format: response.headers.get("x-clickhouse-format"), tagLength: tag?.length, tagValid: /^[a-z]{16}$/.test(tag ?? "") };
  return response;
} });
const lateError = await lateReader.queryOrdinal({ kind: "native", sql: lateErrorSql }).then(() => null, (error) => error);
const lateProof = assertLateFramingEvidence(lateError, lateObserved);
const ordinary = "Code: 395. DB::Exception: ordinary data\n__exception__";
assert.deepEqual((await database.queryOrdinal({ kind: "native", sql: "SELECT {text:String} AS text", parameters: [{ name: "text", nativeType: "String", value: ordinary }] })).rows, [[ordinary]]);
const repeated = await database.queryOrdinal({ kind: "native", sql: "SELECT map('same', toUInt64(1), 'same', toUInt64(2)) AS m" });
assert.deepEqual(repeated.rows, [[{ kind: "map", entries: [["same", { kind: "integer", value: "1" }], ["same", { kind: "integer", value: "2" }]] }]]);
for (const sql of refusedSql) await assert.rejects(database.queryOrdinal({ kind: "native", sql }), (error) => error.name === "ClickHouseNativeError" && ["response", "framing"].includes(error.code));
const count = await database.queryOrdinal({ kind: "native", sql: "SELECT count() FROM explore.events" });
assert.deepEqual(count.rows, [[{ kind: "integer", value: "3" }]]);
// Native SQL remains separately enabled: a structured-only reader cannot send it.
await assert.rejects(new NativeClickHouseDatabase({ ...nativeOptions(serverUrl), allowNativeSql: false }).queryOrdinal(exactQuery), (error) => error.code === "permission");
let id;
const controller = new AbortController();
const cancellable = new NativeClickHouseDatabase({ ...nativeOptions(serverUrl), fetch: (url, init) => {
  if (init?.body === slowSql) id = new URL(url).searchParams.get("query_id");
  return fetch(url, init);
} });
const outcome = cancellable.queryOrdinal({ kind: "native", sql: slowSql }, controller.signal).then(() => ({ success: true }), (error) => ({ error }));
for (let attempt = 0; id === undefined && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(typeof id, "string");
await waitForProcess(serverUrl, id, 1);
controller.abort();
assert.equal((await outcome).error?.reason, "caller");
await waitForProcess(serverUrl, id, 0, 1000);
recordProof(process.versions.node.startsWith("20.") ? "node20" : "node24", { image: PINNED_IMAGE, version, profileProof, lateProof, exactOrdinal: "pass", duplicateRowsAndLabels: "pass", aliasCapture: "pass", aliasRoundTripAndInjectionRefusal: "pass", mapEntries: "pass", serverWriteSettingsAndScopeRefusal: "pass", nativeOptInRefused: "pass", serverCancellationObserved: { before: 1, after: 0 } });
