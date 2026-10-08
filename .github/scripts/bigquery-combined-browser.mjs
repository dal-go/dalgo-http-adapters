import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { parse } from 'yaml';
await build({ entryPoints: ['test/browser.ts'], bundle: true, platform: 'browser', format: 'esm', outfile: 'browser.js' });
const browser = await chromium.launch({ headless: true });
const blocked = [], prepared = new Map();
let bigqueryPosts = 0, httpGets = 0;
const ovdbPosts = { default: 0, explicit: 0 };
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.exposeFunction('prepareResponse', (endpoint, id, body, mode) => {
    assert.equal(endpoint, 'https://worker.example/ecb-public/v1/databases/ecb/dtql');
    assert.match(id, /^[a-f0-9]{32}$/); assert.equal(JSON.parse(body).providerReads.execution.id, id);
    assert.ok(!prepared.has(id)); assert.ok(mode === 'default' || mode === 'explicit');
    prepared.set(id, { body, mode });
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url === 'https://directory.example/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module">import {runCombinedConsumer} from "./browser.js"; window.proof=runCombinedConsumer(window.prepareResponse);</script>' });
    if (url === 'https://directory.example/browser.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync('browser.js', 'utf8') });
    const headers = { 'Access-Control-Allow-Origin': 'https://directory.example', 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, OVDB-Execution-ID', 'Cache-Control': 'no-store' };
    if (url === 'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/queries') {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.method(), 'POST'); assert.equal(request.headers().authorization, 'Bearer synthetic-token');
      const body = JSON.parse(request.postData()); assert.equal(body.useLegacySql, false); assert.match(body.query, /synthetic-project\.synthetic\.items/);
      bigqueryPosts++;
      return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ jobComplete: true, schema: { fields: [{ name: '__dalgo_key', type: 'STRING' }, { name: 'rate', type: 'STRING' }] }, rows: [{ f: [{ v: 'one' }, { v: '001.23000' }] }] }) });
    }
    if (url === 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml') {
      assert.equal(request.method(), 'GET'); assert.equal(request.headers().authorization, undefined); httpGets++;
      return route.fulfill({ contentType: 'application/xml', headers, body: '<g:Envelope xmlns:g="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time="2037-02-03"><Cube currency="AAA" rate="001.23000"/></Cube></Cube></g:Envelope>' });
    }
    if (url === 'https://worker.example/ecb-public/v1/databases/ecb/dtql') {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.method(), 'POST'); assert.equal(request.headers().authorization, undefined); assert.equal(request.headers().cookie, undefined);
      assert.deepEqual(parse(request.postData()), { from: { name: 'daily' }, limit: 1 });
      const id = request.headers()['ovdb-execution-id'], response = prepared.get(id);
      assert.ok(response); prepared.delete(id); ovdbPosts[response.mode]++;
      return route.fulfill({ contentType: 'application/json', headers, body: response.body });
    }
    blocked.push(url); await route.abort();
  });
  await page.goto('https://directory.example/');
  const proof = await page.evaluate(() => window.proof);
  assert.equal(bigqueryPosts, 2); assert.equal(httpGets, 1); assert.deepEqual(ovdbPosts, { default: 2, explicit: 2 });
  assert.equal(proof.bigqueryRows, 2); assert.equal(proof.httpRows, 1); assert.equal(proof.ovdbDefaultRows, 2); assert.equal(proof.ovdbExplicitRows, 2); assert.equal(proof.sharedKeyIdentity, true);
  assert.equal(prepared.size, 0); assert.equal(blocked.length, 0);
  console.log(JSON.stringify({ ...proof, bigqueryPosts, httpGets, ovdbPosts, blockedExternalRequests: blocked }));
} finally { await browser.close(); }
