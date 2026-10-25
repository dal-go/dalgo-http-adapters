import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  AnalyticalError, canonicalJSON, decodeRows, hashPayload, JsonNumber,
  MAX_RESPONSE_BYTES, normalizeScalar, normalizeScalarBytes, operationDeadline, parseJSON,
  type AnalyticalField, type HashPayloadName,
} from "../src/analytical.js";

import { runHTTPScenario, type HTTPScenario } from "./contract-http.js";
import { compareHTTPReports } from "./contract-parity.js";

interface Scenario {
  readonly id: string;
  readonly kind: string;
  readonly input?: string;
  readonly input_hex?: string;
  readonly canonical?: string;
  readonly digest?: string;
  readonly field: AnalyticalField;
  readonly value?: unknown;
  readonly expected?: unknown;
  readonly error: string;
  readonly payload?: HashPayloadName;
}
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const read = (name: string): Uint8Array => readFileSync(new URL(`../testdata/contract/${name}`, import.meta.url));
const manifestBytes = read("manifest.json");
const manifest = JSON.parse(text(manifestBytes)) as { revision: number; scenario_count: number; files: Record<string, string> };
const origin = JSON.parse(text(read("origin.json"))) as { commit: string; manifest_sha256: string };
const scenarios: Scenario[] = [];
const seen = new Set<string>();

expect(origin.commit).toBe("b051a8cd34e9e1e51540d3598bc6d54714da52fc");
expect(sha(manifestBytes)).toBe("094b5caa11df6eb0ddef6498394b0c529464ee6ad01c75611a7a3cdb22ad64c1");
expect(origin.manifest_sha256).toBe(sha(manifestBytes));
expect(manifest.revision).toBe(3);
for (const [file, digest] of Object.entries(manifest.files)) {
  const data = read(file);
  expect(sha(data)).toBe(digest);
  for (const scenario of JSON.parse(text(data)) as Scenario[]) {
    expect(scenario.id).not.toBe("");
    expect(seen.has(scenario.id)).toBe(false);
    seen.add(scenario.id);
    scenarios.push(scenario);
  }
}
expect(scenarios.length).toBe(manifest.scenario_count);
expect(scenarios.length).toBe(168);

describe("immutable revision 3 production corpus", () => {
  it("matches all 168 normalized results, errors, canonical bytes and digests", async () => {
    const outcomes: object[] = [];
    const httpOutcomes: object[] = [];
    for (const scenario of scenarios) {
      if (scenario.kind === "http-state") { httpOutcomes.push(await runHTTPScenario(scenario as unknown as HTTPScenario)); outcomes.push({ id: scenario.id, kind: scenario.kind, error: "", production_http: true }); continue; }
      let result: unknown;
      let code = "";
      let canonical: string | undefined;
      let digest: string | undefined;
      try {
        switch (scenario.kind) {
          case "canonical": {
            const encoded = canonicalJSON(bytes(scenario.input ?? ""));
            canonical = text(encoded);
            digest = sha(encoded);
            break;
          }
          case "hash": {
            const hashed = await hashPayload(scenario.payload as HashPayloadName, bytes(scenario.input ?? ""));
            canonical = text(hashed.canonical);
            digest = hashed.digest;
            break;
          }
          case "scalar": result = normalizeScalar(scenario.field, scenario.value).value; break;
          case "scalar-bytes": result = normalizeScalarBytes(scenario.field, Uint8Array.from(Buffer.from(scenario.input_hex ?? "", "hex"))).value; break;
          case "rows": result = decodeRows(bytes(scenario.input ?? ""), [scenario.field]); break;
          default: throw new Error("unknown corpus kind");
        }
      } catch (error) {
        expect(error, scenario.id).toBeInstanceOf(AnalyticalError);
        code = (error as AnalyticalError).code;
      }
      expect(code, scenario.id).toBe(scenario.error ?? "");
      if (code === "") {
        if (scenario.kind === "canonical" || scenario.kind === "hash") {
          expect(canonical, scenario.id).toBe(scenario.canonical);
          expect(digest, scenario.id).toBe(scenario.digest);
        } else { expect(result, scenario.id).toEqual(scenario.expected); }
      }
      outcomes.push({ id: scenario.id, kind: scenario.kind, error: code,
        ...(code !== "" ? {} : canonical === undefined ? { result } : { canonical, digest }) });
    }
    httpOutcomes.sort((a,b) => (a as { id: string }).id.localeCompare((b as { id: string }).id));
    const goReport = process.env.BIGQUERY_GO_CONTRACT_REPORT;
    if (goReport !== undefined) compareHTTPReports(httpOutcomes, JSON.parse(readFileSync(goReport, "utf8")) as unknown[], scenarios.filter(s => s.kind === "http-state") as unknown as HTTPScenario[]);
    const httpReport = process.env.BIGQUERY_CONTRACT_REPORT;
    if (httpReport !== undefined) writeFileSync(httpReport, JSON.stringify(httpOutcomes.sort((a,b) => (a as { id: string }).id.localeCompare((b as { id: string }).id)), null, 2) + "\n");
    const reportPath = process.env.BIGQUERY_PARITY_REPORT;
    if (reportPath !== undefined) writeFileSync(reportPath, JSON.stringify({
      runtime: "JavaScript production", corpus_commit: origin.commit,
      manifest_sha256: sha(manifestBytes), scenario_count: outcomes.length,
      scenarios: outcomes.sort((a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id)),
    }, null, 2) + "\n");
  });
});

