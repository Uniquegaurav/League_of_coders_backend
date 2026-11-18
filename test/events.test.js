import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventOn, nextEvents, parseStart } from '../src/services/events.js';

const start = parseStart('15:30');

test('weekdays get a battle hour, Sundays get the cup', () => {
  const thu = eventOn(Date.parse('2026-11-19T08:00:00Z'), start);
  assert.equal(thu.kind, 'daily');
  assert.equal(thu.key, 'daily-2026-11-19');
  assert.equal(thu.startsAt.toISOString(), '2026-11-19T15:30:00.000Z');
  assert.equal(thu.opensAt.toISOString(), '2026-11-19T15:00:00.000Z');
  const sun = eventOn(Date.parse('2026-11-22T08:00:00Z'), start);
  assert.equal(sun.kind, 'cup');
  assert.equal(sun.key, 'cup-2026-11-22');
});

test('next events skip the ones that already started', () => {
  const [next] = nextEvents(Date.parse('2026-11-19T16:00:00Z'));
  assert.equal(next.key, 'daily-2026-11-20');
  const [cup] = nextEvents(Date.parse('2026-11-19T16:00:00Z'), { kind: 'cup' });
  assert.equal(cup.key, 'cup-2026-11-22');
});
