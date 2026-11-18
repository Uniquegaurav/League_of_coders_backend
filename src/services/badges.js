// Achievements. Conditions are pure so they are easy to test; awardBadges() persists newly earned ones.

/**
 * `ctx` carries facts from a single finished battle, when there is one:
 *   upsetBy   - largest rating gap to a higher-rated player this player finished above (rated battles only)
 *   fastHard  - solved a Hard within 15 minutes of the start
 *   cup       - the battle was a Sunday Cup
 */
export const BADGES = [
  { key: 'first-battle', name: 'First battle', description: 'Finish your first battle', test: (u) => u.stats.matches >= 1 },
  { key: 'first-win', name: 'First win', description: 'Win a rated battle', test: (u) => u.stats.wins >= 1 },
  { key: 'wins-10', name: '10 wins', description: 'Win 10 rated battles', test: (u) => u.stats.wins >= 10 },
  { key: 'wins-50', name: '50 wins', description: 'Win 50 rated battles', test: (u) => u.stats.wins >= 50 },
  { key: 'streak-7', name: '7-day streak', description: 'Practise or battle 7 days in a row', test: (u) => u.bestStreak >= 7 },
  { key: 'streak-30', name: '30-day streak', description: 'Practise or battle 30 days in a row', test: (u) => u.bestStreak >= 30 },
  { key: 'solved-100', name: '100 solved', description: 'Solve 100 problems on League of Coders', test: (u) => u.solvedCount >= 100 },
  { key: 'platinum', name: 'Platinum', description: 'Reach a 1400 rating', test: (u) => u.stats.rating >= 1400 },
  { key: 'giant-slayer', name: 'Giant slayer', description: 'Finish above someone rated 200+ higher', test: (_u, c) => (c.upsetBy || 0) >= 200 },
  { key: 'speed-demon', name: 'Speed demon', description: 'Solve a Hard within 15 minutes in a battle', test: (_u, c) => !!c.fastHard },
  { key: 'sunday-cup', name: 'Cup contender', description: 'Play in a Sunday Cup', test: (_u, c) => !!c.cup },
  { key: 'recruiter', name: 'Recruiter', description: 'Bring 3 friends who finish a battle', test: (u) => u.referralCount >= 3 },
];

export const BADGE_KEYS = new Set(BADGES.map((b) => b.key));

/** Keys this player qualifies for, given their current numbers and optional battle facts. */
export function qualifyingBadges(user, ctx = {}) {
  const view = {
    stats: { matches: 0, wins: 0, rating: 1200, ...(user.stats?.toObject?.() || user.stats || {}) },
    bestStreak: user.practice?.bestStreak || 0,
    solvedCount: user.solvedSlugs?.length || 0,
    referralCount: user.referralCount || 0,
  };
  return BADGES.filter((b) => b.test(view, ctx)).map((b) => b.key);
}

/** Adds newly earned badges to a user document (mutates; caller saves). Returns the new keys. */
export function grantBadges(user, ctx = {}, now = new Date()) {
  const have = new Set((user.badges || []).map((b) => b.key));
  const fresh = qualifyingBadges(user, ctx).filter((k) => !have.has(k));
  if (fresh.length) {
    if (!user.badges) user.badges = [];
    fresh.forEach((key) => user.badges.push({ key, at: now }));
  }
  return fresh;
}

/** Facts about one player's battle that badges care about. */
export function battleFacts(match, participant) {
  const rated = match.participants.length >= 2;
  const start = new Date(match.startedAt).getTime();
  const hard = new Set(match.problems.filter((p) => p.difficulty === 'Hard').map((p) => p.slug));
  const fastHard = participant.solves.some((s) => hard.has(s.slug) && new Date(s.solvedAt).getTime() - start <= 15 * 60 * 1000);
  let upsetBy = 0;
  if (rated && participant.rank && participant.score > 0 && participant.ratingBefore != null) {
    for (const other of match.participants) {
      if (other === participant || other.ratingBefore == null || !other.rank) continue;
      if (other.rank > participant.rank) upsetBy = Math.max(upsetBy, other.ratingBefore - participant.ratingBefore);
    }
  }
  return { upsetBy, fastHard, cup: match.event?.kind === 'cup' };
}