describe("production boundaries beyond the shared subset", () => {
  it("preserves raw numeric lexemes and rejects malformed JSON before conversion", () => {
    expect(parseJSON(bytes("9007199254740993"), 100)).toEqual(new JsonNumber("9007199254740993"));
    for (const input of ['{"x":1,"x":2}', '[1,]', '{"x":1,}', '[] []', '"\\ud800"', '"\\udfff"', '01', '1.', 'truex', '\ufeffnull']) {
      expect(() => parseJSON(bytes(input), 100), input).toThrow("malformed_wire");
    }
    for (const input of ['"\\ud800\\udc00"', '"\\\\ud800"', '{"__proto__":1}']) expect(() => parseJSON(bytes(input), 100)).not.toThrow();
    expect(() => parseJSON(new Uint8Array([255]), 100)).toThrow("malformed_wire");
    expect(() => parseJSON(bytes("null"), 3)).toThrow("response_limit");
    expect(() => parseJSON(bytes("[".repeat(34) + "0" + "]".repeat(34)), 1000)).toThrow("response_limit");
    expect(() => parseJSON(bytes("null"), MAX_RESPONSE_BYTES + 1)).toThrow("response_limit");
  });

  it("checks direct scalar Unicode, wire types, byte lengths and complete lexemes", () => {
    for (const value of ["\ud800", "\udfff", "😀\ud800"]) expect(() => normalizeScalar({ type: "STRING" }, value)).toThrow("malformed_wire");
    for (const value of ["", "é", "e\u0301", "😀<>&\u2028\u2029", null]) expect(normalizeScalar({ type: "STRING" }, value).value).toBe(value);
    for (const value of [undefined, 1, false, {}, new String("x")]) expect(() => normalizeScalar({ type: "STRING" }, value)).toThrow("malformed_wire");
    expect(() => normalizeScalar({ type: "STRING" }, "é".repeat(524289))).toThrow("response_limit");
    for (const type of ["FLOAT64", "INT64", "NUMERIC", "BYTES", "DATE", "TIME"]) {
      expect(() => normalizeScalar({ type }, "1\n")).toThrow("unsupported_value");
    }
    for (const value of ["Zh==", "Zm9=", "Zg", "Zg==="]) expect(() => normalizeScalar({ type: "BYTES" }, value)).toThrow("unsupported_value");
    expect(normalizeScalar({ type: "BYTES" }, "Zg==").value).toBe("Zg==");
  });

  it("sorts integer-like keys lexically and excludes only named top-level fields", async () => {
    expect(text(canonicalJSON(bytes('{"2":1,"10":2}')))).toBe('{"10":2,"2":1}');
    for (const input of ["1.0", "1e0", "1.0000000000000001"]) expect(() => canonicalJSON(bytes(input))).toThrow("unsupported_value");
    const base = '{"version":1,"sourceDigest":"s","projection":["n"],"where":{"digest":"bound"},"order":[],"limit":1,"parameters":[],"sql":"s","digest":"ignored"}';
    const a = await hashPayload("ReadPlan", bytes(base));
    expect((await hashPayload("ReadPlan", bytes(base.replace("ignored", "other")))).digest).toBe(a.digest);
    expect((await hashPayload("ReadPlan", bytes(base.replace("bound", "changed")))).digest).not.toBe(a.digest);
    await expect(hashPayload("ReadPlan", bytes(base.replace('"limit":1', '"limit":1,"unexpected":2')))).rejects.toThrow("invalid_input");
    await expect(hashPayload("ReadPlan", bytes("[]"))).rejects.toThrow("invalid_input");
  });

  it("bounds row counts and field shapes without inventing keys", () => {
    expect(() => decodeRows(bytes("[]"), [])).toThrow("invalid_input");
    expect(() => decodeRows(bytes(JSON.stringify(Array.from({ length: 1001 }, () => ({ f: [{ v: "a" }] })))), [{ type: "STRING" }])).toThrow("response_limit");
    for (const input of ['[{"f":[{"v":"x","extra":1}]}]', '[{"f":[{"v":"x"}],"extra":1}]']) {
      expect(() => decodeRows(bytes(input), [{ type: "STRING" }])).toThrow("malformed_wire");
    }
  });

  it("never renews the original deadline or cumulative counters on resume", () => {
    const start = Date.UTC(2026, 9, 5);
    const ledger = Object.freeze({ runStartedAt: start, executionDeadline: start + 120000, rows: 2, pages: 1, bytes: 100n, receipt: "existing-job" });
    const input = { now: start + 119000, executionDeadline: ledger.executionDeadline, httpLimitMs: 15000, control: false, bytesRemaining: 100n };
    expect(operationDeadline(input)).toBe(ledger.executionDeadline);
    expect(operationDeadline({ ...input, callerDeadline: start + 119500 })).toBe(start + 119500);
    expect(() => operationDeadline({ ...input, now: start + 121000 })).toThrow("local_stopped");
    expect(operationDeadline({ ...input, now: start + 121000, control: true })).toBe(start + 136000);
    expect(operationDeadline({ ...input, executionDeadline: 0, control: true })).toBe(input.now + 15000);
    expect(() => operationDeadline({ ...input, now: start + 121000, control: true, bytesRemaining: 0n })).toThrow("response_limit");
    expect(() => operationDeadline({ ...input, httpLimitMs: 15001 })).toThrow("invalid_input");
    expect(() => operationDeadline({ ...input, callerDeadline: input.now })).toThrow("local_stopped");
    expect(ledger).toEqual({ runStartedAt: start, executionDeadline: start + 120000, rows: 2, pages: 1, bytes: 100n, receipt: "existing-job" });
    // These are pure bound calculations; zero-dispatch executor/ledger proof is
    // mandatory in the subsequent transport tranche, not claimed by this test.
  });
});
