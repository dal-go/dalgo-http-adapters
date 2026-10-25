import { expect } from "vitest";
import type { HTTPScenario } from "./contract-http.js";
/** Compare untouched reports. Only the immutable rejected-overflow observation
 * permits a byte-counter difference; all paths and other values remain exact. */
export function compareHTTPReports(js: unknown[], go: unknown[], scenarios: readonly HTTPScenario[]): void {
  expect(js.length).toBe(scenarios.length); expect(go.length).toBe(scenarios.length);
  const compare = (a: unknown, b: unknown, path: string[], scenario: HTTPScenario): void => {
    const variance = scenario.expected_runtime_observations;
    if (variance && path.length === 4 && path[0] === "actions" && path[2] === "counters" && path[3] === "bytes" && a !== b) {
      expect(a, `${scenario.id}:${path.join(".")}`).toBe(variance.js.bytes);
      expect(b, `${scenario.id}:${path.join(".")}`).toBe((variance as unknown as { go: { bytes: number } }).go.bytes);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      expect(a.length, `${scenario.id}:${path.join(".")}`).toBe(b.length);
      for (let i = 0; i < a.length; i += 1) compare(a[i], b[i], [...path, String(i)], scenario);
    } else if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
      const x = a as Record<string, unknown>; const y = b as Record<string, unknown>;
      expect(Object.keys(x).sort(), `${scenario.id}:${path.join(".")}`).toEqual(Object.keys(y).sort());
      for (const key of Object.keys(x)) compare(x[key], y[key], [...path, key], scenario);
    } else expect(a, `${scenario.id}:${path.join(".")}`).toEqual(b);
  };
  for (let i = 0; i < js.length; i += 1) {
    const id = (js[i] as { id: string }).id;
    const scenario = scenarios.find(s => s.id === id);
    expect(scenario).toBeDefined(); if (!scenario) throw new Error("unknown parity case");
    compare(js[i], go[i], [], scenario);
  }
}
