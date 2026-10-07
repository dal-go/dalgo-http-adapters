// Synthetic-only browser harness. Owner: invoking test process.
// Teardown: both loopback servers and the owned browser close in finally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const xml = `<g:Envelope xmlns:g="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time="2037-02-03"><Cube currency="AAA" rate="001.23000"/></Cube></Cube></g:Envelope>`;
const requests = [];
const app = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic ECB XML smoke</title>'); return; }
  if (!['/ecb-xml.js', '/transport.js'].includes(req.url)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/javascript');
  res.end(await readFile(new URL(`../dist${req.url}`, import.meta.url)));
});
let origin;
const provider = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/pass.xml') res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Content-Type', 'text/xml'); res.end(xml);
});
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
let browser;
try {
  await listen(app); origin = `http://127.0.0.1:${app.address().port}`;
  await listen(provider); const fixtureOrigin = `http://127.0.0.1:${provider.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = [];
  await context.route('**/*', route => {
    if (![origin, fixtureOrigin].includes(new URL(route.request().url()).origin)) {
      blocked.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage(); await page.goto(origin);
  const result = await page.evaluate(async ({ fixtureOrigin, xml }) => {
    const { decodeECBDaily } = await import('/ecb-xml.js');
    const { readECBXML, ECB_DAILY_URL } = await import('/transport.js');
    const encode = text => new TextEncoder().encode(text);
    const rows = decodeECBDaily(encode(xml));
    let malformed = false, dtd = false, namespace = false;
    for (const [name, text] of [['malformed', '<bad'], ['dtd', '<!DOCTYPE x>' + xml], ['namespace', xml.replace('http://www.ecb.int/vocabulary/2002-08-01/eurofxref', 'urn:bad')]]) {
      try { decodeECBDaily(encode(text)); } catch { if (name === 'malformed') malformed = true; if (name === 'dtd') dtd = true; if (name === 'namespace') namespace = true; }
    }
    // Test-only rewrite of the exact admitted request to an owned synthetic origin.
    // Native Fetch performs actual cross-origin HTTP and native CORS validation.
    const injected = path => async (input, init) => {
      if (input !== ECB_DAILY_URL) throw Error('unexpected admitted URL');
      const response = await fetch(fixtureOrigin + path, init);
      Object.defineProperty(response, 'url', { value: ECB_DAILY_URL });
      return response;
    };
    const pass = await readECBXML({ fetch: injected('/pass.xml') });
    let corsFailure = false;
    try { await readECBXML({ fetch: injected('/fail.xml') }); } catch (error) { corsFailure = error instanceof TypeError; }
    return { rows, malformed, dtd, namespace, corsFailure, corsRows: decodeECBDaily(pass.bytes) };
  }, { fixtureOrigin, xml });
  assert.deepEqual(result.rows, [{ time: '2037-02-03', currency: 'AAA', rate: '001.23000' }]);
  assert.deepEqual(result.corsRows, result.rows);
  assert.equal(result.malformed && result.dtd && result.namespace && result.corsFailure, true);
  assert.deepEqual(blocked, []); assert.deepEqual(requests, ['/pass.xml', '/fail.xml']);
  console.log(JSON.stringify({ browser: browser.version(), ...result, fixtureRequests: requests, blockedExternalRequests: blocked, providerRequests: 0 }));
} finally {
  await browser?.close();
  if (provider.listening) await close(provider);
  if (app.listening) await close(app);
}
