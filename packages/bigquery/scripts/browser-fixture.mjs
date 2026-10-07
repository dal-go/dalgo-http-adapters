// Private synthetic consumer: served by browser-smoke.mjs, never public dist.
import { AnalyticalError, MetadataFixtureHarness, googleAuthorizationScopes } from '@dalgo/bigquery/analytical';

const discovery = 'https://accounts.google.com/.well-known/openid-configuration';
const userInfo = 'https://openidconnect.googleapis.com/v1/userinfo';
const syntheticToken = 'fixture-token';
const privateMarkers = ['fixture-token', 'private-owner', 'fixture-principal', 'private-job-project', 'private@example.invalid', 'policyTags', 'precision', 'defaultValueExpression', 'numRows', 'clustering'];
const observationKeys = ['format', 'source_id', 'source_project', 'dataset_id', 'table_id', 'location', 'object_type', 'observed_at', 'projection', 'provenance', 'schema', 'sha256'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const refusal = async operation => {
  try { await operation(); }
  catch (error) {
    assert(error instanceof AnalyticalError || error instanceof TypeError || error.message === 'fixture_allowlist', 'unexpected refusal type');
    const serialized = JSON.stringify({ name: error.name, message: error.message, code: error.code });
    assert(privateMarkers.every(marker => !serialized.includes(marker)), 'private error leakage');
    return error instanceof AnalyticalError ? error.code : error.message === 'fixture_allowlist' ? 'fixture_allowlist' : 'native_fetch_refused';
  }
  throw new Error('expected refusal');
};

export async function runCase(name, fixtureOrigin, golden) {
  const source = { sourceId: golden.source_id, sourceProject: golden.source_project, datasetId: golden.dataset_id, tableId: golden.table_id };
  const dataset = `https://bigquery.googleapis.com/bigquery/v2/projects/${source.sourceProject}/datasets/${source.datasetId}?datasetView=METADATA`;
  const table = `https://bigquery.googleapis.com/bigquery/v2/projects/${source.sourceProject}/datasets/${source.datasetId}/tables/${source.tableId}?view=STORAGE_STATS`;
  const endpoints = new Map([[discovery, 'discovery'], [userInfo, 'userinfo'], [dataset, 'dataset'], [table, 'table']]);
  const token = { access_token: syntheticToken, token_type: 'Bearer', expires_in: name === 'expiry-inflight' ? 1 : 3600, scope: googleAuthorizationScopes() };
  let now = Date.parse(golden.observed_at), metadataCalls = 0;
  const logicalRequests = [];
  let harness;
  const invalidate = () => {
    switch (name) {
      case 'owner-inflight': harness.setOwner('other-owner'); break;
      case 'signout-inflight': harness.setOwner(undefined); break;
      case 'disconnect-inflight': harness.disconnect(); break;
      case 'source-inflight': try { harness.select('unknown-source', 'private-job-project'); } catch { /* invalidates first */ } break;
      case 'project-inflight': harness.select(source.sourceId, 'other-job-project'); break;
      case 'consent-inflight': harness.denyMetadataConsent(); break;
      case 'rotation-inflight': void harness.connect({ ...token, error: 'access_denied' }).catch(() => {}); break;
      case 'expiry-inflight': now += 1001; break;
      case 'deadline-inflight': now += 30001; break;
    }
  };
  // This trusted test-only substitution cannot fall back to a cloud URL.
  const transport = async (url, init) => {
    const endpoint = endpoints.get(url);
    if (!endpoint || init?.method !== 'GET' || init.redirect !== 'error' || init.credentials !== 'omit' || init.cache !== 'no-store' || init.body !== undefined) throw new Error('fixture_allowlist');
    const headers = new globalThis.Headers(init.headers);
    assert([...headers.keys()].every(key => key === 'accept' || key === 'authorization'), 'unexpected request header');
    assert(headers.get('accept') === 'application/json', 'unexpected Accept');
    assert(headers.get('authorization') === (endpoint === 'discovery' ? null : `Bearer ${syntheticToken}`), 'unexpected authorization');
    logicalRequests.push(endpoint);
    if (endpoint === 'dataset' || endpoint === 'table') metadataCalls++;
    const response = await globalThis.fetch(`${fixtureOrigin}/cases/${name}/${endpoint}`, init);
    if (endpoint === 'dataset') invalidate();
    return response;
  };
  harness = new MetadataFixtureHarness({ sources: [source], identityFetch: transport, metadataFetch: transport,
    clock: { now: () => now, sleep: async milliseconds => { now += milliseconds; } },
    limits: { responseBytes: name === 'oversize' ? 128 : 65536, totalResponseBytes: 131072, wallMs: 30000, httpMs: name === 'expiry-inflight' ? 2000 : 1000 },
  });
  harness.setOwner('private-owner'); harness.select(source.sourceId, 'private-job-project');
  if (name === 'logical-allowlist') {
    const init = { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } };
    for (const url of [discovery + '?extra=true', userInfo + '/other', dataset.replace('METADATA', 'FULL'), table.replace('STORAGE_STATS', 'FULL'), 'https://bigquery.googleapis.com/bigquery/v2/projects/x/queries']) {
      assert(await refusal(() => transport(url, init)) === 'fixture_allowlist', 'allowlist refusal');
    }
    assert(logicalRequests.length === 0, 'allowlist performed I/O');
    let listener, timer;
    const violation = new Promise((resolve, reject) => {
      listener = event => { if (event.effectiveDirective === 'connect-src') resolve(event.blockedURI); };
      globalThis.document.addEventListener('securitypolicyviolation', listener);
      timer = globalThis.setTimeout(() => reject(new Error('missing CSP refusal')), 1000);
    });
    try {
      await refusal(() => globalThis.fetch('https://blocked.invalid/no-provider'));
      assert(await violation === 'https://blocked.invalid/no-provider', 'wrong CSP refusal');
    } finally { globalThis.clearTimeout(timer); globalThis.document.removeEventListener('securitypolicyviolation', listener); }
    return { name, code: 'fixture_allowlist', logicalRequests, cspRefusal: true };
  }
  if (name === 'missing-openid') token.scope = 'https://www.googleapis.com/auth/bigquery.readonly';
  if (name === 'missing-read-grant') token.scope = 'openid';
  if (name === 'denied-token') token.error = 'access_denied';
  const identityNegative = ['missing-sub', 'blank-sub', 'missing-openid', 'missing-read-grant', 'wrong-issuer', 'wrong-userinfo', 'denied-token', 'denied-userinfo'].includes(name);
  if (identityNegative) {
    const code = await refusal(() => harness.connect(token));
    assert(metadataCalls === 0, 'identity refusal reached metadata');
    assert(await refusal(() => harness.discover()) === 'approval_required', 'identity refusal left consent');
    return { name, code, logicalRequests };
  }
  await harness.connect(token);
  if (name !== 'no-consent') harness.consentToMetadata();
  switch (name) {
    case 'no-owner': harness.setOwner(undefined); break;
    case 'consent-before': harness.denyMetadataConsent(); break;
    case 'disconnect-before': harness.disconnect(); break;
    case 'source-before': try { harness.select('unknown-source', 'private-job-project'); } catch { /* invalidates first */ } break;
    case 'project-before': harness.select(source.sourceId, 'other-job-project'); break;
    case 'rotation-before': await harness.connect(token); break;
    case 'expiry-before': now += 3600001; break;
  }
  const originalDigest = globalThis.crypto.subtle.digest;
  if (name === 'revoked-after-hash') globalThis.crypto.subtle.digest = async function (...args) {
    const digest = await originalDigest.apply(this, args); harness.denyMetadataConsent(); return digest;
  };
  try {
    if (name === 'success-no-email') {
      const observation = await harness.discover();
      assert(JSON.stringify(observation) === JSON.stringify(golden), 'golden mismatch');
      assert(Object.keys(observation).sort().join() === observationKeys.sort().join(), 'public envelope changed');
      assert(observation.provenance.kind === 'synthetic-fixture', 'fixture provenance changed');
      assert(!('status' in observation) && !('queryAdmission' in observation) && !('costAdmission' in observation), 'invented admission fields');
      const serialized = JSON.stringify(observation);
      assert(privateMarkers.every(marker => !serialized.includes(marker)), 'private observation leakage');
      const element = globalThis.document.createElement('pre');
      element.textContent = 'Synthetic metadata fixture · query activation blocked';
      globalThis.document.querySelector('main').append(element);
      // The blocked label is presentation only, never an observation property.
      return { name, code: 'success', logicalRequests, observation, blockedLabel: element.textContent };
    }
    const code = await refusal(() => harness.discover(name === 'deadline-before' ? { deadline: now } : {}));
    if (['no-consent', 'no-owner', 'consent-before', 'disconnect-before', 'source-before', 'project-before', 'rotation-before', 'expiry-before', 'deadline-before'].includes(name)) assert(metadataCalls === 0, 'pre-dispatch refusal reached metadata');
    if (name.endsWith('-inflight')) assert(metadataCalls === 1, 'inflight refusal issued later metadata');
    if (name === 'revoked-after-hash') assert(metadataCalls === 2, 'hash refusal skipped native metadata');
    return { name, code, logicalRequests };
  } finally { globalThis.crypto.subtle.digest = originalDigest; harness.disconnect(); }
}

export function guardPersistence() {
  let attempts = 0;
  const originals = [];
  for (const [prototype, method] of [[globalThis.Storage.prototype, 'setItem'], [globalThis.IDBFactory.prototype, 'open'], [globalThis.IDBFactory.prototype, 'deleteDatabase'], [globalThis.CacheStorage.prototype, 'open']]) {
    const original = prototype[method]; originals.push(() => { prototype[method] = original; });
    prototype[method] = () => { attempts++; throw new Error('fixture persistence refused'); };
  }
  return { assertClean() { assert(attempts === 0, 'persistence attempted'); assert(globalThis.localStorage.length === 0 && globalThis.sessionStorage.length === 0, 'storage populated'); return attempts; }, restore() { originals.forEach(restore => restore()); } };
}
