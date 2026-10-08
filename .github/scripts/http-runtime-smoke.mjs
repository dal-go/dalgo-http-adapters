// Copied into the fresh registry consumer; no provider or DOM polyfill is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Key, UnsupportedError, executeSourceComposedJoinedDTQLQuery, parseDTQL } from '@dalgo/core';
import { ECBQueryExecutor } from '@dal-go/dalgo2http';
import { ImmutableDescriptors, descriptors, syntheticPlan } from './fixture/browser-fixture.js';

const core = JSON.parse(await readFile(new URL('./node_modules/@dalgo/core/package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('./node_modules/@dal-go/dalgo2http/package.json', import.meta.url), 'utf8'));
assert.equal(core.version, '0.6.0');
let requests = 0;
const executor = new ECBQueryExecutor({ collectionName: 'daily', executorId: 'synthetic-browser', providerReadPlan: await syntheticPlan(), fetch: async () => { requests++; throw new Error('unexpected provider request'); } });
await assert.rejects(async () => executor.query({ source: { kind: 'collection', name: 'daily' }, filters: [], orders: [{ field: 'currency', direction: 'asc' }], limit: 256 }), UnsupportedError);
assert.equal(requests, 0);
const query = parseDTQL({ from: { name: 'descriptors', alias: 'q', joins: [{ type: 'inner', from: { name: 'descriptors', alias: 'd' }, on: [{ left: { field: 'currency', source: 'q' }, op: '==', right: { field: 'currency', source: 'd' } }] }] }, columns: [{ field: 'name', source: 'd', as: 'name' }] }, { tables: [{ name: 'descriptors', fields: ['currency', 'name'] }] });
const output = await executeSourceComposedJoinedDTQLQuery(query, { compositionId: 'synthetic-node-composition', resolveInput: () => new ImmutableDescriptors(descriptors).admittedInput() });
assert.equal(output.records.length, 1);
assert.ok(output.records[0].key instanceof Key);
assert.deepEqual(output.sourceComposition.inputs.map(input => input.rightsStatus), ['unknown', 'unknown']);
console.log(JSON.stringify({ nodeVersion: process.version, synthetic: true, localComposedRows: output.records.length, preIORefusal: true, providerRequests: requests, core: 'registry:0.6.0', package: { name: manifest.name, version: manifest.version, gitHead: manifest.gitHead } }));
