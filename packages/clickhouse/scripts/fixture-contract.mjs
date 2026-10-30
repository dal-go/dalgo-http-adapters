// Real fixture contracts. check-real-fixture.sh owns one capped Linux server;
// these Node/browser runners never create containers or install packages.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const PINNED_IMAGE = "clickhouse/clickhouse-server:26.10.3.7@sha256:739e099abd1157390960a59e4532d21781d8fde57e6e4151cb920ea02c30b1ce";
export function fixtureUrl() {
  assert.equal(process.platform, "linux", "real ClickHouse checks require the approved Linux runner");
  assert.equal(process.env.CLICKHOUSE_FIXTURE_IMAGE, PINNED_IMAGE, "runner must attest the exact pinned fixture image");
  assert.match(process.env.CLICKHOUSE_FIXTURE_ADMIN_PASSWORD ?? "", /^[A-Za-z0-9_-]{43,128}$/, "runner must supply a fresh synthetic Node-only admin secret");
  const url = new URL(process.env.CLICKHOUSE_TEST_URL ?? "");
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.equal(url.pathname, "/");
  return url.origin;
}
export async function assertFixtureVersion(serverUrl) {
  const version = (await adminText(serverUrl, "SELECT version() FORMAT TSV")).trim();
  assert.equal(version, "26.10.3.7", "actual fixture server version must match the pinned image");
  return version;
}
export function recordProof(name, proof) {
  assert.match(name, /^(?:node20|node24|chromium)$/);
  const text = JSON.stringify({ source: process.env.GITHUB_SHA ?? "local", runtime: process.version, ...proof });
  assert.ok(Buffer.byteLength(text) < 65_536, "redacted fixture proof must stay bounded");
  if (process.env.CLICKHOUSE_PROOF_DIR !== undefined) {
    mkdirSync(process.env.CLICKHOUSE_PROOF_DIR, { recursive: true });
    writeFileSync(join(process.env.CLICKHOUSE_PROOF_DIR, `${name}.json`), `${text}\n`, { mode: 0o600 });
  }
  console.log(text);
}
export const readerHeaders = () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" });
export function nativeOptions(serverUrl) {
  return { serverUrl, tables: { events: { database: "explore", table: "events", columns: { id: "id", amount: "amount", items: "items", label: "label", at: "at", attrs: "attrs" } } },
    allowInsecureLoopbackHttp: true, allowNativeSql: true, headers: readerHeaders };
}
export const maximum = { name: "maximum", nativeType: "UInt64", value: { kind: "integer", value: "18446744073709551615" } };
export const exactQuery = { kind: "native", sql: "SELECT id AS duplicate, id AS duplicate, amount, items, label, at, attrs FROM explore.events WHERE id = {maximum:UInt64} ORDER BY at LIMIT 2", parameters: [maximum] };
export const aliasQuery = { kind: "structured", query: { kind: "joined-tugql", from: { name: "events", alias: "e", joins: [] },
  columns: [{ expression: { kind: "field", field: { source: "e", field: "id" } }, as: "amount" }],
  filters: [{ field: { source: "e", field: "amount" }, operator: ">", value: 1 }], orders: [{ field: { source: "e", field: "amount" }, direction: "asc" }], limit: 2 } };
export const aliasRoundTripQuery = { kind: "structured", query: { ...aliasQuery.query,
  columns: [{ expression: { kind: "field", field: { source: "e", field: "id" } }, as: "a`b" }, { expression: { kind: "field", field: { source: "e", field: "id" } }, as: "native id" }] } };
