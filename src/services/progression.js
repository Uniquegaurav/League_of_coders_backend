// Practice progression: XP, levels, and daily streaks. Pure helpers so they are easy to test.
export const XP = { Easy: 10, Medium: 25, Hard: 50 };
export const MATCH_XP = { perSolve: 15, win: 30 };

export function levelFor(xp = 0) {
  const n = Math.max(0, Number(xp) || 0);
  const level = Math.floor(Math.sqrt(n / 50)) + 1;
  return { level, levelXp: 50 * (level - 1) ** 2, nextLevelXp: 50 * level ** 2 };
}

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);
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
