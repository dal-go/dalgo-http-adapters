// The dataset worker the Playwright suite starts. Bundled by test/browser/server.ts.
import { serveDemoDbWorker } from "../../../src/opfs/worker.js";

// `?noopfs=1` hides OPFS the way a Firefox private window or a webview does.
if (new URL(globalThis.location.href).searchParams.has("noopfs")) {
  Reflect.deleteProperty(StorageManager.prototype, "getDirectory");
}

// Reports lock retries to the pages, as evidence for the stale-lock test.
const log = new BroadcastChannel("demodb-test-log");

serveDemoDbWorker({
  pool: {
    onRetry: (error, attempt) => { log.postMessage(`pool retry ${String(attempt)}: ${error.reason} (${String((error.cause as Error | undefined)?.name)})`); },
  },
});
