import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignRanks, pointsFor, ratingChanges, recomputeScores } from '../src/services/scoring.js';
import { shuffle } from '../src/utils/random.js';

const start = Date.parse('2026-01-01T10:00:00Z');
const end = start + 60 * 60 * 1000;
const at = (min) => new Date(start + min * 60 * 1000);

test('speed bonus decays linearly from 50% to 0', () => {
  assert.equal(pointsFor({ basePoints: 200, solvedAt: start, startedAt: start, endsAt: end }), 300);
  assert.equal(pointsFor({ basePoints: 200, solvedAt: at(30).getTime(), startedAt: start, endsAt: end }), 250);
  assert.equal(pointsFor({ basePoints: 200, solvedAt: end, startedAt: start, endsAt: end }), 200);
  assert.equal(pointsFor({ basePoints: 100, solvedAt: end, startedAt: start, endsAt: end, firstSolve: true }), 125);
});

test('first solve goes to the earliest accepted submission, regardless of detection order', () => {
  const match = {
    startedAt: new Date(start),
    endsAt: new Date(end),
    problems: [{ slug: 'two-sum', basePoints: 100 }],
    participants: [
      { user: 'a', solves: [{ slug: 'two-sum', solvedAt: at(20) }] },
      { user: 'b', solves: [{ slug: 'two-sum', solvedAt: at(10) }] },
    ],
  };
  recomputeScores(match);
  assert.equal(match.participants[0].solves[0].firstSolve, false);
  assert.equal(match.participants[1].solves[0].firstSolve, true);
  assert.ok(match.participants[1].score > match.participants[0].score);
});

test('ranking breaks ties by solve count then finishing time', () => {
  const players = [
    { user: 'slow', score: 300, solves: [{ solvedAt: at(40) }] },
    { user: 'fast', score: 300, solves: [{ solvedAt: at(5) }] },
    { user: 'none', score: 0, solves: [] },
  ];
  const ranked = assignRanks(players);
  assert.deepEqual(ranked.map((p) => [p.user, p.rank]), [['fast', 1], ['slow', 2], ['none', 3]]);
});

test('players with no solves tie and gain no rating', () => {
  const ranked = assignRanks([
    { user: 'a', score: 0, solves: [] },
    { user: 'b', score: 0, solves: [] },
  ]);
  assert.deepEqual(ranked.map((p) => p.rank), [1, 1]);
  assert.deepEqual(ratingChanges(ranked.map((p) => ({ rating: 1200, rank: p.rank }))), [0, 0]);
});

test('rating changes are zero-sum for equal ratings', () => {
  const deltas = ratingChanges([
    { rating: 1200, rank: 1 },
    { rating: 1200, rank: 2 },
    { rating: 1200, rank: 3 },
  ]);
  assert.ok(deltas[0] > 0 && deltas[2] < 0);
  assert.equal(deltas.reduce((a, b) => a + b, 0), 0);
  assert.deepEqual(ratingChanges([{ rating: 1200, rank: 1 }]), [0]);
});

test('shuffle keeps every element exactly once', () => {
  const input = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffle(input);
  assert.equal(out.length, 50);
  assert.deepEqual([...out].sort((a, b) => a - b), input);
});
