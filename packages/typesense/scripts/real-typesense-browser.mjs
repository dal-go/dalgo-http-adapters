// Owns one disposable Typesense 30.2 server and one random static loopback page
// origin, then drives real Chromium with the real adapter and the browser's
// default fetch. Typesense allows exactly that origin; nothing is proxied,
// routed or intercepted.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedTypesense, startTypesenseFixture } from "./typesense-fixture.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      probe.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

const staticPort = await freePort();
const staticOrigin = `http://127.0.0.1:${String(staticPort)}`;
let fixture;
let exitCode = 0;
try {
  fixture = await startTypesenseFixture({ staticOrigin });
  const keys = await seedTypesense(fixture);
  console.log(`real Typesense browser fixture: image=${fixture.image} version=${fixture.version} url=${fixture.endpoint} staticOrigin=${staticOrigin}`);
  const test = spawnSync("pnpm", ["exec", "playwright", "test", "test/browser/typesense-browser.spec.ts", "--project=chromium"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(staticPort),
      TYPESENSE_BROWSER_URL: fixture.endpoint,
      TYPESENSE_BROWSER_STATIC_ORIGIN: staticOrigin,
      TYPESENSE_BROWSER_SEARCH_KEY: keys.searchKey,
      TYPESENSE_BROWSER_METADATA_KEY: keys.metadataKey,
    },
  });
  exitCode = test.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  if (fixture !== undefined) {
    let teardown;
    try {
      teardown = fixture.stop();
    } catch (error) {
      console.error(`fixture teardown failed: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
    fixture.detachSignalHandlers();
    if (exitCode === 0) {
      if (teardown !== undefined) {
        console.log(`real Typesense browser fixture teardown verified: container=${fixture.name} volume=${fixture.volume}`);
      }
      fixture.discardWork();
    } else fixture.keepWork();
  }
}
process.exitCode = exitCode;
