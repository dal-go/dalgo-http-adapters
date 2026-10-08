import type { ProviderReadPlan, QueryExecutor, QueryMetadata, QueryPage, StructuredQuery } from "@dalgo/core";
import { assertOpenVaultDbExecutionBudget, raceOpenVaultDbExecutionBudget, type OpenVaultDbExecutionBudget } from "./budget.js";
import { assertOpenVaultDbDTQLConfiguration, validateOpenVaultDbDTQLEvidence, validateOpenVaultDbDTQLPlan, type OpenVaultDbDTQLPlanConfiguration } from "./plan.js";
import { encodeNativeQuery, nativeRecords } from "./wire.js";
export type CompletedOpenVaultDbQueryPage<T> = QueryPage<T> & { readonly complete: true };
export interface OpenVaultDbDTQLQueryOptions extends OpenVaultDbDTQLPlanConfiguration {
  readonly providerReadPlan: ProviderReadPlan;
  readonly budget: OpenVaultDbExecutionBudget;
  readonly fetch?: typeof globalThis.fetch;
}
const attempted = new WeakSet<OpenVaultDbExecutionBudget>();
/** One admitted execution, one POST, no retry or automatic direct fallback. */
export class OpenVaultDbDTQLQueryExecutor implements QueryExecutor {
  readonly #config: OpenVaultDbDTQLPlanConfiguration;
  readonly #plan: ProviderReadPlan;
  readonly #budget: OpenVaultDbExecutionBudget;
  readonly #fetch: typeof globalThis.fetch;
  #used = false;
  public constructor(options: OpenVaultDbDTQLQueryOptions) {
    assertOpenVaultDbExecutionBudget(options.budget);
    const { providerReadPlan, budget, fetch: fetcher, ...configuration } = options;
    this.#config = structuredClone(configuration);
    this.#plan = structuredClone(providerReadPlan);
    this.#budget = budget;
    this.#fetch = fetcher ?? globalThis.fetch;
  }
  public async query<T>(query: StructuredQuery<T>, options?: { readonly signal?: AbortSignal }): Promise<CompletedOpenVaultDbQueryPage<T>> {
    if (this.#used) throw new TypeError("OpenVaultDB execution already used");
    this.#used = true;
    const budget = this.#budget;
    assertOpenVaultDbExecutionBudget(budget);
    if (options !== undefined && options.signal !== budget.signal) throw new TypeError("unbound OpenVaultDB execution signal");
    const { body, limit, filters } = encodeNativeQuery(query);
    const plan = this.#plan, config = this.#config;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
    let refused = false;
    try {
      await validateOpenVaultDbDTQLPlan(config, plan, budget);
      assertOpenVaultDbExecutionBudget(budget);
      assertOpenVaultDbDTQLConfiguration(config);
      if (attempted.has(budget)) throw new TypeError();
      attempted.add(budget);
      const request = this.#fetch(config.endpoint, { method: "POST", body,
        headers: { "Content-Type": "application/yaml", Accept: "application/json", "OVDB-Execution-ID": plan.execution.id },
        credentials: "omit", mode: "cors", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: budget.signal });
      void request.then(late => { if (refused || budget.signal.aborted || performance.now() >= budget.deadlineAt) void late.body?.cancel().catch(() => undefined); }, () => undefined);
      response = await raceOpenVaultDbExecutionBudget(budget, request);
      if (response.status !== 200 || response.type === "opaque" || response.type === "opaqueredirect" || response.redirected
        || (response.url !== "" && response.url !== config.endpoint)
        || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? "")
        || !response.headers.get("Cache-Control")?.split(",").some(part => part.trim().toLowerCase() === "no-store") || response.body === null) throw new TypeError();
      const length = response.headers.get("Content-Length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 65536)) throw new TypeError();
      reader = response.body.getReader();
      const buffer = new Uint8Array(65536); let size = 0;
      for (;;) {
        const chunk = await raceOpenVaultDbExecutionBudget(budget, reader.read());
        if (chunk.done) break;
        if (chunk.value.byteLength > buffer.byteLength - size) throw new TypeError();
        buffer.set(chunk.value, size); size += chunk.value.byteLength;
      }
      assertOpenVaultDbExecutionBudget(budget);
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
      assertOpenVaultDbExecutionBudget(budget);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError();
      const envelope = raw as Record<string, unknown>, keys = ["records", "complete", "sourceRights", "usedSourceIds", "providerReads"];
      if (Reflect.ownKeys(envelope).length !== keys.length || keys.some(key => !Object.hasOwn(envelope, key)) || envelope.complete !== true) throw new TypeError();
      // Evidence precedes every record/key/data access, including zero rows.
      const metadata = await validateOpenVaultDbDTQLEvidence({ sourceRights: envelope.sourceRights,
        usedSourceIds: envelope.usedSourceIds, providerReads: envelope.providerReads } as QueryMetadata, plan, budget);
      assertOpenVaultDbExecutionBudget(budget);
      assertOpenVaultDbDTQLConfiguration(config);
      const referenceDate = metadata.providerReads?.reads[0]?.referenceDate;
      if (referenceDate === undefined) throw new TypeError();
      const records = nativeRecords<T>(envelope.records, limit, referenceDate, filters);
      assertOpenVaultDbExecutionBudget(budget);
      return { ...metadata, records, complete: true };
    } catch {
      refused = true;
      if (reader !== undefined) void reader.cancel().catch(() => undefined);
      else void response?.body?.cancel().catch(() => undefined);
      assertOpenVaultDbExecutionBudget(budget);
      throw new TypeError("refused OpenVaultDB DTQL execution");
    } finally { reader?.releaseLock(); }
  }
}
