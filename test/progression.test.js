import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpStreak, dayHash, effectiveStreak, levelFor, practiceView, todayKey } from '../src/services/progression.js';

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);

test('levels follow 50 * level^2 thresholds', () => {
  assert.deepEqual(levelFor(0), { level: 1, levelXp: 0, nextLevelXp: 50 });
  assert.deepEqual(levelFor(49), { level: 1, levelXp: 0, nextLevelXp: 50 });
  assert.deepEqual(levelFor(50), { level: 2, levelXp: 50, nextLevelXp: 200 });
  assert.deepEqual(levelFor(450), { level: 4, levelXp: 450, nextLevelXp: 800 });
  assert.deepEqual(levelFor(-5), { level: 1, levelXp: 0, nextLevelXp: 50 });
});

test('streak grows on consecutive days, resets after a gap, and counts once per day', () => {
  const user = {};
  assert.equal(bumpStreak(user, day('2026-03-01')), 1);
  assert.equal(bumpStreak(user, day('2026-03-01')), 1);
  assert.equal(bumpStreak(user, day('2026-03-02')), 2);
  assert.equal(bumpStreak(user, day('2026-03-03')), 3);
  assert.equal(bumpStreak(user, day('2026-03-05')), 1);
  assert.equal(user.practice.bestStreak, 3);
  assert.equal(user.practice.lastActiveDay, '2026-03-05');
});

test('effective streak lapses once yesterday is missed', () => {
  const practice = { streak: 4, lastActiveDay: '2026-03-10' };
  assert.equal(effectiveStreak(practice, day('2026-03-10')), 4);
  assert.equal(effectiveStreak(practice, day('2026-03-11')), 4);
  assert.equal(effectiveStreak(practice, day('2026-03-12')), 0);
  assert.equal(effectiveStreak({}, day('2026-03-12')), 0);
});

test('practice view reports level and daily completion', () => {
  const now = day('2026-03-10');
  const view = practiceView({ practice: { xp: 210, streak: 2, bestStreak: 5, lastActiveDay: '2026-03-09', dailyDay: '2026-03-10' } }, now);
  assert.deepEqual(view, { xp: 210, level: 3, levelXp: 200, nextLevelXp: 450, streak: 2, bestStreak: 5, dailyDone: true });
  assert.equal(practiceView({}, now).dailyDone, false);
  assert.equal(todayKey(now), '2026-03-10');
});

test('day hash is deterministic and varies by day', () => {
  assert.equal(dayHash('2026-03-10'), dayHash('2026-03-10'));
  assert.notEqual(dayHash('2026-03-10'), dayHash('2026-03-11'));
});
