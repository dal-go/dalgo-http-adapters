// Coordinator-owned capped Linux/Chromium slot only. No application/UI source.
// Harness supplies pinned Playwright and esbuild; engines remain package peers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
const require = createRequire(import.meta.url);
const playwrightPath = process.env.DALGO_PLAYWRIGHT_DIR ? resolve(process.env.DALGO_PLAYWRIGHT_DIR, 'node_modules/playwright') : 'playwright';
const { chromium } = require(playwrightPath);
const playwrightPackage = require(playwrightPath + '/package.json');
assert.equal(playwrightPackage.version, '1.64.1');
const artifact = JSON.parse(await readFile(new URL('../test/fixtures/wasm-artifact.json', import.meta.url), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'dalgo-duckdb-browser-'));
let server;
let browser;
const requests = [];
try {
  const parquet = join(temporary, 'fixture.parquet');
  const seed = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '64MiB', max_temp_directory_size: '0B' });
  const conn = await seed.connect();
  try {
    await conn.run(`COPY (SELECT i::INTEGER AS id, (9007199254740993 + i)::BIGINT AS exact, 12.0034::DECIMAL(12,4) AS amount, CASE WHEN i = 2 THEN NULL ELSE i = 1 END AS flag, (-1 - i)::TINYINT AS negative FROM range(3) t(i)) TO '${parquet.replaceAll("'", "''")}' (FORMAT PARQUET)`);
  } finally { conn.closeSync(); seed.closeSync(); }
  const site = join(temporary, 'site'); await mkdir(site);
  const rootSource = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const browserSource = fileURLToPath(new URL('../src/browser.ts', import.meta.url));
  const rootEntry = join(temporary, 'root-entry.mjs');
  const selectedEntry = join(temporary, 'selected-entry.mjs');
  await writeFile(rootEntry, `import * as root from ${JSON.stringify(rootSource)}; globalThis.duckRootReady = Object.keys(root);`);
  await writeFile(selectedEntry, `
import { BrowserDuckDBDatabase } from ${JSON.stringify(browserSource)};
export async function runFixture() {
  const wasm = await import('@duckdb/duckdb-wasm');
  const versions = new Set();
  const stages = [];
  globalThis.duckFixtureStages = stages;
  const originalOpen = wasm.AsyncDuckDB.prototype.open;
  const originalQuery = wasm.AsyncDuckDBConnection.prototype.query;
  const diagnosticSend = wasm.AsyncDuckDBConnection.prototype.send;
  wasm.AsyncDuckDB.prototype.open = async function (...args) {
    const value = await originalOpen.apply(this, args);
    const version = await this.getVersion();
    versions.add(version);
    stages.push({ stage: 'engine-opened', version });
    return value;
  };
  wasm.AsyncDuckDBConnection.prototype.query = async function (sql, ...args) {
    const trustedSetup = /^(SET |LOAD parquet$|BEGIN TRANSACTION READ ONLY)/.test(sql);
    try {
      const value = await originalQuery.call(this, sql, ...args);
      if (sql === 'LOAD parquet') stages.push({ stage: 'signed-parquet-loaded', passed: true });
      return value;
    }
    catch (error) {
      if (trustedSetup) stages.push({ stage: 'trusted-setup', sql, message: String(error.message).slice(0, 500) });
      throw error;
    }
  };
  // These are only the fixed synthetic fixture statements. Capture the SDK
  // failure before the production adapter deliberately redacts its details.
  wasm.AsyncDuckDBConnection.prototype.send = async function (sql, ...args) {
    stages.push({ stage: 'synthetic-query-submitted', sql });
    try {
      const reader = await diagnosticSend.call(this, sql, ...args);
      // Leave the reader unopened: actual adapter code must await its schema.
      stages.push({ stage: 'synthetic-stream-created' });
      const openReader = reader.open.bind(reader);
      reader.open = async function (...options) {
        const opened = await openReader(...options);
        if (sql.includes('current_setting') || sql.includes('boolean_probe_true') || sql.includes('flag, negative')) {
          stages.push({ stage: 'synthetic-scalar-metadata', sql, fields: reader.schema.fields.slice(0, 12).map(field => ({ name: field.name, type: field.type.toString(), typeId: field.type.typeId, bitWidth: field.type.bitWidth, metadata: [...field.metadata].slice(0, 8) })) });
        }
        return opened;
      };
      return reader;
    } catch (error) {
      stages.push({ stage: 'synthetic-query-error', sql, message: String(error.message).slice(0, 1000) });
      throw error;
    }
  };
  const bytes = new Uint8Array(await (await fetch('/fixture.parquet')).arrayBuffer());
  const options = { bundle: { mainModule: '/duckdb/duckdb-mvp.wasm', mainWorker: '/duckdb/duckdb-browser-mvp.worker.js' }, parquetFiles: { 'fixture.parquet': bytes }, parquetExtensionRepository: '/extensions' };
  const constructorRefusals = [];
  for (const bad of [{ ...options, bundle: { ...options.bundle, mainModule: 'https://example.invalid/engine.wasm' } }, { ...options, parquetFiles: { '../escape.parquet': bytes } }, { ...options, maxFileBytes: 1 }, { ...options, memoryLimitMiB: 513 }, { ...options, parquetExtensionRepository: 'https://example.invalid/extensions' }, { ...options, parquetExtensionRepository: undefined }]) {
    try { new BrowserDuckDBDatabase(bad); constructorRefusals.push(false); } catch { constructorRefusals.push(true); }
  }
  const db = new BrowserDuckDBDatabase(options);
  const sql = "SELECT id, exact, amount FROM read_parquet('fixture.parquet') ORDER BY id";
  const policy = await db.queryOrdinal({ kind: 'native', sql: "SELECT current_setting('enable_external_access'), current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions'), current_setting('allow_unsigned_extensions'), current_setting('allow_community_extensions'), current_setting('lock_configuration')" });
  const booleanProbe = await db.queryOrdinal({ kind: 'native', sql: "SELECT TRUE AS boolean_probe_true, FALSE AS boolean_probe_false, NULL::BOOLEAN AS boolean_probe_null, -1::TINYINT AS integer_minus_one, -2::TINYINT AS integer_minus_two, CAST(current_setting('enable_external_access') AS INTEGER) AS external_integer, CAST(current_setting('lock_configuration') AS INTEGER) AS locked_integer, CAST(current_setting('enable_external_access') AS VARCHAR) AS external_text, CAST(current_setting('lock_configuration') AS VARCHAR) AS locked_text" });
  const data = await db.queryOrdinal({ kind: 'native', sql });
  const parquetBooleanCasts = await db.queryOrdinal({ kind: 'native', sql: "SELECT CAST(flag AS INTEGER) AS flag_integer, CAST(flag AS VARCHAR) AS flag_text, negative FROM read_parquet('fixture.parquet') ORDER BY id" });
  stages.push({ stage: 'synthetic-parquet-boolean-casts', result: parquetBooleanCasts });
  const parquetBooleans = await db.queryOrdinal({ kind: 'native', sql: "SELECT flag, negative FROM read_parquet('fixture.parquet') ORDER BY id" });
  const page = await db.queryOrdinal({ kind: 'native', sql: sql + ' LIMIT 1 OFFSET 1' });
  async function refusal(query, database = db) {
    try { await database.queryOrdinal({ kind: 'native', sql: query }); return { refused: false }; }
    catch (error) { return { refused: true, code: error.code, message: error.message }; }
  }
  const overLimit = await refusal(sql, new BrowserDuckDBDatabase({ ...options, maxRows: 1 }));
  const deniedFile = await refusal("SELECT * FROM read_parquet('missing.parquet')");
  const deniedURL = await refusal("SELECT * FROM read_csv('" + location.origin + "/forbidden.csv')");
  const deniedWrite = await refusal("DELETE FROM fixture");
  const deniedMultiple = await refusal("SELECT 1; SELECT 2");
  const deniedNested = await refusal("SELECT [1, 2] AS nested");
  const deniedUnsignedHuge = await refusal("SELECT '340282366920938463463374607431768211455'::UHUGEINT AS unsigned_huge");
  // Intercept only the fixture's pending-query dispatch to prove abort occurs
  // after actual engine query submission, rather than during WASM initialization.
  const originalSend = wasm.AsyncDuckDBConnection.prototype.send;
  const controller = new AbortController();
  let submitted = false;
  wasm.AsyncDuckDBConnection.prototype.send = function (text, stream) {
    const pending = originalSend.call(this, text, stream);
    if (text.includes('range(1000000000000)')) { submitted = true; queueMicrotask(() => controller.abort('synthetic-secret-reason')); }
    return pending;
  };
  let cancelled;
  try {
    await db.queryOrdinal({ kind: 'native', sql: 'SELECT sum(i) FROM range(1000000000000) t(i)' }, controller.signal);
    cancelled = { rejected: false };
  } catch (error) { cancelled = { rejected: true, reason: error.reason, message: error.message }; }
  finally { wasm.AsyncDuckDBConnection.prototype.send = originalSend; }
  const reopened = await db.queryOrdinal({ kind: 'native', sql: "SELECT count(*) AS n FROM read_parquet('fixture.parquet')" });
  wasm.AsyncDuckDB.prototype.open = originalOpen;
  wasm.AsyncDuckDBConnection.prototype.query = originalQuery;
  wasm.AsyncDuckDBConnection.prototype.send = diagnosticSend;
  return { policy, booleanProbe, parquetBooleanCasts, parquetBooleans, data, page, overLimit, deniedFile, deniedURL, deniedWrite, deniedMultiple, deniedNested, deniedUnsignedHuge, submitted, cancelled, reopened, constructorRefusals, versions: [...versions], stages };
}
`);
  // Resolve test-only dependencies from the package rather than /tmp.
  const wasmEntry = require.resolve('@duckdb/duckdb-wasm');
  const wasmDist = dirname(wasmEntry);
  const wasmPackage = JSON.parse(await readFile(join(wasmDist, '..', 'package.json'), 'utf8'));
  assert.equal(wasmPackage.version, artifact.version);
  let npmLockVerified = false;
  if (process.env.DUCKDB_NPM_LOCKFILE) {
    const lock = JSON.parse(await readFile(process.env.DUCKDB_NPM_LOCKFILE, 'utf8'));
    const pinned = lock.packages?.['node_modules/@duckdb/duckdb-wasm'];
    assert.equal(pinned?.version, artifact.version);
    assert.equal(pinned?.integrity, artifact.npmIntegrity);
    npmLockVerified = true;
  }
  const assetHashes = {};
  for (const field of ['engine', 'worker', 'browserModule']) {
    const specification = artifact[field];
    const data = await readFile(join(wasmDist, specification.file));
    const digest = createHash('sha256').update(data).digest('hex');
    assert.equal(digest, specification.sha256, 'pinned ' + field + ' digest');
    if (specification.bytes !== undefined) assert.equal(data.byteLength, specification.bytes);
    assetHashes[field] = digest;
  }
  assert.ok(process.env.DUCKDB_PARQUET_EXTENSION, 'stage the exact pinned signed Parquet extension offline');
  const extensionPath = resolve(process.env.DUCKDB_PARQUET_EXTENSION);
  const extension = await readFile(extensionPath);
  assert.ok(extension.byteLength > 8 && extension.byteLength <= 33_554_432);
  assert.equal(extension.subarray(0, 4).toString('hex'), '0061736d');
  assert.equal(extension.byteLength, artifact.parquetExtension.bytes);
  assetHashes.parquetExtension = createHash('sha256').update(extension).digest('hex');
  assert.equal(assetHashes.parquetExtension, artifact.parquetExtension.sha256);
  const compilation = await build({ entryPoints: { root: rootEntry, selected: selectedEntry }, outdir: site, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', metafile: true, nodePaths: [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'), resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules')] });
  for (const input of Object.keys(compilation.metafile.inputs)) assert.doesNotMatch(input, /@duckdb[\\/](?:node-api|node-bindings)/u);
  const rootOutputs = new Set();
  function visitRootOutput(path) {
    if (rootOutputs.has(path)) return;
    rootOutputs.add(path);
    const output = compilation.metafile.outputs[path];
    assert.ok(output, 'root dependency is an actual bundle output');
    for (const input of Object.keys(output.inputs)) assert.doesNotMatch(input, /@duckdb[\\/]/u, 'root import must be engine-free');
    for (const dependency of output.imports) if (!dependency.external && dependency.kind !== 'dynamic-import') visitRootOutput(dependency.path);
  }
  const rootOutput = Object.entries(compilation.metafile.outputs).find(([, output]) => output.entryPoint !== undefined && resolve(output.entryPoint) === rootEntry)?.[0];
  assert.ok(rootOutput); visitRootOutput(rootOutput);
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8"><title>DuckDB SDK fixture</title><script type="module" src="/root.js"></script>');
  const assets = new Map([
    ['/fixture.parquet', parquet],
    ['/duckdb/duckdb-mvp.wasm', join(wasmDist, 'duckdb-mvp.wasm')],
    ['/duckdb/duckdb-browser-mvp.worker.js', join(wasmDist, 'duckdb-browser-mvp.worker.js')],
    ['/extensions/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm', extensionPath],
    ['/extensions/duckdb-wasm/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm', extensionPath],
  ]);
  server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push(path);
      const file = assets.get(path) ?? (path === '/' ? join(site, 'index.html') : resolve(site, '.' + decodeURIComponent(path)));
      if (!assets.has(path) && !file.startsWith(site + sep)) { response.writeHead(403).end(); return; }
      const canonical = await realpath(file);
      if (!assets.has(path) && !canonical.startsWith(site + sep)) { response.writeHead(403).end(); return; }
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 67_108_864) { response.writeHead(413).end(); return; }
      const type = extname(file) === '.wasm' ? 'application/wasm' : extname(file) === '.js' ? 'text/javascript' : extname(file) === '.html' ? 'text/html' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-store' });
      response.end(await readFile(canonical));
    })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage(); page.setDefaultTimeout(60_000);
  const browserRequests = [];
  page.on('request', request => browserRequests.push(request.url()));
  const workers = new Set(); let workersCreated = 0;
  page.on('worker', worker => { workers.add(worker); workersCreated++; worker.on('close', () => workers.delete(worker)); });
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message.slice(0, 300)));
  await page.goto(`http://127.0.0.1:${String(address.port)}/`);
  await page.waitForFunction(() => Array.isArray(globalThis.duckRootReady));
  await page.waitForTimeout(50);
  assert.equal(requests.some(path => path.includes('/duckdb/') || path.startsWith('/extensions/') || path === '/selected.js'), false, 'root import eagerly fetched selected engine assets');
  assert.equal(workersCreated, 0, 'root import eagerly started a worker');
  let actual;
  try { actual = await page.evaluate(async () => (await import('/selected.js')).runFixture()); }
  catch (error) {
    console.error(JSON.stringify({ fixtureStageDiagnostics: await page.evaluate(() => globalThis.duckFixtureStages ?? []), browserErrors }));
    throw error;
  }
  assert.deepEqual(actual.constructorRefusals, [true, true, true, true, true, true]);
  console.log(JSON.stringify({ syntheticScalarDiagnostics: { policy: actual.policy, probe: actual.booleanProbe, metadata: actual.stages.filter(stage => stage.stage === 'synthetic-scalar-metadata') } }));
  assert.deepEqual(actual.policy.rows[0], [false, false, false, false, false, true]);
  assert.ok(actual.policy.columns.every(column => column.nativeType === 'Bool'));
  assert.deepEqual(actual.booleanProbe.rows[0], [true, false, null, -1, -2, 0, 1, 'false', 'true']);
  assert.deepEqual(actual.booleanProbe.columns.slice(0, 5).map(column => column.nativeType), ['Bool', 'Bool', 'Bool', 'Int8', 'Int8']);
  assert.deepEqual(actual.parquetBooleans.rows, [[false, -1], [true, -2], [null, -3]]);
  assert.deepEqual(actual.parquetBooleanCasts.rows, [[0, 'false', -1], [1, 'true', -2], [null, null, -3]]);
  assert.deepEqual(actual.parquetBooleans.columns.map(column => column.nativeType), ['Bool', 'Int8']);
  assert.ok(actual.stages.some(stage => stage.stage === 'signed-parquet-loaded' && stage.passed));
  assert.equal(actual.versions.length, 1);
  assert.equal(actual.versions[0], artifact.engine.coreVersion);
  assert.equal(actual.data.rows.length, 3);
  assert.deepEqual(actual.data.rows[0], [0, { kind: 'integer', value: '9007199254740993' }, { kind: 'decimal', unscaled: '120034', scale: 4 }]);
  assert.equal(actual.page.rows[0][0], 1);
  assert.deepEqual(actual.page.rows[0][1], { kind: 'integer', value: '9007199254740994' });
  assert.equal(actual.overLimit.refused, true); assert.equal(actual.overLimit.code, 'bounds');
  for (const name of ['deniedFile', 'deniedURL', 'deniedWrite', 'deniedMultiple']) assert.equal(actual[name].refused, true, name);
  for (const name of ['deniedNested', 'deniedUnsignedHuge']) {
    assert.equal(actual[name].refused, true, name);
    assert.equal(actual[name].code, 'unsupported', name);
  }
  assert.equal(requests.includes('/forbidden.csv'), false, 'user SQL escaped the registered-file boundary');
  assert.equal(actual.submitted, true); assert.equal(actual.cancelled.rejected, true); assert.equal(actual.cancelled.reason, 'caller');
  assert.doesNotMatch(actual.cancelled.message, /synthetic-secret/u);
  assert.deepEqual(actual.reopened.rows[0][0], { kind: 'integer', value: '3' });
  await page.waitForTimeout(100);
  assert.equal(workers.size, 0, 'owned WASM workers survived query/abort cleanup');
  assert.ok(requests.includes('/duckdb/duckdb-mvp.wasm'));
  assert.ok(requests.some(path => path.startsWith('/extensions/') && path.endsWith('/parquet.duckdb_extension.wasm')));
  assert.equal(browserRequests.some(url => new URL(url).origin !== `http://127.0.0.1:${String(address.port)}`), false, 'engine attempted external network access');
  assert.ok(workersCreated >= 4);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ passed: true, wasmPackage: wasmPackage.version, engineVersion: actual.versions[0], expectedNpmIntegrity: artifact.npmIntegrity, npmLockVerified, assetHashes, playwrightVersion: playwrightPackage.version, signedSameOriginParquetBootstrap: true, lockedPolicyVerified: true, canonicalBooleanFidelity: true, constructorAllowlistRefusals: true, registeredParquet: true, exactInteger: true, exactDecimal: true, nativePage: true, bounds: true, filesystemAndNetworkDenied: true, cancellationAfterDispatch: true, reopen: true, lazyRoot: true, noNodeAddonInBrowserInputs: true, workersCreated, workersRemaining: workers.size }));
} finally {
  await browser?.close();
  if (server !== undefined) await new Promise(resolveClose => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
