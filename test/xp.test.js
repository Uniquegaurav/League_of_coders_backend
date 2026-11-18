import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addXp, battleXp, kFactor, practiceXp, practiceView, recordActivity, weekKeyOf, XP_RULES } from '../src/services/progression.js';
import { ratingChanges } from '../src/services/scoring.js';

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
const diff = { a: 'Easy', b: 'Medium', c: 'Hard' };

test('battle XP: verified solves by difficulty, placement bonus, tournament multiplier', () => {
  const solves = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  const base = { solves, difficultyOf: (s) => diff[s], score: 500 };
  assert.equal(battleXp({ ...base, rank: 1, players: 1 }), 105); // solo: no placement
  assert.equal(battleXp({ ...base, rank: 1, players: 4 }), 145);
  assert.equal(battleXp({ ...base, rank: 2, players: 4 }), 120);
  assert.equal(battleXp({ ...base, rank: 3, players: 4 }), 105);
  assert.equal(battleXp({ ...base, rank: 1, players: 4, tournament: true }), Math.round(145 * 1.5));
  assert.equal(battleXp({ ...base, solves: [], score: 0, rank: 1, players: 4 }), 0); // nobody scored: no win bonus
});

test('practice XP is capped per day and refunds when un-ticked', () => {
  const user = { practice: {} };
  const now = day('2026-11-19');
  let total = 0;
  for (let i = 0; i < 6; i += 1) total += practiceXp(user, 'Hard', { now });
  assert.equal(total, XP_RULES.practiceDailyCap);
  assert.equal(practiceXp(user, 'Hard', { now }), 0);
  assert.equal(practiceXp(user, 'Hard', { solved: false, now }), -40);
  assert.equal(practiceXp(user, 'Easy', { now: day('2026-11-20') }), 10); // new day, new cap
  assert.equal(practiceXp(user, 'Easy', { daily: true, now: day('2026-11-20') }), 20);
});

test('weekly XP resets on Monday and remembers last week', () => {
  const user = { practice: {} };
  addXp(user, 100, day('2026-11-19')); // Thursday
  assert.equal(practiceView(user, day('2026-11-22')).weekXp, 100); // Sunday, same week
  addXp(user, 30, day('2026-11-23')); // Monday
  assert.equal(user.practice.xp, 130);
  assert.equal(user.practice.weekXp, 30);
  assert.equal(user.practice.prevWeekKey, weekKeyOf(day('2026-11-19')));
  assert.equal(user.practice.prevWeekXp, 100);
  assert.equal(addXp(user, -500, day('2026-11-23')), -130); // total never goes below 0
});

test('streak bonus only on the first activity of the day from day 3', () => {
  const user = {};
  assert.equal(recordActivity(user, day('2026-11-17')), 0);
  assert.equal(recordActivity(user, day('2026-11-18')), 0);
  assert.equal(recordActivity(user, day('2026-11-19')), XP_RULES.streakBonus);
  assert.equal(recordActivity(user, day('2026-11-19')), 0);
});

test('K-factor: provisional players move faster, top players slower', () => {
  assert.equal(kFactor({ ratedEvents: 0 }), 40);
  assert.equal(kFactor({ ratedEvents: 12, rating: 1500 }), 24);
  assert.equal(kFactor({ ratedEvents: 30, rating: 2100 }), 16);
  const [newbie, veteran] = ratingChanges([
    { rating: 1200, rank: 1, k: 40 },
    { rating: 1200, rank: 2, k: 24 },
  ]);
  assert.equal(newbie, 20);
  assert.equal(veteran, -12);
});
