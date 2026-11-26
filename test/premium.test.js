import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, hashCode, open, seal } from '../src/services/secretBox.js';
import { mergeOrder } from '../src/routes/lists.js';
import { SORTS } from '../src/routes/problems.js';

test('sealed secrets round-trip and are not stored in plain text', () => {
  const secret = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.session-cookie-value';
  const sealed = seal(secret);
  assert.ok(!sealed.includes('session-cookie-value'));
  assert.notEqual(seal(secret), sealed, 'a fresh IV each time');
  assert.equal(open(sealed), secret);
});

test('tampered or garbage sealed values open to null', () => {
  const sealed = seal('abc');
  const [iv, tag, data] = sealed.split('.');
  assert.equal(open(`${iv}.${tag}.${Buffer.from('xyz').toString('base64')}`), null);
  assert.equal(open('not-a-secret'), null);
  assert.equal(open(undefined), null);
  assert.ok(data);
});

test('codes look like LOC-XXXX-XXXX-XXXX and hash the same however they are typed', () => {
  const code = generateCode();
  assert.match(code, /^LOC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(hashCode(code), hashCode(code.toLowerCase().replace(/-/g, ' ')));
  assert.notEqual(hashCode(code), hashCode(generateCode()));
});

test('reordering the whole list', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']), ['d', 'a', 'b', 'c']);
});

test('reordering a filtered view keeps hidden problems in place', () => {
  // b and d are hidden (e.g. solved). Visible a, c, e are rearranged into e, a, c.
  assert.deepEqual(mergeOrder(['a', 'b', 'c', 'd', 'e'], ['e', 'a', 'c']), ['e', 'b', 'a', 'd', 'c']);
});

test('reordering ignores unknown and duplicate slugs', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'zzz', 'c', 'a']), ['c', 'b', 'a']);
});

test('sorts', () => {
  const rows = [
    { frontendId: '10', title: 'K', difficulty: 'Hard', acRate: 30 },
    { frontendId: '2', title: 'B', difficulty: 'Easy', acRate: 70 },
    { frontendId: '33', title: 'A', difficulty: 'Medium', acRate: 50 },
  ];
  const ids = (sort) => [...rows].sort(SORTS[sort]).map((r) => r.frontendId);
  assert.deepEqual(ids('number'), ['2', '10', '33']);
  assert.deepEqual(ids('difficulty'), ['2', '33', '10']);
  assert.deepEqual(ids('difficulty-desc'), ['10', '33', '2']);
  assert.deepEqual(ids('acceptance'), ['2', '33', '10']);
  assert.deepEqual(ids('acceptance-asc'), ['10', '33', '2']);
  assert.deepEqual(ids('title'), ['33', '2', '10']);
});
