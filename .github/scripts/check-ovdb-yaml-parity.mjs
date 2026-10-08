// Reuse the built native wire mapper and released Go parser, never a parser fork.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeNativeQuery } from '../../packages/ovdb/dist-dtql/wire.js';
const inputs = [[], [''], ['001.23000'], ['2037-02-03'], ['a: b'], ['line\nbreak'], ['é'.repeat(64)], ['null'], ['true'], ['[x]'], ['001.23', '2037-02-03', 'a: b', 'a\nb', 'é', '', 'null', 'true', '[x]', '# comment']].map(values => {
  const { body, limit } = encodeNativeQuery({ source: { kind: 'collection', name: 'daily' }, filters: values.map(value => ({ field: 'rate', operator: '==', value })), orders: [] });
  return { body, limit, values };
});
const proof = execFileSync('go', ['run', '.'], { cwd: fileURLToPath(new URL('../fixtures/ovdb-yaml-parity/', import.meta.url)), input: JSON.stringify(inputs), encoding: 'utf8', env: { ...process.env, GOWORK: 'off' } });
process.stdout.write(proof);
