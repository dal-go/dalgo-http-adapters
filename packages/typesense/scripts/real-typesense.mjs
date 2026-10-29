// Owns one disposable commit-pinned Typesense 30.2 server, seeds native
// collections through the bootstrap key, creates scoped search/metadata keys,
// runs the real Node-suite, and verifies exact resource removal on every exit.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedTypesense, startTypesenseFixture } from "./typesense-fixture.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fixture;
let exitCode = 0;
try {
  fixture = await startTypesenseFixture({ staticOrigin: "http://127.0.0.1:9" });
  const keys = await seedTypesense(fixture);
  console.log(`real Typesense fixture: image=${fixture.image} version=${fixture.version} url=${fixture.endpoint}`);
  const test = spawnSync("pnpm", ["exec", "vitest", "run", "test/real-typesense.real.test.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      TYPESENSE_TEST_URL: fixture.endpoint,
      TYPESENSE_TEST_SEARCH_KEY: keys.searchKey,
      TYPESENSE_TEST_METADATA_KEY: keys.metadataKey,
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
        console.log(`real Typesense fixture teardown verified: container=${fixture.name} volume=${fixture.volume}`);
      }
      fixture.discardWork();
    } else fixture.keepWork();
  }
}
process.exitCode = exitCode;
