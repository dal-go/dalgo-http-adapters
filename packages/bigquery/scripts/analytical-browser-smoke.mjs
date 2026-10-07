// Standalone synthetic acceptance for the built public analytical entry.
// The invoking process owns Chrome and both loopback listeners; finally closes all three.
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

assert.equal(process.versions.node.split('.')[0], '24', 'Use the reviewed Node24 browser runtime');
assert.ok(process.env.PLAYWRIGHT_MODULE && isAbsolute(process.env.PLAYWRIGHT_MODULE), 'Explicit installed PLAYWRIGHT_MODULE is required');
assert.ok(process.env.CHROME_PATH && isAbsolute(process.env.CHROME_PATH), 'Explicit owned CHROME_PATH is required');
await access(process.env.PLAYWRIGHT_MODULE, constants.R_OK);
await access(process.env.CHROME_PATH, constants.X_OK);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(import.meta.resolve('@dalgo/bigquery/analytical'));
assert.equal(entry, join(root, 'dist', 'analytical.js'), 'Use this package built public export');
const dist = await realpath(dirname(entry));
const assets = new Map();
for (const name of await readdir(dist, { recursive: true })) {
  if (!name.endsWith('.js')) continue;
  const file = await realpath(join(dist, name));
  assert.ok(file.startsWith(dist + sep), 'asset escaped built package');
  assets.set('/bigquery/' + name.split(sep).join('/'), file);
}

