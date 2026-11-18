import Match from '../models/Match.js';
import ScheduledEvent from '../models/ScheduledEvent.js';
import { config } from '../config.js';
import { createEventMatch, startEventMatch } from './matchEngine.js';
import { compareStanding } from './scoring.js';

// A public battle at the same time every day gathers players into one room while the community is small.
// On Sundays that slot becomes the Sunday Cup: longer, harder, and listed on the tournaments page.
export const OPEN_BEFORE_MS = 30 * 60 * 1000;

const DEFS = {
  daily: {
    name: () => 'Battle hour',
    settings: { durationMin: 45, easy: 1, medium: 2, hard: 0, pool: 'curated', maxPlayers: 20 },
  },
  cup: {
    name: (day) => `Sunday Cup · ${new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`,
    settings: { durationMin: 60, easy: 1, medium: 2, hard: 1, pool: 'curated', maxPlayers: 20 },
  },
};

export function parseStart(hhmm = config.events.startUtc) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return { h: Number.isFinite(h) ? h : 15, m: Number.isFinite(m) ? m : 30 };
}

/** The event scheduled on a given UTC day. */
export function eventOn(dayMs, start = parseStart()) {
  const d = new Date(dayMs);
  const day = d.toISOString().slice(0, 10);
  const kind = d.getUTCDay() === 0 ? 'cup' : 'daily';
  const startsAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), start.h, start.m));
  return {
    key: `${kind}-${day}`,
    kind,
    day,
    name: DEFS[kind].name(day),
    startsAt,
    opensAt: new Date(startsAt.getTime() - OPEN_BEFORE_MS),
    settings: DEFS[kind].settings,
  };
}

/** Next `count` events that have not started yet, optionally only of one kind. */
export function nextEvents(now = Date.now(), { kind = null, count = 1 } = {}) {
  const out = [];
  for (let i = 0; i < 14 && out.length < count; i += 1) {
    const e = eventOn(now + i * 86400000);
    if (e.startsAt.getTime() > now && (!kind || e.kind === kind)) out.push(e);
  }
  return out;
}

async function tick() {
  if (!config.events.enabled) return;
  const now = Date.now();
  const today = eventOn(now);
  // Open the lobby during the 30 minutes before the start.
  if (now >= today.opensAt.getTime() && now < today.startsAt.getTime()) {
    if (!(await Match.exists({ 'event.key': today.key }))) {
      await createEventMatch(today);
      console.log(`[events] opened ${today.key}`);
    }
  }
  // Planned tournaments open the same way.
  const planned = await ScheduledEvent.find({
    startsAt: { $gt: new Date(now), $lte: new Date(now + OPEN_BEFORE_MS) },
  }).lean();
  for (const e of planned) {
    if (await Match.exists({ 'event.key': e.key })) continue;
    try {
      await createEventMatch(plannedEvent(e));
      console.log(`[events] opened ${e.key}`);
    } catch (err) {
      console.warn(`[events] could not open ${e.key}:`, err.message);
    }
  }
  // Start (or close) any event lobby whose start time has passed, including after a restart.
  const due = await Match.find({ 'event.key': { $exists: true }, status: 'lobby', 'event.startsAt': { $lte: new Date(now) } })
    .select('code')
    .lean();
  for (const m of due) {
    await startEventMatch(m.code).catch((err) => console.warn(`[events] start ${m.code}:`, err.message));
  }
}

export function startEventScheduler() {
  const run = () => tick().catch((err) => console.warn('[events] tick failed:', err.message));
  run();
  setInterval(run, 30 * 1000);
}

export const plannedEvent = (e) => ({
  key: e.key,
  kind: 'special',
  name: e.name,
  description: e.description,
  startsAt: new Date(e.startsAt),
  opensAt: new Date(new Date(e.startsAt).getTime() - OPEN_BEFORE_MS),
  settings: { pool: 'curated', topics: [], maxPlayers: 20, ...(e.settings?.toObject?.() || e.settings) },
  seeded: !!e.seeded,
});

const publicEvent = (e, match) => ({
  key: e.key,
  kind: e.kind,
  name: e.name,
  description: e.description || null,
  startsAt: e.startsAt,
  opensAt: e.opensAt,
  settings: e.settings,
  code: match?.code || null,
  status: match?.status || 'scheduled',
  players: match ? match.participants.filter((p) => !p.left).length : 0,
});

/** The next battle hour and the next Sunday Cup, with their lobby if it is already open. */
export async function upcomingEvents(now = Date.now()) {
  const today = eventOn(now);
  const list = [];
  // Today's event stays "current" while it is open or running.
  const current = await Match.findOne({ 'event.key': today.key, status: { $in: ['lobby', 'countdown', 'live'] } });
  if (current) list.push(publicEvent(today, current));
  for (const e of nextEvents(now, { count: 2 })) if (!list.some((x) => x.key === e.key)) list.push(publicEvent(e, null));
  const cup = nextEvents(now, { kind: 'cup' })[0];
  if (cup && !list.some((x) => x.key === cup.key)) list.push(publicEvent(cup, null));

  // Planned tournaments: anything not finished yet, soonest first.
  const planned = await ScheduledEvent.find({ startsAt: { $gt: new Date(now - 4 * 60 * 60 * 1000) } }).sort({ startsAt: 1 }).limit(6).lean();
  const matches = await Match.find({ 'event.key': { $in: planned.map((p) => p.key) } }).lean();
  const byKey = new Map(matches.map((m) => [m.event.key, m]));
  for (const p of planned) {
    const m = byKey.get(p.key);
    if (m && ['finished', 'cancelled'].includes(m.status)) continue;
    if (!m && new Date(p.startsAt).getTime() <= now) continue;
    list.push(publicEvent(plannedEvent(p), m || null));
  }
  return list.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

/** Finished Sunday Cups and planned tournaments with their podium. */
export async function pastCups(limit = 10) {
  const cups = await Match.find({ 'event.kind': { $in: ['cup', 'special'] }, status: 'finished' }).sort({ finishedAt: -1 }).limit(limit);
  return cups.map((m) => ({
    code: m.code,
    kind: m.event.kind,
    name: m.name,
    finishedAt: m.finishedAt,
    players: m.participants.length,
    podium: [...m.participants]
      .sort(compareStanding)
      .slice(0, 3)
      .map((p) => ({ id: String(p.user), name: p.name, avatar: p.avatar, score: p.score, solved: p.solves.length })),
  }));
}
