import { expect, vi } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import { AnalyticalError, BigQueryAnalyticalClient, ExecutionFailure, MemoryLedger, canonicalJSON, compileReadPlan,
  type AnalyticalRun, type Bounds, type Execution, type ReadQuery, type ReadPlan, type SourceProfile, type TrustedIdentity, type Clock, type Preview } from "../src/analytical.js";

export interface HTTPScenario {
  id: string; kind: "http-state"; profile: SourceProfile; query_ast: ReadQuery; expected_plan: ReadPlan; execution: Execution; bounds: Bounds;
  http: { request: { method: string; path: string; query: Record<string, string>; body: string }; status: number; headers: Record<string, string>; body: string; body_hex?: string; gzip?: boolean; advance_ms?: number; response_chunk_bytes?: number; transport_error?: boolean }[];
  actions: { op: string; values?: unknown[]; error?: string; ms?: number; counters_unchanged?: boolean; maximum_context_ms?: number }[];
  expected_requests: number; expected_paid_submissions: number; expected_error: string; expected_state: string; expected_reservation_bytes: string;
  expected_runtime_observations?: { js: { bytes: number } };
}
const canonical = (value: string): string => new TextDecoder().decode(canonicalJSON(new TextEncoder().encode(value)));
export async function runHTTPScenario(sc: HTTPScenario): Promise<object> {
  const plan = await compileReadPlan(sc.profile, sc.query_ast);
  expect(plan, sc.id).toEqual(sc.expected_plan);
  let now = Date.UTC(2026, 9, 5, 12);
  const clock: Clock = { now: () => now, sleep: async (ms, signal) => { if (signal?.aborted) throw new AnalyticalError("local_stopped"); now += ms; } };
  let identity: TrustedIdentity = { principal: structuredClone(sc.execution.principal), accessToken: "fixture-token", expiresAt: now + 3600000, read: true, cancel: true };
  const ledger = new MemoryLedger();
  let policy = "unrestricted-explicit";
  let calls = 0; let paid = 0;
  const requests: object[] = []; const actions: object[] = [];
  const client = await BigQueryAnalyticalClient.create({ profiles: [sc.profile], ledger, clock,
    prepare: async () => ({ source: sc.profile, query: sc.query_ast, policyDigest: policy }),
    provider: { authorize: async () => identity },
    fetch: async (url, init) => {
      const fixture = sc.http[calls++];
      expect(fixture, sc.id).toBeDefined();
      if (!fixture) throw new Error("unexpected request");
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://bigquery.googleapis.com");
      expect(init.method).toBe(fixture.request.method);
      expect(parsed.pathname).toBe(fixture.request.path);
      expect(init.redirect).toBe("error"); expect(init.credentials).toBe("omit"); expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-token");
      const query = Object.fromEntries(parsed.searchParams); delete query.alt; delete query.prettyPrint;
      expect(query).toEqual(fixture.request.query);
      const body = typeof init.body === "string" ? canonical(init.body) : "";
      expect(body).toBe(fixture.request.body === "" ? "" : canonical(fixture.request.body));
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
      requests.push({ method: init.method, path: parsed.pathname, query, body });
      if (body && JSON.parse(body).dryRun === false) paid += 1;
      if (fixture.transport_error) throw new Error("fixture connection loss sensitive");
      let wire: Uint8Array = fixture.body_hex ? Uint8Array.from(Buffer.from(fixture.body_hex, "hex")) : new TextEncoder().encode(fixture.body);
      // Browser fetch exposes decompressed bytes. Exercise the compressed fixture
      // through an actual gzip roundtrip before the production body reader.
      if (fixture.gzip) wire = Uint8Array.from(gunzipSync(gzipSync(wire)));
      now += fixture.advance_ms ?? 0;
      const size = fixture.response_chunk_bytes ?? wire.length;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset === wire.length) { controller.close(); return; }
        const end = Math.min(wire.length, offset + Math.max(1, size)); controller.enqueue(wire.slice(offset, end)); offset = end;
      } });
      return new Response(stream, { status: fixture.status, headers: fixture.headers });
    },
  });
  let preview: Preview | undefined; let run: AnalyticalRun | undefined;
  let cursor = ""; let oldCursor = ""; let deadline = ""; let lastError = "";
  let releaseLease: (() => void) | undefined; let leaseDone: Promise<unknown> | undefined;
  for (const action of sc.actions) {
    const before = run ? (await run.receipt()).counters : undefined;
    let code = ""; let delivered: unknown;
    const timers = action.maximum_context_ms === undefined ? undefined : vi.spyOn(globalThis, "setTimeout");
    try {
      switch (action.op) {
        case "preview": preview = await client.preview(sc.execution, sc.bounds); break;
        case "execute":
          if (!preview) throw new Error("missing preview");
          run = await client.execute(await client.approve(preview, preview.approvalDigest)); break;
        case "page": case "row": {
          if (!run) throw new Error("missing run");
          const page = action.op === "page" ? await run.nextPage() : await run.nextRow();
          if (!page) throw new Error("missing page");
          const values = page.rows.flatMap(row => row.map(cell => cell.value));
          expect(values, sc.id).toEqual(action.values);
          delivered = action.op === "page" ? page.rows : values; cursor = page.cursor ?? ""; break;
        }
        case "advance": now += action.ms ?? 0; break;
        case "close": await run?.close(); break;
        case "hold_lease": {
          if (!run) throw new Error("missing run");
          let enter: (() => void) | undefined;
          const entered = new Promise<void>(resolve => { enter = resolve; });
          leaseDone = ledger.withLease((await run.receipt()).runId, undefined, async () => {
            const held = new Promise<void>(resolve => { releaseLease = resolve; }); enter?.(); await held;
          }); await entered; break;
        }
        case "release_lease": releaseLease?.(); await leaseDone; break;
        case "rebind": {
          if (!run) throw new Error("missing run"); oldCursor = cursor;
          const rebound = await client.rebind(await run.receipt(), cursor); cursor = rebound.cursor ?? "";
          expect(rebound.receipt.principal).toEqual(sc.execution.principal); break;
        }
        case "restore_cursor": cursor = oldCursor; break;
        case "resume": if (!run) throw new Error("missing run"); run = await client.resume(await run.receipt(), cursor); break;
        case "status": if (!run) throw new Error("missing run"); await client.status(await run.receipt()); break;
        case "cancel": if (!run) throw new Error("missing run"); await client.cancel(await run.receipt()); break;
        case "expire": identity = { ...identity, expiresAt: now }; break;
        case "scope_off": identity = { ...identity, read: false }; break;
        case "generation": identity = { ...identity, principal: { ...identity.principal, generation: "2" } }; break;
        case "subject": identity = { ...identity, principal: { ...identity.principal, subject: "operator:other" } }; break;
        case "kind": identity = { ...identity, principal: { ...identity.principal, kind: "google-user" } }; break;
        case "policy_change": policy = "changed"; break;
        case "exhaust_bytes": await ledger.update(state => { const r = Object.values(state.runs)[0]; if (r) r.receipt = { ...r.receipt, counters: { ...r.receipt.counters, bytes: r.receipt.bounds.totalResponseBytes } }; }); break;
        case "tamper_cursor": { const v = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { offset: number }; v.offset = 0; cursor = Buffer.from(JSON.stringify(v)).toString("base64url"); break; }
        default: throw new Error(`unknown action ${action.op}`);
      }
    } catch (error) {
      expect(error, `${sc.id}:${action.op}`).toBeInstanceOf(AnalyticalError);
      code = (error as AnalyticalError).code;
      if (error instanceof ExecutionFailure) run = error.run;
    }
    if (timers) {
      const delays = timers.mock.calls.map(call => call[1] ?? 0);
      timers.mockRestore();
      expect(delays.length).toBeGreaterThan(0);
      for (const delay of delays) expect(delay, `${sc.id}:${action.op}:timeout`).toBeLessThanOrEqual(action.maximum_context_ms as number);
    }
    expect(code, `${sc.id}:${action.op}`).toBe(action.error ?? "");
    if (code) lastError = code;
    const observed: Record<string, unknown> = { op: action.op, errorCode: code };
    if (delivered !== undefined) observed.values = delivered;
    if (run) {
      const rr = await ledger.update(state => Object.values(state.runs)[0]);
      if (!rr) throw new Error("missing record");
      const r = rr.receipt;
      if (deadline === "") deadline = r.executionDeadline;
      expect(r.executionDeadline).toBe(deadline);
      if (action.counters_unchanged) expect(r.counters).toEqual(before);
      Object.assign(observed, { counters: r.counters, state: r.state, reservationBytes: rr.reservation, principal: r.principal,
        executionDeadline: r.executionDeadline, job: r.job ?? null, schemaDigest: r.schemaDigest });
      if (rr.cursor) observed.cursorLogical = { ...rr.cursor, runId: "", ledgerRef: "" };
    }
    actions.push(observed);
  }
  expect(calls, sc.id).toBe(sc.expected_requests); expect(paid, sc.id).toBe(sc.expected_paid_submissions); expect(lastError, sc.id).toBe(sc.expected_error);
  if (run) {
    const r = await run.receipt();
    expect(r.state, sc.id).toBe(sc.expected_state); expect(r.reason ?? "").not.toContain("sensitive");
    if (sc.expected_runtime_observations) expect(r.counters.bytes).toBe(sc.expected_runtime_observations.js.bytes);
    expect((await ledger.update(state => Object.values(state.runs)[0]))?.reservation, sc.id).toBe(sc.expected_reservation_bytes);
  }
  return { id: sc.id, plan, actions, requests, paidSubmissions: paid };
}
