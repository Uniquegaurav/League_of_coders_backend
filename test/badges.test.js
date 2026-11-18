import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battleFacts, grantBadges, qualifyingBadges } from '../src/services/badges.js';

const user = (over = {}) => ({
  stats: { matches: 0, wins: 0, rating: 1200, ...over.stats },
  practice: { bestStreak: 0, ...over.practice },
  solvedSlugs: over.solvedSlugs || [],
  referralCount: over.referralCount || 0,
  badges: over.badges || [],
});

test('stat badges unlock at their thresholds', () => {
  assert.deepEqual(qualifyingBadges(user()), []);
  const keys = qualifyingBadges(user({ stats: { matches: 3, wins: 10, rating: 1450 }, practice: { bestStreak: 7 } }));
  assert.deepEqual(keys, ['first-battle', 'first-win', 'wins-10', 'streak-7', 'platinum']);
});

test('grantBadges only adds badges once', () => {
  const u = user({ stats: { matches: 1 } });
  assert.deepEqual(grantBadges(u), ['first-battle']);
  assert.deepEqual(grantBadges(u), []);
  assert.equal(u.badges.length, 1);
});

test('battle facts find upsets and fast hards', () => {
  const start = Date.parse('2026-11-19T15:30:00Z');
  const me = { rank: 1, score: 400, ratingBefore: 1200, solves: [{ slug: 'h', solvedAt: new Date(start + 10 * 60000) }] };
  const strong = { rank: 2, score: 100, ratingBefore: 1450, solves: [] };
  const match = { startedAt: new Date(start), problems: [{ slug: 'h', difficulty: 'Hard' }], participants: [me, strong], event: { kind: 'cup' } };
  assert.deepEqual(battleFacts(match, me), { upsetBy: 250, fastHard: true, cup: true });
  assert.equal(battleFacts(match, strong).upsetBy, 0);
  assert.ok(qualifyingBadges(user(), battleFacts(match, me)).includes('giant-slayer'));
});
