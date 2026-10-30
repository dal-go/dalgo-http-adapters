import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLateFramingEvidence, prepareLateErrorFixture } from "./fixture-contract.mjs";

const baseline = [
  ["readonly", "1", null, null, "CONST"], ["max_execution_time", "30", "0.001", "65", "CHANGEABLE_IN_READONLY"],
  ["max_result_rows", "1001", "1", "100001", "CHANGEABLE_IN_READONLY"], ["max_result_bytes", "8388608", "1", "67108864", "CHANGEABLE_IN_READONLY"],
  ["result_overflow_mode", "throw", null, null, "CONST"], ["max_rows_to_read", "100000", null, null, "CONST"],
  ["max_bytes_to_read", "67108864", null, null, "CONST"], ["read_overflow_mode", "throw", null, null, "CONST"],
  ["timeout_overflow_mode", "throw", null, null, "CONST"], ["max_memory_usage", "536870912", null, null, "CONST"], ["max_threads", "2", null, null, "CONST"],
].map(([setting_name, value, min, max, writability]) => ({ setting_name, value, min, max, writability, inherit_profile: null }));
const block = { setting_name: "max_block_size", value: "1", min: null, max: null, writability: "CONST", inherit_profile: null };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixtureAdmin(changeAfter = (rows) => rows, initialRows = baseline) {
  let elements = initialRows.map((row) => ({ ...row }));
  const changes = [];
  vi.stubEnv("CLICKHOUSE_FIXTURE_ADMIN_PASSWORD", "synthetic-unit-admin-credential-unused-by-browser");
  vi.stubGlobal("fetch", vi.fn((_url, init) => {
    const sql = init.body;
    if (sql.startsWith("ALTER SETTINGS PROFILE")) {
      changes.push(sql);
      if (!sql.includes(" ADD SETTINGS ")) elements = [];
      else elements = changeAfter([...elements, block]);
      return Promise.resolve(new Response(""));
    }
    if (sql.includes("system.settings_profile_elements")) return Promise.resolve(new Response([...elements].sort((a, b) => a.setting_name.localeCompare(b.setting_name)).map((row) => JSON.stringify(row)).join("\n")));
    if (sql.includes("system.settings_profiles")) return Promise.resolve(new Response(JSON.stringify({ name: "fixture_reader_profile", id: "synthetic-profile-id", apply_to_all: 0, apply_to_list: ["fixture_reader"], apply_to_except: [] })));
    if (sql.startsWith("SHOW CREATE SETTINGS PROFILE")) return Promise.resolve(new Response(`CREATE SETTINGS PROFILE fixture_reader_profile SETTINGS readonly = 1 CONST${elements.some((entry) => entry.setting_name === "max_block_size") ? ", max_block_size = 1 CONST" : ""} TO fixture_reader\n`));
    throw new Error("unexpected fixture admin query");
  }));
  return changes;
}

describe("reader fixture policy preparation", () => {
  it("uses one incremental change and verifies all original server metadata and constraints", async () => {
    const changes = fixtureAdmin();
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).resolves.toEqual({ originalEntries: 11, preserved: true, readonlyConst: true, maxBlockSizeConst: 1 });
    expect(changes).toEqual(["ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS max_block_size=1 CONST"]);
  });
  it("refuses to modify an already unsafe baseline", async () => {
    const changes = fixtureAdmin((rows) => rows, baseline.filter((row) => row.setting_name !== "readonly"));
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow();
    expect(changes).toEqual([]);
  });
  it("revalidates an identical preparation without adding duplicate policy entries", async () => {
    const changes = fixtureAdmin((rows) => rows, [...baseline, block]);
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).resolves.toEqual({ originalEntries: 11, preserved: true, readonlyConst: true, maxBlockSizeConst: 1 });
    expect(changes).toEqual([]);
  });
  it.each(["readonly", "max_memory_usage", "max_execution_time", "max_threads"])("detects dropped or weakened %s after preparation", async (setting) => {
    fixtureAdmin((rows) => rows.map((row) => row.setting_name === setting ? { ...row, writability: "WRITABLE", max: null, value: "0" } : row));
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow();
  });
});

describe("late HTTP framing evidence attribution", () => {
  const observed = { status: 200, format: "RowBinaryWithNamesAndTypes", tagLength: 16, tagValid: true };
  const framing = { actualFormat: "RowBinaryWithNamesAndTypes", tagLength: 16, prefixPresent: true, bodyBytes: 100, frameBytes: 80, completeBody: false };
  it("accepts only redacted framing facts from the actual response", () => {
    expect(assertLateFramingEvidence({ code: "framing", framing }, observed)).toEqual({ httpStatus: 200, errorCode: "framing", ...framing });
  });
  it.each(["response", "transport", "bounds", "unsupported"])("does not count a generic %s refusal as framing proof", (code) => {
    expect(() => assertLateFramingEvidence({ code, framing }, observed)).toThrow();
  });
  it("refuses absent prefix evidence, wrong formats and unbounded frame claims", () => {
    expect(() => assertLateFramingEvidence({ code: "framing", framing: { ...framing, prefixPresent: false } }, observed)).toThrow();
    expect(() => assertLateFramingEvidence({ code: "framing", framing }, { ...observed, format: "JSON" })).toThrow();
    expect(() => assertLateFramingEvidence({ code: "framing", framing: { ...framing, frameBytes: 20_000, bodyBytes: 30_000 } }, observed)).toThrow();
  });
});
