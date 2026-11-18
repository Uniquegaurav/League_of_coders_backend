// Progression: XP, levels, daily streaks. Pure helpers so they are easy to test.
//
// Two separate numbers measure a player:
//   * Rating (Elo) is skill. It only moves in official tournaments (see matchEngine.afterFinish).
//   * XP is effort. Every verified solve, every battle and every practice day earns it.
export const XP_RULES = {
  // Self-reported practice ticks: smaller, and capped per day so ticking boxes cannot be farmed.
  practice: { Easy: 10, Medium: 20, Hard: 40 },
  practiceDailyCap: 150,
  dailyProblemMultiplier: 2,
  // Solves verified against LeetCode inside a battle or solo test.
  battleSolve: { Easy: 15, Medium: 30, Hard: 60 },
  // Placement in battles with 2 or more players (only for players who scored).
  placement: { win: 40, topHalf: 15 },
  tournamentMultiplier: 1.5,
  // First activity of the day once a streak has reached 3 days.
  streakBonus: 10,
  streakBonusFrom: 3,
};
// Kept for older imports: practice XP by difficulty.
export const XP = XP_RULES.practice;

export function levelFor(xp = 0) {
  const n = Math.max(0, Number(xp) || 0);
  const level = Math.floor(Math.sqrt(n / 50)) + 1;
  return { level, levelXp: 50 * (level - 1) ** 2, nextLevelXp: 50 * level ** 2 };
}

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/** Monday (UTC) of the week containing `now`, as YYYY-MM-DD. */
export function weekKeyOf(now = Date.now()) {
  const d = new Date(now);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}
export const todayKey = (now = Date.now()) => dayKey(now);
export const yesterdayKey = (now = Date.now()) => dayKey(new Date(now).getTime() - 86400000);

/** Streak as the player sees it: it lapses once a full day passes without activity. */
export function effectiveStreak(practice = {}, now = Date.now()) {
  const last = practice.lastActiveDay;
  if (!last || (last !== todayKey(now) && last !== yesterdayKey(now))) return 0;
  return practice.streak || 0;
}

export function practiceView(user, now = Date.now()) {
  const p = user?.practice || {};
  const xp = p.xp || 0;
  return {
    xp,
    ...levelFor(xp),
    weekXp: p.weekKey === weekKeyOf(now) ? p.weekXp || 0 : 0,
    streak: effectiveStreak(p, now),
    bestStreak: p.bestStreak || 0,
    dailyDone: p.dailyDay === todayKey(now),
  };
}

/** Records activity for today on a user document (mutates; caller saves). */
export function bumpStreak(user, now = Date.now()) {
  if (!user.practice) user.practice = {};
  const p = user.practice;
  const today = todayKey(now);
  if (p.lastActiveDay === today) return p.streak;
  p.streak = p.lastActiveDay === yesterdayKey(now) ? (p.streak || 0) + 1 : 1;
  p.bestStreak = Math.max(p.bestStreak || 0, p.streak);
  p.lastActiveDay = today;
  return p.streak;
}

/** Stable index for "problem of the day" from a YYYY-MM-DD key. */
export function dayHash(day) {
  let h = 2166136261;
  for (const ch of String(day)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Adds (or, for an un-ticked practice problem, removes) XP. Keeps the weekly total in step. Mutates; caller saves. */
export function addXp(user, amount, now = Date.now()) {
  if (!user.practice) user.practice = {};
  const p = user.practice;
  const week = weekKeyOf(now);
  if (p.weekKey !== week) {
    // Remember last week's total for the Monday recap before starting a new week.
    if (p.weekKey) {
      p.prevWeekKey = p.weekKey;
      p.prevWeekXp = p.weekXp || 0;
    }
    p.weekKey = week;
    p.weekXp = 0;
  }
  const applied = Math.max(-(p.xp || 0), Math.round(amount));
  p.xp = (p.xp || 0) + applied;
  p.weekXp = Math.max(0, (p.weekXp || 0) + applied);
  return applied;
}

/** XP for ticking a practice problem, after the daily cap. Negative when un-ticking. Mutates the cap counter. */
export function practiceXp(user, difficulty, { daily = false, solved = true, now = Date.now() } = {}) {
  if (!user.practice) user.practice = {};
  const p = user.practice;
  const today = todayKey(now);
  if (p.practiceXpDay !== today) {
    p.practiceXpDay = today;
    p.practiceXpToday = 0;
  }
  const base = (XP_RULES.practice[difficulty] ?? XP_RULES.practice.Easy) * (daily ? XP_RULES.dailyProblemMultiplier : 1);
  if (!solved) {
    const back = Math.min(base, p.practiceXpToday || 0);
    p.practiceXpToday = (p.practiceXpToday || 0) - back;
    return -back;
  }
  const room = Math.max(0, XP_RULES.practiceDailyCap - (p.practiceXpToday || 0));
  const gained = Math.min(base, room);
  p.practiceXpToday = (p.practiceXpToday || 0) + gained;
  return gained;
}

/** XP a player earns from one finished battle or solo test. */
export function battleXp({ solves, difficultyOf, rank, score, players, tournament }) {
  let xp = solves.reduce((sum, s) => sum + (XP_RULES.battleSolve[difficultyOf(s.slug)] || 0), 0);
  if (players >= 2 && score > 0) {
    if (rank === 1) xp += XP_RULES.placement.win;
    else if (rank <= Math.ceil(players / 2)) xp += XP_RULES.placement.topHalf;
  }
  return Math.round(xp * (tournament ? XP_RULES.tournamentMultiplier : 1));
}

/** Records today's activity; returns the streak bonus XP to add (0 unless this is the first activity today at 3+ days). */
export function recordActivity(user, now = Date.now()) {
  const before = user.practice?.lastActiveDay;
  const streak = bumpStreak(user, now);
  const firstToday = before !== todayKey(now);
  return firstToday && streak >= XP_RULES.streakBonusFrom ? XP_RULES.streakBonus : 0;
}

/** Elo K-factor: new players move fast, established and top players move slowly. */
export function kFactor({ ratedEvents = 0, rating = 1200 } = {}) {
  if (ratedEvents < 10) return 40;
  if (rating >= 2000) return 16;
  return 24;
}
