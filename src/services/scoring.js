import { SCORING } from '../config.js';

/**
 * Scoring rules (recomputed from scratch whenever a solve is recorded, so late detection never changes the outcome):
 *   points = base(difficulty) + speed bonus + first-solve bonus
 *   base        : Easy 100 · Medium 200 · Hard 300
 *   speed bonus : up to 50% of base, decaying linearly from the start of the match to the buzzer
 *   first solve : +25 to whoever's LeetCode submission for that problem was accepted earliest
 * Solve times come from LeetCode's accepted-submission timestamps, not from when we noticed them.
 */
export function pointsFor({ basePoints, solvedAt, startedAt, endsAt, firstSolve }) {
  const duration = endsAt - startedAt;
  const remaining = duration > 0 ? Math.min(1, Math.max(0, (endsAt - solvedAt) / duration)) : 0;
  const speed = Math.round(basePoints * SCORING.speedBonusMax * remaining);
  return basePoints + speed + (firstSolve ? SCORING.firstSolveBonus : 0);
}

export function recomputeScores(match) {
  const startedAt = new Date(match.startedAt).getTime();
  const endsAt = new Date(match.endsAt).getTime();
  const problems = new Map(match.problems.map((p) => [p.slug, p]));

  const firstBySlug = new Map();
  for (const participant of match.participants) {
    for (const solve of participant.solves) {
      const t = new Date(solve.solvedAt).getTime();
      const current = firstBySlug.get(solve.slug);
      if (!current || t < current.t) firstBySlug.set(solve.slug, { t, user: String(participant.user) });
    }
  }

  for (const participant of match.participants) {
    let score = 0;
    for (const solve of participant.solves) {
      const problem = problems.get(solve.slug);
      if (!problem) continue;
      const first = firstBySlug.get(solve.slug);
      solve.firstSolve = first?.user === String(participant.user) && first.t === new Date(solve.solvedAt).getTime();
      solve.points = pointsFor({
        basePoints: problem.basePoints,
        solvedAt: new Date(solve.solvedAt).getTime(),
        startedAt,
        endsAt,
        firstSolve: solve.firstSolve,
      });
      score += solve.points;
    }
    participant.score = score;
  }
  return match;
}

const lastSolveTime = (p) =>
  p.solves.length ? Math.max(...p.solves.map((s) => new Date(s.solvedAt).getTime())) : Infinity;

// Ranking: higher score, then more problems solved, then whoever finished their last solve earlier.
export function compareStanding(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.solves.length !== a.solves.length) return b.solves.length - a.solves.length;
  const ta = lastSolveTime(a);
  const tb = lastSolveTime(b);
  return ta === tb ? 0 : ta - tb;
}

export function assignRanks(participants) {
  const sorted = [...participants].sort(compareStanding);
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    p.rank = prev && compareStanding(prev, p) === 0 ? prev.rank : i + 1;
  });
  return sorted;
}

/**
 * Multiplayer Elo: every pair of players is treated as a head-to-head game decided by final rank,
 * and the per-pair K factor is divided by (n - 1) so a match moves rating about as much as one 1v1.
 */
export function ratingChanges(players, k = 40) {
  const n = players.length;
  if (n < 2) return players.map(() => 0);
  return players.map((a, i) => {
    let delta = 0;
    players.forEach((b, j) => {
      if (i === j) return;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const actual = a.rank < b.rank ? 1 : a.rank === b.rank ? 0.5 : 0;
      delta += actual - expected;
    });
    return Math.round((k / (n - 1)) * delta);
  });
}