const cases = ['success', 'cors-refused'];
const physical = [];
const violations = [];
let appOrigin, fixtureOrigin, browser;
const fail = (res, reason) => { violations.push(reason); res.writeHead(400).end(); };
const app = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { fail(res, 'app method'); return; }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; connect-src ${fixtureOrigin}; base-uri 'none'; form-action 'none'`);
    res.end('<!doctype html><title>Synthetic BigQuery analytical acceptance</title>');
    return;
  }
  const asset = assets.get(req.url);
  if (!asset) { fail(res, 'app path'); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(asset)); }
  catch { fail(res, 'asset read'); }
});
const fixture = createServer(async (req, res) => {
  const match = /^\/cases\/(success|cors-refused)\/(discovery|userinfo|dataset|table|query)$/u.exec(req.url);
  if (!match) { fail(res, 'fixture path'); return; }
  const [, name, endpoint] = match;
  const requestRecord = { name, endpoint, method: req.method };
  physical.push(requestRecord); // No headers, token, SQL or body retained.
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin !== appOrigin || req.headers.cookie !== undefined) { fail(res, 'origin or credentials'); return; }
  if (req.method === 'OPTIONS') {
    const expectedMethod = endpoint === 'query' ? 'POST' : 'GET';
    const expectedHeaders = endpoint === 'query' ? 'authorization,content-type' : 'authorization';
    if (endpoint === 'discovery' || req.headers.authorization !== undefined || req.headers['access-control-request-method'] !== expectedMethod || req.headers['access-control-request-headers'] !== expectedHeaders) {
      fail(res, 'preflight'); return;
    }
    if (!(name === 'cors-refused' && endpoint === 'query')) {
      res.setHeader('Access-Control-Allow-Origin', appOrigin);
      res.setHeader('Access-Control-Allow-Methods', expectedMethod);
      res.setHeader('Access-Control-Allow-Headers', expectedHeaders);
      res.setHeader('Access-Control-Max-Age', '0');
    }
    res.writeHead(204).end(); return;
  }
  const expectedMethod = endpoint === 'query' ? 'POST' : 'GET';
  const expectedAuth = endpoint === 'discovery' ? undefined : 'Bearer synthetic-short-lived-token';
  if (req.method !== expectedMethod || req.headers.authorization !== expectedAuth ||
      (endpoint === 'query' && !req.headers['content-type']?.startsWith('application/json'))) {
    fail(res, 'request authorization or method'); return;
  }
  res.setHeader('Access-Control-Allow-Origin', appOrigin);
  res.setHeader('Content-Type', 'application/json');
  if (endpoint === 'discovery') {
    res.end(JSON.stringify({ issuer: 'https://accounts.google.com', userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo' })); return;
  }
  if (endpoint === 'userinfo') { res.end(JSON.stringify({ sub: 'synthetic-google-subject' })); return; }
  if (endpoint === 'dataset') { res.end(JSON.stringify({ datasetReference: { projectId: 'source-project', datasetId: 'ds' }, location: 'EU' })); return; }
  if (endpoint === 'table') {
    res.end(JSON.stringify({ tableReference: { projectId: 'source-project', datasetId: 'ds', tableId: 'tbl' }, type: 'TABLE', schema: { fields: [{ name: 'n', type: 'INTEGER', mode: 'NULLABLE' }] } })); return;
  }
  // Inspect the synthetic request transiently; a physical Google endpoint is never reachable.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requestRecord.dryRun = body.dryRun;
  if (body.maximumBytesBilled !== '1000' || body.location !== 'EU' || body.useLegacySql !== false ||
      body.jobCreationMode !== 'JOB_CREATION_REQUIRED' || typeof body.query !== 'string' ||
      !body.query.includes('`source-project.ds.tbl`') || typeof body.dryRun !== 'boolean') {
    fail(res, 'query cap, source or mode'); return;
  }
  if (body.dryRun) { res.end(JSON.stringify({ totalBytesProcessed: '100' })); return; }
  res.end(JSON.stringify({ jobReference: { projectId: 'job-project', jobId: 'synthetic-job', location: 'EU' },
    jobComplete: true, schema: { fields: [{ name: 'n', type: 'INTEGER', mode: 'NULLABLE' }] },
    rows: [{ f: [{ v: '42' }] }] }));
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
try {
  await listen(app); appOrigin = `http://127.0.0.1:${app.address().port}`;
  await listen(fixture); fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const receipts = [];
  for (const name of cases) {
    const start = physical.length;
    const unrelated = [];
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === appOrigin && (url.pathname === '/' || assets.has(url.pathname)) && !url.search) return;
        if (url.origin === fixtureOrigin && /^\/cases\/(success|cors-refused)\/(discovery|userinfo|dataset|table|query)$/u.test(url.pathname) && !url.search) return;
        unrelated.push('unexpected browser request');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(appOrigin);
      let timer;
      const result = await Promise.race([page.evaluate(async ({ name, fixtureOrigin }) => {
        const { BigQueryAnalyticalClient, GoogleTokenIdentityProvider, IndexedDBLedger, googleAuthorizationScopes } = await import('/bigquery/analytical.js');
        const check = (condition, message) => { if (!condition) throw Error(message); };
        const source = { version: 1, sourceId: 'synthetic', descriptorDigest: 'synthetic', logicalCollection: 'sample',
          sourceProject: 'source-project', datasetId: 'ds', tableId: 'tbl', location: 'EU',
          schema: [{ name: 'n', type: 'INTEGER', mode: 'NULLABLE' }], publisherReviewRef: 'synthetic', rightsReviewRef: 'synthetic', use: 'connection-test' };
        const query = { from: 'sample', projection: ['n'], where: null, order: [], limit: 1 };
        const fixed = new Map([
          ['https://accounts.google.com/.well-known/openid-configuration', 'discovery'],
          ['https://openidconnect.googleapis.com/v1/userinfo', 'userinfo'],
          ['https://bigquery.googleapis.com/bigquery/v2/projects/source-project/datasets/ds', 'dataset'],
          ['https://bigquery.googleapis.com/bigquery/v2/projects/source-project/datasets/ds/tables/tbl', 'table'],
          ['https://bigquery.googleapis.com/bigquery/v2/projects/job-project/queries', 'query'],
        ]);
        const transport = (url, init) => {
          const endpoint = fixed.get(url);
          check(endpoint !== undefined && init?.redirect === 'error' && init.credentials === 'omit' && init.cache === 'no-store', 'unexpected logical URL or fetch policy');
          check(init.method === (endpoint === 'query' ? 'POST' : 'GET'), 'unexpected logical method');
          return globalThis.fetch(`${fixtureOrigin}/cases/${name}/${endpoint}`, init);
        };
        const provider = new GoogleTokenIdentityProvider({ fetch: transport });
        const identity = await provider.connect({ access_token: 'synthetic-short-lived-token', token_type: 'Bearer', expires_in: 3600, scope: googleAuthorizationScopes() });
        check(identity.principal.kind === 'google-user' && identity.principal.subject === 'synthetic-google-subject' && identity.email === undefined, 'wrong verified identity');
        const ledger = new IndexedDBLedger(`synthetic-browser-${name}`);
        const client = await BigQueryAnalyticalClient.create({ profiles: [source], prepare: async () => ({ source, query, policyDigest: 'synthetic-policy' }), provider, ledger, fetch: transport });
        const execution = { jobProject: 'job-project', principal: identity.principal, maximumBytesBilled: '1000', sessionBudgetBytes: '3000' };
        if (name === 'cors-refused') {
          try { await client.preview(execution); throw Error('CORS refusal unexpectedly succeeded'); }
          catch (error) { check(error.code === 'submission_unknown', `wrong CORS refusal: ${error.code}`); }
          const state = await ledger.update(value => value);
          check(Object.keys(state.previews).length === 0 && Object.keys(state.runs).length === 0, 'CORS refusal created approval or run');
          return { code: 'submission_unknown' };
        }
        const preview = await client.preview(execution, { pageSize: 1 });
        check(preview.estimatedBytes === '100' && preview.execution.jobProject !== source.sourceProject, 'wrong source, estimate or project');
        const approval = await client.approve(preview, preview.approvalDigest);
        const run = await client.execute(approval);
        const first = await run.nextPage();
        check(first?.rows.length === 1 && first.rows[0][0].value === '42', 'wrong native result');
        check(first.receipt.job?.jobId === 'synthetic-job' && first.receipt.counters.rows === 1, 'wrong same-job receipt');
        check(await run.nextPage() === null, 'unexpected extra page');
        const state = await ledger.update(value => value);
        check(!JSON.stringify(state).includes('"v":"42"'), 'result cell persisted in ledger');
        return { code: 'success', rows: first.rows.length, job: first.receipt.job.jobId };
      }, { name, fixtureOrigin }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('native case deadline')), 20000); })]).finally(() => clearTimeout(timer));
      assert.deepEqual(unrelated, []);
      const trace = physical.slice(start);
      const count = (endpoint, method) => trace.filter(item => item.endpoint === endpoint && item.method === method).length;
      assert.equal(count('discovery', 'GET'), 1);
      assert.equal(count('userinfo', 'GET'), 1);
      assert.equal(count('dataset', 'GET'), name === 'success' ? 3 : 1);
      assert.equal(count('table', 'GET'), name === 'success' ? 3 : 1);
      assert.equal(count('query', 'POST'), name === 'success' ? 3 : 0);
      assert.equal(trace.filter(item => item.endpoint === 'query' && item.method === 'POST' && item.dryRun === true).length,
        name === 'success' ? 2 : 0, 'dry-run count');
      assert.equal(trace.filter(item => item.endpoint === 'query' && item.method === 'POST' && item.dryRun === false).length,
        name === 'success' ? 1 : 0, 'capped submit count');
      assert.ok(count('query', 'OPTIONS') >= 1, 'native POST CORS preflight absent');
      assert.ok(count('dataset', 'OPTIONS') >= 1, 'native authorized GET CORS preflight absent');
      assert.equal(result.code, name === 'success' ? 'success' : 'submission_unknown');
      receipts.push({ name, result: result.code, identityGETs: 2, metadataGETs: count('dataset', 'GET') + count('table', 'GET'),
        dryRunAndSubmitPOSTs: count('query', 'POST'), corsPreflights: trace.filter(item => item.method === 'OPTIONS').length,
        ...(result.rows === undefined ? {} : { rows: result.rows, job: result.job }) });
    } finally { await context.close(); }
  }
  assert.deepEqual(violations, []);
  process.stdout.write(JSON.stringify({ synthetic: true, nativeBrowser: browser.version(), publicEntry: '@dalgo/bigquery/analytical',
    sourceProject: 'source-project', jobProject: 'job-project', cases: receipts, googleRequests: 0, credentials: 'synthetic-only' }) + '\n');
} finally {
  try { await browser?.close(); }
  finally { try { if (fixture.listening) await close(fixture); } finally { if (app.listening) await close(app); } }
}
