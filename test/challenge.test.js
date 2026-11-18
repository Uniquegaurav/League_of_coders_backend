import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soloScore } from '../src/routes/challenges.js';

test('creator score is recomputed as a solo run on the same clock', () => {
  const start = Date.parse('2026-11-19T10:00:00Z');
  const match = {
    startedAt: new Date(start),
    settings: { durationMin: 60 },
    problems: [
      { slug: 'a', basePoints: 100 },
      { slug: 'b', basePoints: 200 },
    ],
  };
  // a solved at the start: 100 + 50 speed + 25 first-solve; b solved at half time: 200 + 50 + 25.
  const p = { solves: [{ slug: 'a', solvedAt: new Date(start) }, { slug: 'b', solvedAt: new Date(start + 30 * 60000) }] };
  assert.equal(soloScore(match, p), 175 + 275);
});
