// Owns one disposable commit-pinned libSQL server, seeds native tables through
// the external writer token, proves the reader token cannot write, then runs
// the adapter against the actual service. No account, hosted Turso resource or
// production database is involved.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedLibSQL, startLibSQLFixture } from "./libsql-fixture.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fixture;
let exitCode = 0;
try {
  fixture = await startLibSQLFixture();
  await seedLibSQL(fixture.url, fixture.writerToken);

  const probe = await fetch(`${fixture.url}/v3/pipeline`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${fixture.readerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      baton: null,
      requests: [
        { type: "execute", stmt: { sql: "INSERT INTO items (id, title) VALUES (99, 'reader must fail')", args: [], want_rows: false } },
        { type: "close" },
      ],
    }),
  });
  if (probe.status !== 403) throw new Error(`the reader token unexpectedly wrote: HTTP ${String(probe.status)}`);

  console.log(`real libSQL fixture: image=${fixture.image} source=${fixture.sourceCommit} url=${fixture.url}`);
  console.log(`real libSQL fixture: reader write probe HTTP ${String(probe.status)} (expected 403)`);
  const test = spawnSync("pnpm", ["exec", "vitest", "run", "test/real-libsql.real.test.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      LIBSQL_TEST_URL: fixture.url,
      LIBSQL_TEST_READER_TOKEN: fixture.readerToken,
      LIBSQL_TEST_IMAGE: fixture.image,
      LIBSQL_TEST_SOURCE_COMMIT: fixture.sourceCommit,
    },
  });
  exitCode = test.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  if (fixture !== undefined) {
    try {
      fixture.stop();
    } catch (error) {
      console.error(`fixture teardown failed: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
    fixture.detachSignalHandlers();
    if (exitCode === 0) fixture.discardWork();
    else fixture.keepWork();
  }
}
process.exitCode = exitCode;