export const unsafeAliasQueries = ["trailing\\", "literal\\n", "literal\\N", "x\\`, secret FROM forbidden.secret --"].map((as) => ({ kind: "structured", query: { ...aliasQuery.query, columns: [{ expression: { kind: "literal", value: 1 }, as }] } }));
export function assertExact(result) {
  assert.deepEqual(result.columns.slice(0, 2).map((column) => column.name), ["duplicate", "duplicate"]);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], result.rows[1]);
  assert.deepEqual(result.rows[0], [
    { kind: "integer", value: "18446744073709551615" }, { kind: "integer", value: "18446744073709551615" },
    { kind: "decimal", unscaled: "12345678901234567890123456789", scale: 9 },
    { kind: "array", values: [{ kind: "integer", value: "18446744073709551615" }] }, null,
    { kind: "datetime", ticksSinceEpoch: "1767323045123456789", scale: 9, timezone: "UTC" },
    { kind: "map", entries: [["maximum", { kind: "integer", value: "18446744073709551615" }]] },
  ]);
}
export const refusedSql = ["INSERT INTO explore.events(id) VALUES (1)", "ALTER TABLE explore.events ADD COLUMN forbidden_write UInt8", "SELECT 1 SETTINGS readonly=0", "SET readonly=0", "SELECT * FROM forbidden.secret"];
export const slowSql = "SELECT sleepEachRow(0.05) FROM numbers(50)";
export const lateErrorSql = "SELECT toUInt8(throwIf(number = 2)) AS n FROM numbers(5)";
const PROFILE_ELEMENTS_SQL = "SELECT setting_name, value, min, max, toString(writability) AS writability, inherit_profile FROM system.settings_profile_elements WHERE profile_name = 'fixture_reader_profile' ORDER BY setting_name FORMAT JSONEachRow";
const PROFILE_TARGET_SQL = "SELECT name, toString(id) AS id, apply_to_all, apply_to_list, apply_to_except FROM system.settings_profiles WHERE name = 'fixture_reader_profile' FORMAT JSONEachRow";
const PROFILE_SHOW_SQL = "SHOW CREATE SETTINGS PROFILE fixture_reader_profile FORMAT TabSeparatedRaw";
const EXPECTED_POLICY = [
  ["readonly", "1", null, null, "CONST"],
  ["max_execution_time", "30", "0.001", "65", "CHANGEABLE_IN_READONLY"],
  ["max_result_rows", "1001", "1", "100001", "CHANGEABLE_IN_READONLY"],
  ["max_result_bytes", "8388608", "1", "67108864", "CHANGEABLE_IN_READONLY"],
  ["result_overflow_mode", "throw", null, null, "CONST"],
  ["max_rows_to_read", "100000", null, null, "CONST"],
  ["max_bytes_to_read", "67108864", null, null, "CONST"],
  ["read_overflow_mode", "throw", null, null, "CONST"],
  ["timeout_overflow_mode", "throw", null, null, "CONST"],
  ["max_memory_usage", "536870912", null, null, "CONST"],
  ["max_threads", "2", null, null, "CONST"],
].map(([setting_name, value, min, max, writability]) => ({ setting_name, value, min, max, writability, inherit_profile: null }));
async function adminText(serverUrl, sql) {
  const url = new URL(serverUrl); url.searchParams.set("wait_end_of_query", "1");
  const response = await fetch(url, { method: "POST", headers: { "X-ClickHouse-User": "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_FIXTURE_ADMIN_PASSWORD }, body: sql, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200, "TS fixture admin operation failed");
  assert.equal(response.headers.has("x-clickhouse-exception-code"), false);
  assert.ok(response.body, "TS fixture admin body missing");
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); assert.fail("TS fixture admin response exceeds bound"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
async function profileSnapshot(serverUrl) {
  const elements = (await adminText(serverUrl, PROFILE_ELEMENTS_SQL)).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const targets = (await adminText(serverUrl, PROFILE_TARGET_SQL)).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const showCreate = await adminText(serverUrl, PROFILE_SHOW_SQL);
  return { elements, targets, showCreate };
}
function assertOriginalPolicy(snapshot) {
  assert.equal(snapshot.elements.length, new Set(snapshot.elements.map((entry) => entry.setting_name)).size, "duplicate policy entries are refused");
  for (const expected of EXPECTED_POLICY) assert.deepEqual(snapshot.elements.find((entry) => entry.setting_name === expected.setting_name), expected, "original reader value/constraints must match the pinned fixture");
  assert.equal(snapshot.elements.filter((entry) => entry.setting_name !== "max_block_size").length, EXPECTED_POLICY.length, "unexpected settings/inherited profiles are refused");
  const existingBlock = snapshot.elements.find((entry) => entry.setting_name === "max_block_size");
  if (existingBlock !== undefined) assert.deepEqual(existingBlock, { setting_name: "max_block_size", value: "1", min: null, max: null, writability: "CONST", inherit_profile: null }, "only a prior identical TS fixture preparation is accepted");
  assert.equal(snapshot.targets.length, 1);
  assert.equal(snapshot.targets[0].name, "fixture_reader_profile");
  assert.equal(snapshot.targets[0].apply_to_all, 0);
  assert.deepEqual(snapshot.targets[0].apply_to_list, ["fixture_reader"]);
  assert.deepEqual(snapshot.targets[0].apply_to_except, []);
  assert.match(snapshot.showCreate, /\breadonly\s*=\s*1\s+(?:CONST|READONLY)\b/);
  assert.match(snapshot.showCreate, /\bTO\s+`?fixture_reader`?\s*;?\s*$/);
}
export async function prepareLateErrorFixture(serverUrl) {
  const before = await profileSnapshot(serverUrl);
  assertOriginalPolicy(before);
  // ADD changes this one complete entry. Bare SETTINGS would replace the whole
  // profile and remove the reader policy; it must never be used here.
  if (!before.elements.some((entry) => entry.setting_name === "max_block_size")) {
    await adminText(serverUrl, "ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS max_block_size=1 CONST");
  }
  const after = await profileSnapshot(serverUrl);
  assertOriginalPolicy(after);
  assert.deepEqual(after.targets, before.targets, "reader profile identity and assignment must remain unchanged");
  assert.deepEqual(after.elements.filter((entry) => entry.setting_name !== "max_block_size"), before.elements.filter((entry) => entry.setting_name !== "max_block_size"), "every original policy entry and constraint must remain unchanged");
  assert.deepEqual(after.elements.find((entry) => entry.setting_name === "max_block_size"), { setting_name: "max_block_size", value: "1", min: null, max: null, writability: "CONST", inherit_profile: null });
  assert.match(after.showCreate, /\bmax_block_size\s*=\s*1\s+(?:CONST|READONLY)\b/);
  return { originalEntries: EXPECTED_POLICY.length, preserved: true, readonlyConst: true, maxBlockSizeConst: 1 };
}
export function assertLateFramingEvidence(error, observed) {
  assert.equal(error?.code, "framing", "a decoder, transport, format or row-budget refusal is not framing proof");
  assert.equal(observed.status, 200, "fixture must exercise a late HTTP200 failure");
  assert.equal(observed.format, "RowBinaryWithNamesAndTypes");
  assert.equal(observed.tagLength, 16); assert.equal(observed.tagValid, true);
  const evidence = error.framing;
  assert.equal(evidence?.actualFormat, observed.format); assert.equal(evidence?.tagLength, 16); assert.equal(evidence?.prefixPresent, true);
  assert.ok(Number.isSafeInteger(evidence.bodyBytes) && Number.isSafeInteger(evidence.frameBytes));
  assert.ok(evidence.bodyBytes > evidence.frameBytes && evidence.frameBytes >= 35 && evidence.frameBytes <= 16_384);
  assert.equal(typeof evidence.completeBody, "boolean");
  return { httpStatus: observed.status, errorCode: error.code, ...evidence };
}
async function processCount(serverUrl, id) {
  // Default admin requires a fresh parent-owned secret through admin-auth.xml.
  // Never send that secret to the browser. Server SQL, not browser disconnect,
  // establishes that the exact reader query was running and then stopped.
  const url = new URL(serverUrl);
  url.searchParams.set("param_id", id);
  const response = await fetch(url, { method: "POST", headers: { "X-ClickHouse-User": "default", "X-ClickHouse-Key": process.env.CLICKHOUSE_FIXTURE_ADMIN_PASSWORD }, body: "SELECT count() FROM system.processes WHERE query_id = {id:String} FORMAT TSV", signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200, "fixture process observation failed");
  const text = await response.text();
  assert.match(text, /^[01]\n$/);
  return Number(text.trim());
}
export async function waitForProcess(serverUrl, id, expected, maximumMs = 1500) {
  assert.match(id, /^dalgo-[0-9a-f-]{36}$/);
  const start = performance.now();
  do {
    if (await processCount(serverUrl, id) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() - start < maximumMs);
  assert.fail(`exact server query did not reach observed process count ${expected}`);
}
