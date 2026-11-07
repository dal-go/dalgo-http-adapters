// Synthetic-only diagnostic. Coordinator runs inside the single capped slot.
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeConfiguration } from '../dist/node.js';
const directory = await mkdtemp(join(tmpdir(), 'dalgo-duckdb-diagnostic-'));
const databasePath = join(directory, 'fixture.duckdb');
const parquetPath = join(directory, 'fixture.parquet');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const redact = error => String(error instanceof Error ? error.message : 'unknown').replaceAll(directory, '<synthetic-fixture>').slice(0, 1200);
const report = (test, stage, ok, detail) => console.log(JSON.stringify({ test, stage, ok, ...(detail === undefined ? {} : { detail }) }));
try {
  const seed = await DuckDBInstance.create(databasePath);
  const seedConnection = await seed.connect();
  try {
    await seedConnection.run('CREATE TABLE fixture AS SELECT 9007199254740993::BIGINT AS exact');
    await seedConnection.run(`COPY fixture TO ${literal(parquetPath)} (FORMAT PARQUET)`);
  } finally { seedConnection.closeSync(); seed.closeSync(); }
  const original = nodeConfiguration({ databasePath, parquetPaths: [parquetPath] });
  const cases = [
    { name: 'original-fixed-configuration', config: { ...original }, setup: [] },
    { name: 'configuration-with-database-read-grant', config: { ...original, allowed_paths: `[${literal(databasePath)},${literal(parquetPath)}]` }, setup: [] },
    { name: 'trusted-setup-then-disable-external-access', config: { access_mode: 'READ_ONLY', threads: '1', memory_limit: '128MiB', max_temp_directory_size: '0B', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' }, setup: [`SET allowed_paths = [${literal(parquetPath)}]`, 'LOAD parquet', 'SET enable_external_access = false'] },
  ];
  for (const test of cases) {
    let instance;
    let connection;
    let stage = 'create';
    try {
      instance = await DuckDBInstance.create(databasePath, test.config);
      report(test.name, stage, true);
      stage = 'connect'; connection = await instance.connect(); report(test.name, stage, true);
      for (let i = 0; i < test.setup.length; i++) { stage = `trusted-setup-${String(i)}`; await connection.run(test.setup[i]); report(test.name, stage, true); }
      stage = 'load-parquet'; await connection.run('LOAD parquet'); report(test.name, stage, true);
      stage = 'lock-configuration'; await connection.run('SET lock_configuration = true'); report(test.name, stage, true);
      stage = 'read-only-transaction'; await connection.run('BEGIN TRANSACTION READ ONLY'); report(test.name, stage, true);
      stage = 'bounded-read'; const result = await connection.stream('SELECT * FROM (SELECT exact FROM fixture) AS dalgo_bounded_result LIMIT 2');
      report(test.name, 'metadata', true, { names: result.columnNames(), types: result.columnTypes().map(type => type.toString()) });
      for await (const chunk of result) report(test.name, 'chunk', true, chunk.getRows().map(row => row.map(value => typeof value === 'bigint' ? String(value) : value)));
      report(test.name, stage, true);
      stage = 'parquet-read'; const parquet = await connection.stream(`SELECT * FROM (SELECT exact FROM read_parquet(${literal(parquetPath)})) AS dalgo_bounded_result LIMIT 2`);
      for await (const chunk of parquet) report(test.name, 'parquet-chunk', true, chunk.getRows().map(row => row.map(value => typeof value === 'bigint' ? String(value) : value)));
      report(test.name, stage, true);
    } catch (error) { report(test.name, stage, false, redact(error)); }
    finally {
      try { connection?.closeSync(); } catch { report(test.name, 'connection-close', false); }
      try { instance?.closeSync(); } catch { report(test.name, 'instance-close', false); }
    }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
