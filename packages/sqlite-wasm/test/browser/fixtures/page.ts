// The page the Playwright suite drives. Bundled by test/browser/server.ts.
import { Key } from "@dalgo/core";
import { WorkerClient, openDemoDb, type CanonicalPin, type DemoDbSession, type LeaderContext, type OpenReport } from "../../../src/opfs/index.js";

type Operation =
  | { readonly op: "get"; readonly table: string; readonly id: number }
  | { readonly op: "update"; readonly table: string; readonly id: number; readonly data: Record<string, unknown> }
  | { readonly op: "delete"; readonly table: string; readonly id: number }
  | { readonly op: "count"; readonly table: string };

async function handle(payload: unknown, { database }: LeaderContext): Promise<unknown> {
  const operation = payload as Operation;
  switch (operation.op) {
    case "get": {
      const snapshot = await database.get(new Key(operation.table, operation.id));
      return snapshot.exists ? snapshot.data : null;
    }
    case "update":
      await database.runReadwriteTransaction((tx) => tx.update(new Key(operation.table, operation.id), operation.data));
      return true;
    case "delete":
      await database.runReadwriteTransaction((tx) => tx.delete(new Key(operation.table, operation.id)));
      return true;
    case "count":
      return (await database.query({ source: { kind: "collection", name: operation.table }, filters: [], orders: [] })).records.length;
  }
}

let session: DemoDbSession | undefined;
const events: string[] = [];
// Worker log lines, kept across reloads of this tab.
const logs = JSON.parse(sessionStorage.getItem("demodb-test-log") ?? "[]") as string[];
new BroadcastChannel("demodb-test-log").addEventListener("message", (event) => {
  logs.push(String(event.data));
  sessionStorage.setItem("demodb-test-log", JSON.stringify(logs));
});

function current(): DemoDbSession {
  if (session === undefined) throw new Error("not open");
  return session;
}

const harness = {
  crossOriginIsolated: (): boolean => globalThis.crossOriginIsolated,
  /** Deletes everything in this origin's OPFS. Retries while a closing worker still holds handles. */
  async wipe(): Promise<void> {
    const root = await navigator.storage.getDirectory() as unknown as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
    for (let attempt = 1; ; attempt += 1) {
      try {
        for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
        return;
      } catch (error) {
        if (attempt >= 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  },
  async pins(): Promise<Record<string, CanonicalPin>> {
    return await (await fetch("/pins.json")).json() as Record<string, CanonicalPin>;
  },
  async open(pin: CanonicalPin, options: { readonly noOpfs?: boolean } = {}): Promise<OpenReport> {
    session = openDemoDb({
      pin,
      createWorker: () => new Worker(`/worker.js${options.noOpfs === true ? "?noopfs=1" : ""}`, { type: "module" }),
      serve: {
        request: handle,
        port: (port, context) => {
          const listener = (event: MessageEvent): void => {
            const message = event.data as { readonly id: number; readonly payload: unknown };
            void handle(message.payload, context).then(
              (result) => { port.postMessage({ id: message.id, ok: true, result }); },
              (error: unknown) => { port.postMessage({ id: message.id, ok: false, error: String(error) }); },
            );
          };
          port.addEventListener("message", listener);
          return () => { port.removeEventListener("message", listener); };
        },
      },
    });
    session.subscribe((event) => { events.push(event.type === "role" ? `role:${event.role}` : event.type); });
    return session.ready();
  },
  role: (): string => current().role,
  report: (): OpenReport | undefined => current().report,
  events: (): string[] => events,
  logs: (): string[] => logs,
  request: (payload: Operation): Promise<unknown> => current().request(payload),
  /** Retries requests that failed because the leader changed, as an app would. */
  async requestRetrying(payload: Operation, attempts = 50): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await current().request(payload);
      } catch (error) {
        if ((error as { readonly retriable?: unknown }).retriable !== true || attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  },
  /** One request over a bridge port, answered by the leader's port handler. */
  portRequest(payload: Operation): Promise<unknown> {
    const port = current().connect({
      requestId: (message) => (message as { readonly id: number }).id,
      responseId: (message) => (message as { readonly id: number }).id,
      failure: (request, error) => ({ id: (request as { readonly id: number }).id, ok: false, error: error.name }),
    });
    return new Promise((resolve, reject) => {
      port.addEventListener("message", (event) => {
        const answer = event.data as { readonly ok: boolean; readonly result?: unknown; readonly error?: string };
        port.close();
        if (answer.ok) resolve(answer.result);
        else reject(new Error(answer.error));
      });
      port.postMessage({ id: 1, payload });
    });
  },
  /**
   * Opens the dataset in a worker that keeps its sync access handles, then
   * opens it again in a second worker, bypassing leader election, and
   * terminates the first worker after `holdMs`: the second must wait for the
   * handles instead of failing or wiping the pool.
   */
  async lockedPool(pin: CanonicalPin, holdMs: number): Promise<{ readonly report: unknown; readonly name: unknown; readonly waitedMs: number }> {
    const first = new WorkerClient(new Worker("/worker.js", { type: "module" }));
    await first.call("open", { pin });
    await first.call("exec", { sql: "UPDATE Artist SET Name = 'held' WHERE ArtistId = 8" });
    const second = new WorkerClient(new Worker("/worker.js", { type: "module" }));
    const started = performance.now();
    const opening = second.call("open", { pin });
    setTimeout(() => { first.terminate(); }, holdMs);
    const report = await opening;
    const waitedMs = performance.now() - started;
    const { rows } = await second.call("exec", { sql: "SELECT Name FROM Artist WHERE ArtistId = 8" }) as { rows: { Name: unknown }[] };
    second.terminate();
    return { report, name: rows[0]?.Name, waitedMs };
  },
  /**
   * Holds the pool open in one worker and opens it in a second worker with
   * two short attempts: the second must fail as locked, or open in memory
   * when `memoryWhenLocked` is set.
   */
  async stuckPool(pin: CanonicalPin, memoryWhenLocked: boolean): Promise<unknown> {
    const first = new WorkerClient(new Worker("/worker.js", { type: "module" }));
    await first.call("open", { pin });
    const second = new WorkerClient(new Worker("/worker.js?attempts=2", { type: "module" }));
    try {
      return await second.call("open", { pin, options: { memoryWhenLocked } });
    } catch (error) {
      const failure = error as Error & { reason?: unknown; retriable?: unknown };
      return { error: failure.name, reason: failure.reason, retriable: failure.retriable };
    } finally {
      first.terminate();
      second.terminate();
    }
  },
  async reset(): Promise<unknown> { return current().reset(); },
  /** Firefox asks the user before granting persistence, so an unanswered prompt reads as "pending". */
  persistence: async (): Promise<string | undefined> => {
    const result = current().persistence();
    if (result === undefined) return undefined;
    return Promise.race([result, new Promise<string>((resolve) => setTimeout(() => { resolve("pending"); }, 1000))]);
  },
  close(): void { current().close(); },
};

(globalThis as unknown as { harness: typeof harness }).harness = harness;
