import { readFileSync } from 'node:fs';
import { runSyntheticOVDBConsumer } from './fixture/browser-fixture.js';
const manifest = JSON.parse(readFileSync('node_modules/@dalgo/ovdb/package.json', 'utf8'));
const proof = await runSyntheticOVDBConsumer();
console.log(JSON.stringify({ ...proof, nodeVersion: process.version, package: { name: manifest.name, version: manifest.version, gitHead: manifest.gitHead } }));
