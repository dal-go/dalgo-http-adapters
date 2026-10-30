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
const compression = { setting_name: "enable_http_compression", value: "0", min: null, max: null, writability: "CONST", inherit_profile: null };
const prepared = { originalEntries: 11, preserved: true, readonlyConst: true, maxBlockSizeConst: 1, httpCompressionConst: 0 };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixtureAdmin(changeAfter = (rows) => rows, initialRows = baseline, changeTargetAfter = (target) => target, compressionRendering = "0 CONST") {
  let elements = initialRows.map((row) => ({ ...row }));
  const changes = [];
  vi.stubEnv("CLICKHOUSE_FIXTURE_ADMIN_PASSWORD", "synthetic-unit-admin-credential-unused-by-browser");
  vi.stubGlobal("fetch", vi.fn((_url, init) => {
    const sql = init.body;
    if (sql.startsWith("ALTER SETTINGS PROFILE")) {
      changes.push(sql);
      if (!sql.includes(" ADD SETTINGS ")) elements = [];
      else if (sql === "ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS max_block_size=1 CONST") elements = changeAfter([...elements, block]);
      else if (sql === "ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS enable_http_compression=0 CONST") elements = changeAfter([...elements, compression]);
      else throw new Error("unexpected fixture policy mutation");
      return Promise.resolve(new Response(""));
    }
    if (sql.includes("system.settings_profile_elements")) return Promise.resolve(new Response([...elements].sort((a, b) => a.setting_name.localeCompare(b.setting_name)).map((row) => JSON.stringify(row)).join("\n")));
    if (sql.includes("system.settings_profiles")) {
      const target = { name: "fixture_reader_profile", id: "synthetic-profile-id", apply_to_all: 0, apply_to_list: ["fixture_reader"], apply_to_except: [] };
      return Promise.resolve(new Response(JSON.stringify(changes.length ? changeTargetAfter(target) : target)));
    }
    if (sql.startsWith("SHOW CREATE SETTINGS PROFILE")) return Promise.resolve(new Response(`CREATE SETTINGS PROFILE fixture_reader_profile SETTINGS readonly = 1 CONST${elements.some((entry) => entry.setting_name === "max_block_size") ? ", max_block_size = 1 CONST" : ""}${elements.some((entry) => entry.setting_name === "enable_http_compression") ? `, enable_http_compression = ${compressionRendering}` : ""} TO fixture_reader\n`));
    throw new Error("unexpected fixture admin query");
  }));
  return changes;
}

describe("reader fixture policy preparation", () => {
  it("uses two incremental changes and verifies all original server metadata and constraints", async () => {
    const changes = fixtureAdmin();
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).resolves.toEqual(prepared);
    expect(changes).toEqual(["ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS max_block_size=1 CONST", "ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS enable_http_compression=0 CONST"]);
  });
  it("refuses to modify an already unsafe baseline", async () => {
    const changes = fixtureAdmin((rows) => rows, baseline.filter((row) => row.setting_name !== "readonly"));
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow();
    expect(changes).toEqual([]);
  });
  it.each(["0 CONST", "false CONST", "FALSE READONLY"])("accepts canonical SQL false rendering %s with strict stored zero", async (rendering) => {
    fixtureAdmin((rows) => rows, baseline, (target) => target, rendering);
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).resolves.toEqual(prepared);
  });
  it.each(["1 CONST", "true CONST", "false", "0", "'false' CONST", "'0' CONST"])("refuses true, quoted or unconstrained compression rendering %s", async (rendering) => {
    fixtureAdmin((rows) => rows, baseline, (target) => target, rendering);
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow("unquoted SQL false with CONST/READONLY");
  });
  it("revalidates an identical preparation without adding duplicate policy entries", async () => {
    const changes = fixtureAdmin((rows) => rows, [...baseline, block, compression]);
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).resolves.toEqual(prepared);
    expect(changes).toEqual([]);
  });
  it.each([block, compression])("completes an identical partial preparation with only its missing setting: $setting_name", async (existing) => {
    const changes = fixtureAdmin((rows) => rows, [...baseline, existing]);
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).resolves.toEqual(prepared);
    expect(changes).toEqual(existing.setting_name === "max_block_size"
      ? ["ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS enable_http_compression=0 CONST"]
      : ["ALTER SETTINGS PROFILE fixture_reader_profile ADD SETTINGS max_block_size=1 CONST"]);
  });
  for (const setting of [block, compression]) {
    it.each([{ value: "2" }, { writability: "WRITABLE" }, { min: "0" }, { max: "2" }, { inherit_profile: "foreign" }])(`refuses conflicting preexisting ${setting.setting_name} value or constraints: %j`, async (mutation) => {
      const changes = fixtureAdmin((rows) => rows, [...baseline, { ...setting, ...mutation }]);
      await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow();
      expect(changes).toEqual([]);
    });
  }
  it.each(baseline.map((entry) => entry.setting_name))("detects weakened %s after preparation", async (setting) => {
    fixtureAdmin((rows) => rows.map((row) => row.setting_name === setting ? { ...row, writability: "WRITABLE", max: null, value: "0" } : row));
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow();
  });
  it.each(baseline.map((entry) => entry.setting_name))("detects dropped %s after preparation", async (setting) => {
    fixtureAdmin((rows) => rows.filter((row) => row.setting_name !== setting));
    await expect(prepareLateErrorFixture("http://127.0.0.1:8123")).rejects.toThrow();
  });
  it("refuses a changed profile UUID after incremental preparation", async () => {
    fixtureAdmin((rows) => rows, baseline, (target) => ({ ...target, id: "changed-profile-id" }));
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
