// Run only in the coordinator-owned capped container, after npm run build.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBConnection, DuckDBInstance, DuckDBPreparedStatement } from '@duckdb/node-api';
import { NodeDuckDBDatabase } from '../dist/node.js';
const directory = await mkdtemp(join(tmpdir(), 'dalgo-duckdb-'));
try {
  const dbPath = join(directory, 'fixture.duckdb');
  const parquetPath = join(directory, 'fixture.parquet');
  const forbiddenPath = join(directory, 'private.csv');
  await writeFile(forbiddenPath, 'secret\nprivate-token\n');
  const db = await DuckDBInstance.create(dbPath);
  const conn = await db.connect();
  await conn.run("CREATE TABLE fixture AS SELECT i, (9007199254740993 + i)::BIGINT AS exact, (12.0034)::DECIMAL(12,4) AS amount FROM range(3) t(i)");
  await conn.run(`COPY fixture TO '${parquetPath.replaceAll("'", "''")}' (FORMAT PARQUET)`);
  conn.closeSync(); db.closeSync();
  const adapter = new NodeDuckDBDatabase({ databasePath: dbPath, parquetPaths: [parquetPath] });
  const query = sql => adapter.queryOrdinal({ kind: 'native', sql });
  const rows = await query('SELECT exact, amount FROM fixture ORDER BY i');
  assert.equal(rows.rows.length, 3);
  assert.deepEqual(rows.rows[0], [{ kind: 'integer', value: '9007199254740993' }, { kind: 'decimal', unscaled: '120034', scale: 4 }]);
  const parquet = await query(`SELECT exact FROM read_parquet('${parquetPath.replaceAll("'", "''")}') ORDER BY i`);
  assert.deepEqual(parquet.rows[0], [{ kind: 'integer', value: '9007199254740993' }]);
  await assert.rejects(query(`SELECT * FROM read_csv('${forbiddenPath.replaceAll("'", "''")}')`));
  await assert.rejects(query("DELETE FROM fixture"));
  await assert.rejects(query("SELECT 1; DELETE FROM fixture"));
  await assert.rejects(new NodeDuckDBDatabase({ databasePath: dbPath, maxRows: 1 }).queryOrdinal({ kind: 'native', sql: 'SELECT * FROM fixture' }), { code: 'bounds' });
  const controller = new AbortController();
  // Fixture-only instrumentation: observe the actual native streaming dispatch,
  // not a timer that might abort while the engine is still being initialized.
  const originalStream = DuckDBConnection.prototype.stream;
  const originalPreparedStream = DuckDBPreparedStatement.prototype.stream;
  const originalInterrupt = DuckDBConnection.prototype.interrupt;
  let heavyConnection;
  let streamObserved = false;
  let nativeDispatched = false;
  let interruptObserved = false;
  let nativeSettled = Promise.resolve();
  DuckDBConnection.prototype.stream = function (sql, ...args) {
    if (sql.includes('range(1000000000000)')) { heavyConnection = this; streamObserved = true; }
    return originalStream.call(this, sql, ...args);
  };
  DuckDBPreparedStatement.prototype.stream = function (...args) {
    // In pinned NodeAPI1.4.5 this public method calls the native
    // execute_prepared_streaming binding synchronously before its first await.
    const pending = originalPreparedStream.apply(this, args);
    if (heavyConnection !== undefined && !nativeDispatched) {
      nativeDispatched = true;
      nativeSettled = pending.then(() => undefined, () => undefined);
      setImmediate(() => controller.abort('synthetic-secret-reason'));
    }
    return pending;
  };
  DuckDBConnection.prototype.interrupt = function (...args) {
    if (this === heavyConnection) interruptObserved = true;
    return originalInterrupt.apply(this, args);
  };
  const watchdog = setTimeout(() => controller.abort('fixture-dispatch-watchdog'), 5000);
  let settleTimer;
  try {
    const cancelled = adapter.queryOrdinal({ kind: 'native', sql: 'SELECT sum(hash(i)) FROM range(1000000000000) t(i)' }, controller.signal);
    await assert.rejects(cancelled, error => {
      assert.equal(error.reason, 'caller');
      assert.doesNotMatch(error.message, /synthetic-secret|fixture-dispatch-watchdog/u);
      return true;
    });
    assert.equal(streamObserved, true, 'heavy SQL never reached the connection');
    assert.equal(nativeDispatched, true, 'heavy SQL never reached native streaming execution');
    assert.equal(interruptObserved, true, 'adapter never interrupted the active native connection');
    await Promise.race([nativeSettled, new Promise((_, reject) => {
      settleTimer = setTimeout(() => reject(new Error('native query did not settle after interruption')), 5000);
    })]);
    // Let the adapter finish closing its interrupted connection and instance.
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    clearTimeout(watchdog); clearTimeout(settleTimer);
    DuckDBConnection.prototype.stream = originalStream;
    DuckDBPreparedStatement.prototype.stream = originalPreparedStream;
    DuckDBConnection.prototype.interrupt = originalInterrupt;
  }
  assert.equal((await query('SELECT count(*) AS n FROM fixture')).rows[0][0].value, '3');
  assert.equal((await readFile(forbiddenPath, 'utf8')).includes('private-token'), true);
  console.log(JSON.stringify({ passed: true, engine: 'DuckDB1.4.5 NodeNeo', exactInteger: true, parquet: true, forbiddenFilesystem: true, readOnly: true, bounds: true, cancellation: true, cancellationAfterNativeDispatch: nativeDispatched, nativeInterruptObserved: interruptObserved }));
} finally { await rm(directory, { recursive: true, force: true }); }
