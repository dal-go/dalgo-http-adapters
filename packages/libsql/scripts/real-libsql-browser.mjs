// Owns one disposable commit-pinned libSQL server and one static loopback page
// origin, then drives real Chromium with the real adapter. libSQL's pinned
// source allows any origin/method/header, so the suite proves an actual
// cross-origin fetch rather than an exact-origin policy.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedLibSQL, startLibSQLFixture } from "./libsql-fixture.mjs";

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
let fixture;
let exitCode = 0;
try {
  fixture = await startLibSQLFixture();
  await seedLibSQL(fixture.url, fixture.writerToken);
  console.log(`real libSQL browser fixture: image=${fixture.image} source=${fixture.sourceCommit} url=${fixture.url}`);
  console.log(`real libSQL browser fixture: static origin http://127.0.0.1:${String(staticPort)}`);
  const test = spawnSync("pnpm", ["exec", "playwright", "test", "test/browser/libsql-browser.spec.ts", "--project=chromium"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(staticPort),
      LIBSQL_BROWSER_URL: fixture.url,
      LIBSQL_BROWSER_READER_TOKEN: fixture.readerToken,
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
        console.log(`real libSQL browser fixture teardown verified: container=${fixture.name} volumes=[${teardown.volumesVerified.join(",")}]`);
      }
      fixture.discardWork();
    } else fixture.keepWork();
  }
}
process.exitCode = exitCode;
