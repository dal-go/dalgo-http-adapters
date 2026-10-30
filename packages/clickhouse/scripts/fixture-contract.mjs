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
  filters: [{ field: { source: "e", field: "amount" }, operator: "<", value: 2 }], orders: [{ field: { source: "e", field: "amount" }, direction: "asc" }], limit: 2 } };
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
//512rows/~4MiB/2.56s scheduled sleep versus unchanged1000row/8MiB/30s limits.
// The intended ~3MiB prefix exceeds the current upstream1MiB response buffer;
// only real CI establishes the pinned server's actual HTTP200 late framing.
export const lateErrorSql = "SELECT sleepEachRow(0.005) AS delay, throwIf(number = 384) AS n, toUInt64(blockSize()) AS block_rows, hex(randomString(4096)) AS padding FROM numbers(512)";
export const healthyControlSql = "SELECT sleepEachRow(0.005) AS delay, throwIf(number = 512) AS n, toUInt64(blockSize()) AS block_rows, hex(randomString(4096)) AS padding FROM numbers(512)";
const encodings = ["identity", "gzip", "br", "deflate", "zstd", "lz4", "snappy", "xz", "bzip2", "other", "missing-or-not-exposed"];
const finiteFact = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000_000 ? value : null;
function safeHttpDetails(observed) {
  return { status: Number.isInteger(observed?.status) && observed.status >= 100 && observed.status <= 599 ? observed.status : null,
    contentEncoding: encodings.includes(observed?.contentEncoding) ? observed.contentEncoding : "missing-or-not-exposed",
    resultRows: finiteFact(observed?.resultRows), resultBytes: finiteFact(observed?.resultBytes), elapsedNs: finiteFact(observed?.elapsedNs),
    headerElapsedMs: finiteFact(observed?.headerElapsedMs) };
}
export function fixtureResponseFacts(response, started) {
  const encoding = response.headers.get("content-encoding");
  let summary = null;
  const text = response.headers.get("x-clickhouse-summary");
  if (text !== null && text.length <= 8192) {
    try { const value = JSON.parse(text); if (value !== null && typeof value === "object" && !Array.isArray(value)) summary = value; } catch { /* Do not log untrusted header text. */ }
  }
  const count = (key) => {
    const value = summary?.[key];
    return typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? finiteFact(Number(value)) : finiteFact(value);
  };
  return safeHttpDetails({ status: response.status, contentEncoding: encoding === null ? "missing-or-not-exposed" : encodings.includes(encoding) ? encoding : "other",
    resultRows: count("result_rows"), resultBytes: count("result_bytes"), elapsedNs: count("elapsed_ns"), headerElapsedMs: Math.round(performance.now() - started) });
}
export function assertHealthyControl(probe) {
  const rows = Array.isArray(probe?.result?.rows) && probe.result.rows.length <= 1000 ? probe.result.rows : [];
  const integer = (value, expected) => value?.kind === "integer" && value.value === expected;
  const summary = { diagnostic: "clickhouse-healthy-control", rowCount: rows.length,
    shapeValid: rows.length > 0 && rows.every((row) => Array.isArray(row) && row.length === 4),
    delayAndThrowZeros: rows.length > 0 && rows.every((row) => Array.isArray(row) && integer(row[0], "0") && integer(row[1], "0")),
    blocksAreOne: rows.length > 0 && rows.every((row) => Array.isArray(row) && integer(row[2], "1")),
    paddingValid: rows.length > 0 && rows.every((row) => Array.isArray(row) && typeof row[3] === "string" && row[3].length === 8192 && /^[0-9A-F]+$/.test(row[3])),
    errorCode: ["transport", "response", "framing", "unsupported", "bounds", "permission"].includes(probe?.errorCode) ? probe.errorCode : null,
    ...safeHttpDetails(probe?.observed) };
  console.error(JSON.stringify(summary));
  assert.equal(summary.errorCode, null); assert.equal(summary.rowCount, 512);
  for (const key of ["shapeValid", "delayAndThrowZeros", "blocksAreOne", "paddingValid"]) assert.equal(summary[key], true, `healthy control ${key} mismatch`);
  assert.deepEqual(probe?.result?.columns, [{ name: "delay", nativeType: "UInt8" }, { name: "n", nativeType: "UInt8" }, { name: "block_rows", nativeType: "UInt64" }, { name: "padding", nativeType: "String" }]);
  // This control proves only its own pipeline, never the late query's pipeline.
  return summary;
}
export const readerProbeSql = "SELECT currentUser() AS reader, toUInt64(getSetting('max_block_size')) AS max_block_size, toUInt64(getSetting('readonly')) AS reader_readonly, toUInt64(blockSize()) AS block_rows, toUInt64(getSetting('enable_http_compression')) AS http_compression FROM numbers(512)";
export function assertReaderProbes(baseline, explicit) {
  const summarize = (probe, phase) => {
    const rows = Array.isArray(probe?.result?.rows) && probe.result.rows.length <= 1000 ? probe.result.rows : [];
    const range = (index) => {
      const values = rows.map((row) => {
        const cell = Array.isArray(row) && row.length === 5 ? row[index] : null;
        if (cell?.kind !== "integer" || typeof cell.value !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/.test(cell.value)) return null;
        const value = Number(cell.value); return Number.isSafeInteger(value) && value <= 1_000_000_000 ? value : null;
      });
      return values.length > 0 && values.every((value) => value !== null) ? [Math.min(...values), Math.max(...values)] : [null, null];
    };
    const [effectiveMaxBlockMin, effectiveMaxBlockMax] = range(1);
    const [readonlyMin, readonlyMax] = range(2);
    const [actualBlockMin, actualBlockMax] = range(3);
    const [compressionMin, compressionMax] = range(4);
    return { diagnostic: "clickhouse-reader-blocks", phase, rowCount: rows.length,
      readerMatches: rows.length > 0 && rows.every((row) => Array.isArray(row) && row.length === 5 && row[0] === "fixture_reader"),
      effectiveMaxBlockMin, effectiveMaxBlockMax, readonlyMin, readonlyMax, actualBlockMin, actualBlockMax, compressionMin, compressionMax,
      errorCode: ["transport", "response", "framing", "unsupported", "bounds", "permission"].includes(probe?.errorCode) ? probe.errorCode : null };
  };
  const summaries = [summarize(baseline, "baseline"), summarize(explicit, "explicit")];
  // Both real requests have completed. Print only finite allowlisted facts,
  // never raw rows, usernames, SQL, exception messages or headers.
  for (const summary of summaries) console.error(JSON.stringify(summary));
  for (const [index, summary] of summaries.entries()) {
    assert.equal(summary.errorCode, null); assert.equal(summary.rowCount, 512); assert.equal(summary.readerMatches, true);
    for (const key of ["effectiveMaxBlockMin", "effectiveMaxBlockMax", "readonlyMin", "readonlyMax", "actualBlockMin", "actualBlockMax"]) assert.equal(summary[key], 1, `${summary.phase} reader setting/block mismatch`);
    assert.equal(summary.compressionMin, 0); assert.equal(summary.compressionMax, 0);
    assert.deepEqual([baseline, explicit][index]?.result?.columns, [
      { name: "reader", nativeType: "String" }, { name: "max_block_size", nativeType: "UInt64" },
      { name: "reader_readonly", nativeType: "UInt64" }, { name: "block_rows", nativeType: "UInt64" },
      { name: "http_compression", nativeType: "UInt64" },
    ]);
  }
  return { baseline: summaries[0], explicit: summaries[1] };
}
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
const TS_POLICY = [
  { setting_name: "max_block_size", value: "1", min: null, max: null, writability: "CONST", inherit_profile: null },
  { setting_name: "enable_http_compression", value: "0", min: null, max: null, writability: "CONST", inherit_profile: null },
];
const originalEntry = (entry) => !TS_POLICY.some((setting) => setting.setting_name === entry.setting_name);
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
  assert.equal(snapshot.elements.filter(originalEntry).length, EXPECTED_POLICY.length, "unexpected settings/inherited profiles are refused");
  for (const setting of TS_POLICY) {
    const existing = snapshot.elements.find((entry) => entry.setting_name === setting.setting_name);
    if (existing !== undefined) assert.deepEqual(existing, setting, "only a prior identical TS fixture preparation is accepted");
  }
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
  // ADD changes these complete entries. Bare SETTINGS would replace the whole
  // profile and remove the reader policy; it must never be used here.
  for (const setting of TS_POLICY) {
    if (!before.elements.some((entry) => entry.setting_name === setting.setting_name))
      await adminText(serverUrl, `ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS ${setting.setting_name}=${setting.value} CONST`);
  }
  const after = await profileSnapshot(serverUrl);
  assertOriginalPolicy(after);
  assert.deepEqual(after.targets, before.targets, "reader profile identity and assignment must remain unchanged");
  assert.deepEqual(after.elements.filter(originalEntry), before.elements.filter(originalEntry), "every original policy entry and constraint must remain unchanged");
  for (const setting of TS_POLICY) assert.deepEqual(after.elements.find((entry) => entry.setting_name === setting.setting_name), setting);
  assert.match(after.showCreate, /\bmax_block_size\s*=\s*1\s+(?:CONST|READONLY)\b/);
  assert.match(after.showCreate, /\benable_http_compression\s*=\s*0\s+(?:CONST|READONLY)\b/);
  return { originalEntries: EXPECTED_POLICY.length, preserved: true, readonlyConst: true, maxBlockSizeConst: 1, httpCompressionConst: 0 };
}
export function assertLateFramingEvidence(error, observed) {
  // Emit only allowlisted facts before any assertion can stop the real proof.
  // Never serialize the response, exception text, nonce, SQL or credentials.
  console.error(JSON.stringify({ diagnostic: "clickhouse-late-response",
    status: Number.isInteger(observed?.status) && observed.status >= 100 && observed.status <= 599 ? observed.status : null,
    format: observed?.format === "RowBinaryWithNamesAndTypes" ? observed.format : "other-or-missing",
    tagLength: Number.isSafeInteger(observed?.tagLength) && observed.tagLength >= 0 && observed.tagLength <= 8192 ? observed.tagLength : null,
    tagValid: observed?.tagValid === true, exceptionCodePresent: observed?.exceptionCodePresent === true,
    exceptionCode: Number.isSafeInteger(observed?.exceptionCode) && observed.exceptionCode >= 0 && observed.exceptionCode <= 1_000_000_000 ? observed.exceptionCode : null,
    ...safeHttpDetails(observed),
    errorCode: ["transport", "response", "framing", "unsupported", "bounds", "permission"].includes(error?.code) ? error.code : "other-or-missing",
  }));
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
