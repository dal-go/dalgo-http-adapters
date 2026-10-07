// Synthetic-only native consumer. Owner: invoking test process.
// Both ephemeral loopback servers and the owned browser close in finally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const httpRoot = process.env.HTTP_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
// Core exposes an import-only entry. Resolve as ESM from HTTP's package scope.
const coreEntry = process.env.CORE_PACKAGE_ROOT ? join(process.env.CORE_PACKAGE_ROOT, 'dist/index.js') : fileURLToPath(import.meta.resolve('@dalgo/core'));
const registryConsumer = !!process.env.CORE_PACKAGE_ROOT;
if (registryConsumer) assert.equal(JSON.parse(await readFile(join(process.env.CORE_PACKAGE_ROOT, 'package.json'), 'utf8')).version, '0.5.0');
else assert.ok(coreEntry.includes('4c10c34fbd0ae9d0b020015f834b893be82f4dd0'), 'HTTP must own the exact reviewed core SHA');
const yamlRoot = join(dirname(createRequire(coreEntry).resolve('yaml/package.json')), 'browser');
const assets = new Map();
for (const [prefix, root] of [['/http/', join(httpRoot, 'dist')], ['/core/', dirname(coreEntry)], ['/yaml/', yamlRoot], ['/fixture/', process.env.HTTP_FIXTURE_ROOT ?? join(httpRoot, '.browser-fixture-dist')]]) {
  const realRoot = await realpath(root);
  for (const name of await readdir(realRoot, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    const file = await realpath(join(realRoot, name));
    assert.ok(file.startsWith(realRoot + sep), 'asset escaped installed/compiled root');
    assets.set(prefix + name.split(sep).join('/'), file);
  }
}
const imports = { '@dal-go/dalgo2http': '/http/index.js', '@dalgo/core': '/core/index.js', yaml: '/yaml/index.js' };
const xml = `<g:Envelope xmlns:g="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time="2037-02-03"><Cube currency="AAA" rate="001.23000"/><Cube currency="ZZZ" rate="0.00001"/></Cube></Cube></g:Envelope>`;
const requests = [];
const app = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Synthetic materialized rights viewer</title><script type="importmap">${JSON.stringify({ imports })}</script><main><h1>Synthetic fixture only</h1></main>`); return;
  }
  const asset = assets.get(req.url);
  if (!asset) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(asset)); }
  catch { res.writeHead(500).end(); }
});
let origin;
const fixture = createServer((req, res) => {
  requests.push(req.url);
  if (!['/pass.xml', '/fail.xml', '/malformed.xml'].includes(req.url)) { res.writeHead(404).end(); return; }
  if (req.url !== '/fail.xml') res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Content-Type', 'text/xml'); res.end(req.url === '/malformed.xml' ? '<bad' : xml);
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
let browser;
try {
  await listen(app); origin = `http://127.0.0.1:${app.address().port}`;
  await listen(fixture); const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = [];
  await context.route('**/*', route => {
    if (![origin, fixtureOrigin].includes(new URL(route.request().url()).origin)) { blocked.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); await page.goto(origin);
  const result = await page.evaluate(async ({ fixtureOrigin }) => {
    const { Key, UnsupportedError, collection, executeSourceComposedJoinedDTQLQuery } = await import('@dalgo/core');
    const { ECB_DAILY_URL, decodeECBDaily } = await import('@dal-go/dalgo2http');
    const { ImmutableDescriptors, descriptors, joinedQuery, joinOptions, materialize, syntheticExecutor, syntheticXML, syntheticPlan, unsupportedSink, viewSnapshot } = await import('/fixture/browser-fixture.js');
    let calls = 0;
    // Trusted test-only exact URL rewrite. Native Fetch performs native CORS.
    // Substituted Response.url is synthetic identity, never a real ECB receipt.
    const injected = path => async (input, init) => {
      if (input !== ECB_DAILY_URL || init.method !== 'GET' || init.mode !== 'cors' || init.credentials !== 'omit' || init.cache !== 'no-store' || init.redirect !== 'error') throw Error('unexpected request');
      calls++;
      const response = await fetch(fixtureOrigin + path, init);
      Object.defineProperty(response, 'url', { value: ECB_DAILY_URL }); return response;
    };
    const refusal = async (operation, expected = Error) => {
      try { await operation(); } catch (error) { if (error instanceof expected) return true; throw error; }
      throw Error('expected refusal');
    };
    const { executor, plan } = await syntheticExecutor({ fetch: injected('/pass.xml') });
    const cases = [];
    for (const [name, rows, query] of [['normal', descriptors, joinedQuery()], ['projected', descriptors, joinedQuery('inner', true)], ['empty-local', [], joinedQuery()], ['where-empty', descriptors, joinedQuery('inner', false, true)], ['left', descriptors, joinedQuery('left')]]) {
      const output = await materialize(executor, plan, rows, query);
      const view = viewSnapshot(output);
      if (!output.records.every(record => record.key instanceof Key)) throw Error('duplicate core identity');
      const element = document.createElement('pre'); element.dataset.case = name;
      element.textContent = JSON.stringify(view, null, 2); document.querySelector('main').append(element);
      const inputs = view.metadata.sourceComposition.inputs;
      cases.push({ name, rows: view.rows, notices: view.notices, evidence: inputs[0].metadata.providerReads.reads[0], bindings: inputs[0].metadata.providerReads.bindings });
    }
    const direct = await executor.query(collection('daily').query().where('currency', '==', 'BBB').build());
    const directEmptyEvidence = direct.records.length === 0 && direct.providerReads.reads.length === 1;
    const cors = await syntheticExecutor({ fetch: injected('/fail.xml') });
    const corsFailure = await refusal(() => materialize(cors.executor, cors.plan), TypeError);
    const malformed = await syntheticExecutor({ fetch: injected('/malformed.xml') });
    const malformedFailure = await refusal(() => materialize(malformed.executor, malformed.plan));
    const parserRefusals = [];
    for (const text of ['<bad', '<!DOCTYPE x>' + syntheticXML, syntheticXML.replace('http://www.ecb.int/vocabulary/2002-08-01/eurofxref', 'urn:bad')]) parserRefusals.push(await refusal(() => decodeECBDaily(new TextEncoder().encode(text))));
    const options = joinOptions(executor, plan, new ImmutableDescriptors(descriptors));
    const resolve = options.resolveInput;
    const before = calls;
    const invalidLater = await refusal(() => executeSourceComposedJoinedDTQLQuery(joinedQuery(), { ...options, resolveInput: (relation, path) => {
      const input = resolve(relation, path); return relation.name === 'descriptors' ? { ...input, scanQuery: { ...input.scanQuery, limit: 2 } } : input;
    } }));
    if (calls !== before) throw Error('preflight performed I/O');
    const badPlan = await syntheticPlan(); badPlan.sourceRights[0].declaration.text = 'changed';
    const mismatch = await refusal(() => materialize(executor, badPlan));
    if (calls !== before) throw Error('rights mismatch performed I/O');
    const mutable = await syntheticPlan(); const pending = materialize(executor, mutable);
    mutable.sourceRights[0].declaration.text = 'changed after capture';
    const mutation = viewSnapshot(await pending).notices[0].declarations[0] === 'Fabricated permission\n preserve whitespace';
    let recordsRead = false;
    const broken = changed => ({ query: async query => {
      const original = await executor.query(query);
      const providerReads = structuredClone(original.providerReads);
      providerReads.reads[0].sha256 = 'f'.repeat(64);
      return { sourceRights: original.sourceRights, usedSourceIds: original.usedSourceIds,
        ...(changed ? { providerReads } : {}), get records() { recordsRead = true; throw Error('records must not be read'); } };
    } });
    const missingEvidence = await refusal(() => materialize(broken(false), plan));
    const changedEvidence = await refusal(() => materialize(broken(true), plan));
    if (recordsRead) throw Error('evidence failure read rows');
    const bounds = [];
    for (const override of [{ maxFetchedRows: 1 }, { maxMetadataBytes: 1 }, { maxRetainedBytes: 1 }, { maxResultRows: 1 }]) bounds.push(await refusal(() => executeSourceComposedJoinedDTQLQuery(joinedQuery('left'), { ...options, ...override })));
    let dispatched = false, rawRowsRead = false;
    const sinks = [];
    const composed = viewSnapshot(await materialize(executor, plan)).metadata.sourceComposition;
    for (const sourceComposition of [null, undefined, {}, { format: 'bogus' }, composed]) {
      const raw = { sourceComposition, get records() { rawRowsRead = true; throw Error('rows'); } };
      sinks.push(await refusal(() => unsupportedSink(raw, () => { dispatched = true; }), UnsupportedError));
    }
    if (dispatched || rawRowsRead) throw Error('unsupported sink reached rows/dispatch');
    return { cases, directEmptyEvidence, corsFailure, malformedFailure, parserRefusals, invalidLater, mismatch, mutation, missingEvidence, changedEvidence, bounds, sinks, calls, viewerCases: [...document.querySelectorAll('pre')].map(element => element.dataset.case) };
  }, { fixtureOrigin });
  const byName = Object.fromEntries(result.cases.map(value => [value.name, value]));
  assert.deepEqual(byName.normal.rows, [{ currency: 'AAA', time: '2037-02-03', rate: '001.23000', name: 'Invented Alpha' }]);
  assert.deepEqual(byName.projected.rows, [{ name: 'Invented Alpha' }]);
  assert.deepEqual(byName['empty-local'].rows, []); assert.deepEqual(byName['where-empty'].rows, []);
  assert.deepEqual(byName.left.rows, [...byName.normal.rows, { currency: 'ZZZ', time: '2037-02-03', rate: '0.00001', name: null }]);
  for (const value of result.cases) {
    assert.deepEqual(value.notices.map(notice => notice.rightsStatus), ['provided', 'unknown']);
    assert.equal(value.notices[0].scope.proof, 'ecb-full-decoded-feed'); assert.equal(value.notices[0].scope.requestedLimit, 256);
    assert.equal(value.notices[1].scope.proof, 'immutable-local-array');
    assert.equal(value.notices[0].declarations[0], 'Fabricated permission\n preserve whitespace');
    assert.equal(value.notices[0].attributions[0], 'Synthetic fixture credit');
    assert.equal(value.evidence.bytes, new TextEncoder().encode(xml).length); assert.equal(value.evidence.referenceDate, '2037-02-03');
    assert.equal(value.evidence.status, 200); assert.match(value.evidence.sha256, /^[a-f0-9]{64}$/); assert.match(value.evidence.observationId, /^[a-f0-9]{64}$/);
    assert.equal(value.bindings.length, 1);
  }
  for (const flag of ['directEmptyEvidence', 'corsFailure', 'malformedFailure', 'invalidLater', 'mismatch', 'mutation', 'missingEvidence', 'changedEvidence']) assert.equal(result[flag], true, flag);
  for (const flags of [result.parserRefusals, result.bounds, result.sinks]) assert.ok(flags.every(Boolean));
  assert.deepEqual(result.viewerCases, ['normal', 'projected', 'empty-local', 'where-empty', 'left']); assert.deepEqual(blocked, []);
  assert.deepEqual(requests, [...Array(6).fill('/pass.xml'), '/fail.xml', '/malformed.xml', ...Array(6).fill('/pass.xml')]); assert.equal(result.calls, requests.length);
  console.log(JSON.stringify({ synthetic: true, browser: browser.version(), core: registryConsumer ? 'registry:0.5.0' : 'git:4c10c34fbd0ae9d0b020015f834b893be82f4dd0', cases: result.cases.map(value => ({ name: value.name, rowCount: value.rows.length, rights: value.notices.map(notice => notice.rightsStatus), evidenceReads: 1 })), refusals: { cors: result.corsFailure, malformed: result.malformedFailure, invalidLater: result.invalidLater, mismatch: result.mismatch, missingEvidence: result.missingEvidence, changedEvidence: result.changedEvidence, bounds: result.bounds.length, unsupportedSinks: result.sinks.length }, fixtureRequests: requests, blockedExternalRequests: blocked, providerRequests: 0 }));
} finally {
  await browser?.close();
  if (fixture.listening) await close(fixture);
  if (app.listening) await close(app);
}
