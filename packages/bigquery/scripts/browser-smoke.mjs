// Standalone synthetic acceptance, not a required CI browser job.
// Owner: invoking process. Teardown: owned browser.close and server.close finally.
import assert from 'node:assert/strict';
import process from 'node:process';
import { createServer } from 'node:http';
import { readFile, readdir, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { createHash } from 'node:crypto';

assert.equal(process.versions.node.split('.')[0], '24', 'Use the reviewed Node24 smoke runtime');
assert.ok(process.env.PLAYWRIGHT_MODULE && isAbsolute(process.env.PLAYWRIGHT_MODULE), 'Explicit installed PLAYWRIGHT_MODULE is required');
assert.ok(process.env.CHROME_PATH && isAbsolute(process.env.CHROME_PATH), 'Explicit owned CHROME_PATH is required');
await access(process.env.PLAYWRIGHT_MODULE, constants.R_OK); await access(process.env.CHROME_PATH, constants.X_OK);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(import.meta.resolve('@dalgo/bigquery/analytical'));
assert.equal(entry, join(root, 'dist', 'analytical.js'), 'Use this package built public export');
const goldenBytes = await readFile(join(root, 'testdata/bigquery-public-observation.json'));
assert.equal(createHash('sha256').update(goldenBytes).digest('hex'), '2dcf87f754c51b7c655a42ff73d27f0e7b0fab79e9d229db06656203d8e63117');
const golden = JSON.parse(goldenBytes.toString());
const assets = new Map([['/fixture.mjs', fileURLToPath(new URL('./browser-fixture.mjs', import.meta.url))]]);
const dist = await realpath(dirname(entry));
for (const name of await readdir(dist, { recursive: true })) {
  if (!name.endsWith('.js')) continue;
  const file = await realpath(join(dist, name)); assert.ok(file.startsWith(dist + sep), 'asset escaped built package');
  assets.set('/bigquery/' + name.split(sep).join('/'), file);
}
// Exact physical native request counts. Fresh per-case contexts prevent CORS
// preflight caches from masking Authorization/CORS acceptance.
const cases = [
  ['success-no-email', 2, 2, 3, 'success'],
  ['missing-sub', 2, 0, 1, 'auth_required'], ['blank-sub', 2, 0, 1, 'auth_required'],
  ['missing-openid', 0, 0, 0, 'scope_missing'], ['missing-read-grant', 0, 0, 0, 'scope_missing'],
  ['wrong-issuer', 1, 0, 0, 'auth_required'], ['wrong-userinfo', 1, 0, 0, 'auth_required'],
  ['denied-token', 0, 0, 0, 'auth_required'], ['denied-userinfo', 2, 0, 1, 'auth_expired'],
  ...['no-consent', 'no-owner', 'consent-before', 'disconnect-before', 'source-before', 'project-before'].map(name => [name, 2, 0, 1, 'approval_required']),
  ['rotation-before', 4, 0, 2, 'approval_required'], ['expiry-before', 2, 0, 1, 'auth_expired'], ['deadline-before', 2, 0, 1, 'local_stopped'],
  ...['owner-inflight', 'signout-inflight', 'disconnect-inflight', 'rotation-inflight'].map(name => [name, 2, 1, 2, 'auth_required']),
  ...['source-inflight', 'project-inflight', 'consent-inflight'].map(name => [name, 2, 1, 2, 'approval_required']),
  ['expiry-inflight', 2, 1, 2, 'auth_expired'], ['deadline-inflight', 2, 1, 2, 'local_stopped'],
  ['revoked-after-hash', 2, 2, 3, 'approval_changed'],
  ['cors', 2, 0, 2, 'remote_failed'], ['malformed-dataset', 2, 1, 2, 'malformed_wire'],
  ['malformed-table', 2, 2, 3, 'malformed_wire'], ['oversize', 2, 1, 2, 'response_limit'],
  ['redirect', 2, 1, 2, 'remote_failed'], ['public-schema-limit', 2, 2, 3, 'response_limit'], ['logical-allowlist', 0, 0, 0, 'fixture_allowlist'],
];
const names = new Set(cases.map(([name]) => name));
const privateMarkers = ['fixture-token', 'private-owner', 'fixture-principal', 'private-job-project', 'private@example.invalid'];
const requests = [], violations = [], unrelated = [];
let origin, fixtureOrigin, browser;
const fail = (res, label) => { violations.push(label); res.writeHead(400).end(); };
const app = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { fail(res, 'app method'); return; }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    // Do not intercept allowed requests with Playwright routing: interception
    // suppresses native CORS preflights. CSP blocks unrelated browser traffic.
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-dalgo-fixture'; connect-src ${fixtureOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    res.end('<!doctype html><title>BigQuery synthetic metadata acceptance</title><script nonce="dalgo-fixture" type="importmap">{"imports":{"@dalgo/bigquery/analytical":"/bigquery/analytical.js"}}</script><main><h1>Synthetic fixture only</h1></main>'); return;
  }
  const asset = assets.get(req.url);
  if (!asset) { fail(res, 'app path'); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(asset)); }
  catch { violations.push('asset read'); res.writeHead(500).end(); }
});
const fixture = createServer((req, res) => {
  const match = /^\/cases\/([a-z-]+)\/(discovery|userinfo|dataset|table)$/u.exec(req.url);
  if (!match || !names.has(match[1])) { fail(res, 'fixture path'); return; }
  const [, name, endpoint] = match;
  requests.push({ name, endpoint, method: req.method }); // Never retain headers/body/private identity.
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin !== origin || req.headers.cookie !== undefined) { fail(res, 'origin/credentials'); return; }
  if (req.method === 'OPTIONS') {
    if (endpoint === 'discovery' || req.headers.authorization !== undefined || req.headers['access-control-request-method'] !== 'GET' || req.headers['access-control-request-headers'] !== 'authorization') { fail(res, 'preflight headers'); return; }
    if (!(name === 'cors' && endpoint === 'dataset')) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Methods', 'GET'); res.setHeader('Access-Control-Allow-Headers', 'Authorization'); res.setHeader('Access-Control-Max-Age', '0');
    }
    res.writeHead(204).end(); return;
  }
  if (req.method !== 'GET' || req.headers.authorization !== (endpoint === 'discovery' ? undefined : 'Bearer fixture-token')) { fail(res, 'GET authorization'); return; }
  res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Content-Type', 'application/json');
  if (endpoint === 'discovery') {
    res.end(JSON.stringify({ issuer: name === 'wrong-issuer' ? 'https://wrong.invalid' : 'https://accounts.google.com', userinfo_endpoint: name === 'wrong-userinfo' ? 'https://openidconnect.googleapis.com/v1/wrong' : 'https://openidconnect.googleapis.com/v1/userinfo' })); return;
  }
  if (endpoint === 'userinfo') {
    if (name === 'denied-userinfo') { res.writeHead(401).end('{"error":"access_denied"}'); return; }
    // Valid stable identity deliberately has no email.
    res.end(JSON.stringify(name === 'missing-sub' ? {} : { sub: name === 'blank-sub' ? ' ' : 'fixture-principal' })); return;
  }
  if (name === 'redirect' && endpoint === 'dataset') { res.writeHead(302, { Location: '/trap' }).end(); return; }
  if (name === `malformed-${endpoint}`) { res.end('{bad'); return; }
  if (name === 'oversize' && endpoint === 'dataset') { res.end(JSON.stringify({ padding: 'x'.repeat(2048) })); return; }
  const reference = { projectId: golden.source_project, datasetId: golden.dataset_id };
  res.end(JSON.stringify(endpoint === 'dataset' ? { datasetReference: reference, location: golden.location, access: [{ principal: 'private-owner' }] } : {
    tableReference: { ...reference, tableId: golden.table_id }, type: golden.object_type,
    schema: { fields: name === 'public-schema-limit' ? Array.from({ length: 501 }, (_, i) => ({ name: `fixture_${i}`, type: 'STRING' })) : golden.schema.map(field => ({ ...field, description: 'private@example.invalid', policyTags: { names: ['private-owner'] }, ...(field.fields ? { fields: field.fields.map(nested => ({ ...nested, mode: undefined, defaultValueExpression: 'private-owner', precision: '38' })) } : {}) })) },
    clustering: { fields: ['private-owner'] }, numRows: '100', description: 'private-owner',
  }));
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
const receipts = [];
try {
  await listen(app); origin = `http://127.0.0.1:${app.address().port}`;
  await listen(fixture); fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  for (const [name, identityGETs, metadataGETs, preflights, code] of cases) {
    const start = requests.length;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin && (url.pathname === '/' || assets.has(url.pathname)) && url.search === '') return;
        if (url.origin === fixtureOrigin && url.search === '' && new RegExp(`^/cases/${name}/(discovery|userinfo|dataset|table)$`, 'u').test(url.pathname)) return;
        unrelated.push({ case: name, reason: 'unrelated request' });
      });
      const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(origin);
      let caseTimer;
      const result = await Promise.race([page.evaluate(async ({ name, fixtureOrigin, golden }) => {
        const { runCase, guardPersistence } = await import('/fixture.mjs');
        const persistence = guardPersistence();
        try { const result = await runCase(name, fixtureOrigin, golden); return { ...result, persistenceAttempts: persistence.assertClean() }; }
        finally { persistence.restore(); }
      }, { name, fixtureOrigin, golden }), new Promise((_, reject) => { caseTimer = setTimeout(() => reject(new Error('native case deadline')), 20000); })]).finally(() => clearTimeout(caseTimer));
      assert.equal(result.code, code, name); assert.equal(result.persistenceAttempts, 0);
      if (name === 'logical-allowlist') assert.equal(result.cspRefusal, true, 'native CSP external request refusal');
      if (result.observation) { assert.deepEqual(result.observation, golden); assert.equal(result.blockedLabel, 'Synthetic metadata fixture · query activation blocked'); }
      const trace = requests.slice(start);
      const identity = trace.filter(r => r.method === 'GET' && ['discovery', 'userinfo'].includes(r.endpoint)).length;
      const metadata = trace.filter(r => r.method === 'GET' && ['dataset', 'table'].includes(r.endpoint)).length;
      const options = trace.filter(r => r.method === 'OPTIONS').length;
      assert.deepEqual([identity, metadata, options], [identityGETs, metadataGETs, preflights], name);
      assert.deepEqual(result.logicalRequests, trace.filter(r => r.method === 'GET').map(r => r.endpoint).concat(name === 'cors' ? ['dataset'] : []), 'logical/native GET correspondence');
      receipts.push({ name, result: code, identityGETs: identity, metadataGETs: metadata, preflights: options });
    } finally { await context.close(); }
  }
  assert.deepEqual(violations, []); assert.deepEqual(unrelated, []);
  const receipt = { synthetic: true, provenance: 'synthetic-fixture', standaloneNativeAcceptance: true, requiredCIBrowserJob: false, browser: browser.version(), cases: receipts,
    fixtureGETs: requests.filter(r => r.method === 'GET').length, fixtureOPTIONS: requests.filter(r => r.method === 'OPTIONS').length, cspExternalRefusals: 1, unrelatedRequests: unrelated.length, providerRequests: 0, persistenceAttempts: 0 };
  assert.ok(privateMarkers.every(marker => !JSON.stringify(receipt).includes(marker)), 'private receipt leakage');
  process.stdout.write(JSON.stringify(receipt) + '\n');
} finally {
  try { await browser?.close(); }
  finally { try { if (fixture.listening) await close(fixture); } finally { if (app.listening) await close(app); } }
}
