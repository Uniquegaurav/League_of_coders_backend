import Match from '../models/Match.js';
import User from '../models/User.js';
import { MATCH_LIMITS, config } from '../config.js';
import { badRequest, conflict, forbidden, notFound, clampInt } from '../utils/http.js';
import { roomCode } from '../utils/random.js';
import { fetchRecentAccepted } from './leetcode.js';
import { selectProblems } from './questionBank.js';
import { assignRanks, compareStanding, ratingChanges, recomputeScores } from './scoring.js';

let io = null;
export const attachIo = (server) => {
  io = server;
};
export const roomOf = (code) => `match:${code}`;

// ---------------------------------------------------------------------------
// Presence (which users currently have the room open)
// ---------------------------------------------------------------------------
const presence = new Map(); // code -> Map<userId, socketCount>

export function setPresence(code, userId, delta) {
  if (!userId) return;
  const room = presence.get(code) || new Map();
  const next = (room.get(userId) || 0) + delta;
  if (next > 0) room.set(userId, next);
  else room.delete(userId);
  if (room.size) presence.set(code, room);
  else presence.delete(code);
  io?.to(roomOf(code)).emit('match:presence', { code, online: onlineUsers(code) });
}
export const onlineUsers = (code) => [...(presence.get(code)?.keys() || [])];

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------
const problemsVisible = (match) =>
  match.status === 'finished' || (match.status === 'live' && Date.now() >= new Date(match.startedAt).getTime());

export function serializeMessage(m) {
  return { id: m._id?.toString(), user: m.user?.toString() || null, name: m.name, kind: m.kind, text: m.text, at: m.at };
}

export function serializeMatch(match, { withMessages = false } = {}) {
  const online = new Set(onlineUsers(match.code));
  const showStandings = ['live', 'finished', 'countdown'].includes(match.status);
  const participants = [...match.participants];
  if (showStandings) participants.sort(compareStanding);

  return {
    code: match.code,
    name: match.name,
    host: match.host.toString(),
    visibility: match.visibility,
    status: match.status,
    settings: match.settings,
    startedAt: match.startedAt,
    endsAt: match.endsAt,
    finishedAt: match.finishedAt,
    rematchCode: match.rematchCode || null,
    serverNow: Date.now(),
    selection: match.status === 'lobby' ? null : match.selection,
    problems: problemsVisible(match) ? match.problems : [],
    problemCount: match.problems.length || match.settings.easy + match.settings.medium + match.settings.hard,
    participants: participants.map((p) => ({
      id: p.user.toString(),
      name: p.name,
      avatar: p.avatar,
      leetcode: p.leetcodeUsername,
      verified: !!p.leetcodeVerified,
      excludeSolved: p.excludeSolved,
      left: p.left,
      online: online.has(p.user.toString()),
      score: p.score,
      solves: p.solves.map((s) => ({ slug: s.slug, solvedAt: s.solvedAt, points: s.points, firstSolve: s.firstSolve })),
      rank: p.rank ?? null,
      ratingBefore: p.ratingBefore ?? null,
      ratingAfter: p.ratingAfter ?? null,
    })),
    ...(withMessages ? { messages: match.messages.map(serializeMessage) } : {}),
  };
}

export function summarizeMatch(match) {
  const host = match.participants.find((p) => String(p.user) === String(match.host));
  const winner = match.status === 'finished' ? [...match.participants].sort(compareStanding)[0] : null;
  return {
    code: match.code,
    name: match.name,
    status: match.status,
    visibility: match.visibility,
    hostName: host?.name || 'Unknown',
    players: match.participants.filter((p) => !p.left).length,
    maxPlayers: match.settings.maxPlayers,
    settings: match.settings,
    startedAt: match.startedAt,
    endsAt: match.endsAt,
    finishedAt: match.finishedAt,
    createdAt: match.createdAt,
    winner: winner && winner.score > 0 ? { id: String(winner.user), name: winner.name, score: winner.score } : null,
  };
}

// ---------------------------------------------------------------------------
// Per-match serialisation of writes (single server instance)
// ---------------------------------------------------------------------------
const locks = new Map();

async function withLock(code, fn) {
  const prev = locks.get(code) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => current);
  locks.set(code, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(code) === tail) locks.delete(code);
  }
}

/** Loads a match, applies `fn`, saves, then pushes the new state (and any new messages) to the room. */
async function mutate(code, fn) {
  return withLock(code, async () => {
    const match = await Match.findOne({ code });
    if (!match) throw notFound('Match not found');
    const outbox = [];
    const say = (text, kind = 'system', user = null) => {
      match.messages.push({ text, kind, user: user?._id, name: user?.name });
      outbox.push(match.messages[match.messages.length - 1]);
    };
    const result = await fn(match, say);
    if (match.messages.length > MATCH_LIMITS.chatHistory) {
      match.messages.splice(0, match.messages.length - MATCH_LIMITS.chatHistory);
    }
    await match.save();
    if (io) {
      io.to(roomOf(code)).emit('match:update', serializeMatch(match));
      outbox.forEach((m) => io.to(roomOf(code)).emit('match:message', { code, message: serializeMessage(m) }));
    }
    return result ?? match;
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export function normalizeSettings(input = {}, prev = {}) {
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : prev[key] ?? fallback);
  const settings = {
    durationMin: clampInt(pick('durationMin', 45), MATCH_LIMITS.minDuration, MATCH_LIMITS.maxDuration, 45),
    easy: clampInt(pick('easy', 1), 0, MATCH_LIMITS.maxPerDifficulty, 1),
    medium: clampInt(pick('medium', 2), 0, MATCH_LIMITS.maxPerDifficulty, 2),
    hard: clampInt(pick('hard', 0), 0, MATCH_LIMITS.maxPerDifficulty, 0),
    pool: pick('pool', 'curated') === 'all' ? 'all' : 'curated',
    topics: (Array.isArray(pick('topics', [])) ? pick('topics', []) : [])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().slice(0, 50))
      .slice(0, 12),
    maxPlayers: clampInt(pick('maxPlayers', 8), 2, MATCH_LIMITS.maxPlayers, 8),
  };
  const total = settings.easy + settings.medium + settings.hard;
  if (total < 1) throw badRequest('Pick at least one problem');
  if (total > MATCH_LIMITS.maxProblems) throw badRequest(`A match can have at most ${MATCH_LIMITS.maxProblems} problems`);
  return settings;
}

const participantFrom = (user) => ({
  user: user._id,
  name: user.name,
  avatar: user.avatar || user.leetcode?.avatar,
  leetcodeUsername: user.leetcode.displayName || user.leetcode.username,
  leetcodeVerified: !!user.leetcode.verified,
});

const requireLeetCode = (user) => {
  if (!user.leetcode?.username) {
    throw badRequest('Link your LeetCode username in your profile first — it is how solves are verified.');
  }
};

const findParticipant = (match, userId) => match.participants.find((p) => String(p.user) === String(userId));
const activeParticipants = (match) => match.participants.filter((p) => !p.left);
const isHost = (match, userId) => String(match.host) === String(userId);

// ---------------------------------------------------------------------------
// Lobby actions
// ---------------------------------------------------------------------------
export async function createMatch(user, input = {}) {
  requireLeetCode(user);
  const openHosted = await Match.countDocuments({ host: user._id, status: 'lobby' });
  if (openHosted >= 3) throw conflict('You already have 3 open lobbies. Start or leave one first.');

  const settings = normalizeSettings(input.settings || input);
  let code;
  for (let i = 0; i < 5 && !code; i += 1) {
    const candidate = roomCode();
    if (!(await Match.exists({ code: candidate }))) code = candidate;
  }
  if (!code) throw conflict('Could not allocate a room code, try again');

  const match = await Match.create({
    code,
    name: (input.name || `${user.name.split(' ')[0]}'s battle`).toString().trim().slice(0, 60),
    host: user._id,
    visibility: input.visibility === 'private' ? 'private' : 'public',
    settings,
    participants: [participantFrom(user)],
    messages: [{ kind: 'system', text: `${user.name} created the lobby` }],
  });
  return match;
}

export function joinMatch(code, user) {
  return mutate(code, (match, say) => {
    const existing = findParticipant(match, user._id);
    if (existing && !existing.left) return match;
    if (existing && existing.left) {
      if (match.status === 'finished' || match.status === 'cancelled') throw badRequest('This match is over');
      existing.left = false;
      say(`${user.name} is back`);
      return match;
    }
    if (match.status !== 'lobby') throw badRequest('This match has already started — you can still spectate.');
    requireLeetCode(user);
    if (activeParticipants(match).length >= match.settings.maxPlayers) throw badRequest('Lobby is full');
    match.participants.push(participantFrom(user));
    say(`${user.name} joined`);
    return match;
  });
}

export function leaveMatch(code, userId) {
  return mutate(code, (match, say) => {
    const participant = findParticipant(match, userId);
    if (!participant || participant.left) return match;
    if (match.status === 'finished' || match.status === 'cancelled') return match;

    if (match.status === 'lobby') {
      match.participants = match.participants.filter((p) => String(p.user) !== String(userId));
      say(`${participant.name} left`);
    } else {
      participant.left = true;
      say(`${participant.name} forfeited`);
    }

    const remaining = activeParticipants(match);
    if (isHost(match, userId) && remaining.length) {
      match.host = remaining[0].user;
      say(`${remaining[0].name} is now the host`);
    }
    if (!remaining.length) {
      if (match.status === 'lobby') match.status = 'cancelled';
      else finishInPlace(match, say);
    }
    return match;
  }).then(async (match) => {
    if (match.status === 'finished') await afterFinish(match);
    return match;
  });
}

export function kickParticipant(code, hostId, targetId) {
  return mutate(code, (match, say) => {
    if (!isHost(match, hostId)) throw forbidden('Only the host can remove players');
    if (match.status !== 'lobby') throw badRequest('Players can only be removed before the match starts');
    if (String(hostId) === String(targetId)) throw badRequest('Use "Leave" to leave your own lobby');
    const target = findParticipant(match, targetId);
    if (!target) return match;
    match.participants = match.participants.filter((p) => String(p.user) !== String(targetId));
    say(`${target.name} was removed by the host`);
    return match;
  });
}

export function updateSettings(code, userId, input) {
  return mutate(code, (match, say) => {
    if (!isHost(match, userId)) throw forbidden('Only the host can change settings');
    if (match.status !== 'lobby') throw badRequest('Settings are locked once the match starts');
    match.settings = normalizeSettings(input.settings || input, match.settings.toObject());
    if (input.name !== undefined) match.name = String(input.name).trim().slice(0, 60) || match.name;
    if (input.visibility) match.visibility = input.visibility === 'private' ? 'private' : 'public';
    if (match.participants.length > match.settings.maxPlayers) {
      throw badRequest(`There are already ${match.participants.length} players in the lobby`);
    }
    say('Host updated the match settings');
    return match;
  });
}

export function setPreferences(code, userId, { excludeSolved }) {
  return mutate(code, (match) => {
    const participant = findParticipant(match, userId);
    if (!participant) throw forbidden('You are not in this match');
    if (match.status !== 'lobby') throw badRequest('Preferences are locked once the match starts');
    if (typeof excludeSolved === 'boolean') participant.excludeSolved = excludeSolved;
    return match;
  });
}

const lastChat = new Map();

export function postMessage(code, user, rawText) {
  const text = String(rawText || '').trim().slice(0, 500);
  if (!text) throw badRequest('Message is empty');
  const key = String(user._id);
  if (Date.now() - (lastChat.get(key) || 0) < 600) throw badRequest('Slow down a little');
  lastChat.set(key, Date.now());
  return mutate(code, (match, say) => {
    say(text, 'chat', user);
    return match;
  });
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------
const timers = new Map(); // code -> { start, end }
const liveCodes = new Set();

function clearTimers(code) {
  const t = timers.get(code);
  if (t) {
    clearTimeout(t.start);
    clearTimeout(t.end);
  }
  timers.delete(code);
  liveCodes.delete(code);
}

function schedule(match) {
  clearTimers(match.code);
  const now = Date.now();
  const startIn = Math.max(0, new Date(match.startedAt).getTime() - now);
  const endIn = Math.max(0, new Date(match.endsAt).getTime() - now);
  liveCodes.add(match.code);
  timers.set(match.code, {
    start:
      match.status === 'countdown'
        ? setTimeout(() => goLive(match.code).catch((e) => console.error('[engine] go live', e)), startIn)
        : null,
    // setTimeout overflows above ~24.8 days; durations are capped at 3h so this is safe.
    end: setTimeout(() => finishMatch(match.code).catch((e) => console.error('[engine] finish', e)), endIn),
  });
}

async function buildExclusions(match) {
  const optedIn = activeParticipants(match).filter((p) => p.excludeSolved);
  if (!optedIn.length) return new Set();
  const users = await User.find({ _id: { $in: optedIn.map((p) => p.user) } }).select('solvedSlugs').lean();
  const slugs = new Set(users.flatMap((u) => u.solvedSlugs || []));
  const recent = await Promise.allSettled(optedIn.map((p) => fetchRecentAccepted(p.leetcodeUsername)));
  recent.forEach((r) => r.status === 'fulfilled' && r.value.forEach((s) => slugs.add(s.slug)));
  return slugs;
}

export async function startMatch(code, userId) {
  // Exclusions need network calls, so gather them before taking the lock.
  const snapshot = await Match.findOne({ code });
  if (!snapshot) throw notFound('Match not found');
  if (!isHost(snapshot, userId)) throw forbidden('Only the host can start the match');
  if (snapshot.status !== 'lobby') throw badRequest('Match already started');
  const exclude = await buildExclusions(snapshot);

  const match = await mutate(code, async (m, say) => {
    if (m.status !== 'lobby') throw badRequest('Match already started');
    if (!activeParticipants(m).length) throw badRequest('Nobody is in the lobby');
    const { problems, ...selection } = await selectProblems(m.settings, exclude);
    m.problems = problems;
    m.selection = selection;
    m.status = 'countdown';
    m.startedAt = new Date(Date.now() + MATCH_LIMITS.countdownMs);
    m.endsAt = new Date(m.startedAt.getTime() + m.settings.durationMin * 60 * 1000);
    m.participants.forEach((p) => {
      p.score = 0;
      p.solves = [];
    });
    say(
      selection.reusedSolved
        ? `Problems locked in. ${selection.reusedSolved} problem(s) had to be reused because everyone had solved the rest.`
        : 'Problems locked in. Get ready!'
    );
    return m;
  });
  schedule(match);
  return match;
}

function goLive(code) {
  return mutate(code, (match, say) => {
    if (match.status !== 'countdown') return match;
    match.status = 'live';
    say('Match is live — good luck!');
    return match;
  });
}

function applyAccepted(match, participant, accepted, say) {
  const start = new Date(match.startedAt).getTime();
  const end = new Date(match.endsAt).getTime();
  const inMatch = new Map(match.problems.map((p) => [p.slug, p]));
  const already = new Set(participant.solves.map((s) => s.slug));
  const added = [];

  const earliest = new Map();
  for (const sub of accepted) {
    const t = sub.solvedAt.getTime();
    if (!inMatch.has(sub.slug) || already.has(sub.slug) || t < start || t > end) continue;
    if (!earliest.has(sub.slug) || t < earliest.get(sub.slug)) earliest.set(sub.slug, t);
  }
  for (const [slug, t] of earliest) {
    participant.solves.push({ slug, solvedAt: new Date(t) });
    added.push(slug);
  }
  participant.lastCheckedAt = new Date();
  if (added.length) {
    recomputeScores(match);
    for (const slug of added) {
      const solve = participant.solves.find((s) => s.slug === slug);
      say(
        `${participant.name} solved ${inMatch.get(slug).title} (+${solve.points}${solve.firstSolve ? ', first solve!' : ''})`,
        'solve'
      );
    }
  }
  return added;
}

const everyoneDone = (match) => {
  const active = activeParticipants(match);
  return active.length > 0 && active.every((p) => p.solves.length >= match.problems.length);
};

async function collectAccepted(participants) {
  const results = await Promise.allSettled(participants.map((p) => fetchRecentAccepted(p.leetcodeUsername)));
  return participants.map((p, i) => ({
    userId: String(p.user),
    accepted: results[i].status === 'fulfilled' ? results[i].value : null,
  }));
}

/** Checks LeetCode for every active player (or just `onlyUserId`) and records new solves. */
async function pollMatch(code, { onlyUserId = null, finalSweep = false } = {}) {
  const snapshot = await Match.findOne({ code }).lean();
  if (!snapshot || !['live', 'countdown'].includes(snapshot.status)) return { added: [] };
  if (!finalSweep && Date.now() < new Date(snapshot.startedAt).getTime()) return { added: [] };

  const targets = snapshot.participants.filter(
    (p) =>
      !p.left &&
      p.solves.length < snapshot.problems.length &&
      (!onlyUserId || String(p.user) === String(onlyUserId))
  );
  if (!targets.length) return { added: [] };
  const fetched = await collectAccepted(targets);

  let added = [];
  let finishNow = false;
  await mutate(code, (match, say) => {
    if (!['live', 'countdown'].includes(match.status)) return match;
    for (const { userId, accepted } of fetched) {
      if (!accepted) continue;
      const participant = findParticipant(match, userId);
      if (participant) added = added.concat(applyAccepted(match, participant, accepted, say));
    }
    match.markModified('participants');
    finishNow = !finalSweep && everyoneDone(match);
    return match;
  });
  if (finishNow) await finishMatch(code);
  return { added };
}

const lastManualCheck = new Map();

export async function checkNow(code, userId) {
  const key = `${code}:${userId}`;
  const last = lastManualCheck.get(key) || 0;
  const wait = MATCH_LIMITS.verifyCooldownMs - (Date.now() - last);
  if (wait > 0) throw badRequest(`Checked a moment ago — try again in ${Math.ceil(wait / 1000)}s`);
  lastManualCheck.set(key, Date.now());
  const match = await Match.findOne({ code }).select('participants status').lean();
  if (!match) throw notFound('Match not found');
  if (!findParticipant(match, userId)) throw forbidden('You are not playing in this match');
  if (match.status !== 'live') throw badRequest('The match is not live');
  return pollMatch(code, { onlyUserId: userId });
}

function finishInPlace(match, say) {
  recomputeScores(match);
  assignRanks(match.participants);
  match.status = 'finished';
  match.finishedAt = new Date();
  match.markModified('participants');
  const winner = [...match.participants].sort(compareStanding)[0];
  say(winner && winner.score > 0 ? `Time! ${winner.name} wins with ${winner.score} points 🏆` : 'Match over');
}

export async function finishMatch(code, { byUserId = null } = {}) {
  if (byUserId) {
    const m = await Match.findOne({ code }).select('host status').lean();
    if (!m) throw notFound('Match not found');
    if (!isHost(m, byUserId)) throw forbidden('Only the host can end the match');
  }
  clearTimers(code);
  // Catch submissions accepted right before the buzzer.
  await pollMatch(code, { finalSweep: true }).catch((e) => console.warn('[engine] final sweep', e.message));

  let finished = false;
  const match = await mutate(code, (m, say) => {
    if (!['live', 'countdown'].includes(m.status)) return m;
    if (byUserId) say('Host ended the match early');
    finishInPlace(m, say);
    finished = true;
    return m;
  });
  if (finished) await afterFinish(match);
  return match;
}

/** Updates ratings and career stats once a match is over. */
async function afterFinish(match) {
  clearTimers(match.code);
  const ids = match.participants.map((p) => p.user);
  const users = await User.find({ _id: { $in: ids } }).select('stats');
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const rated = match.participants.length >= 2;

  const players = match.participants.map((p) => ({
    rating: byId.get(String(p.user))?.stats.rating ?? 1200,
    rank: p.rank ?? match.participants.length,
  }));
  const deltas = rated ? ratingChanges(players) : players.map(() => 0);

  await withLock(match.code, async () => {
    const fresh = await Match.findOne({ code: match.code });
    fresh.participants.forEach((p, i) => {
      p.ratingBefore = players[i].rating;
      p.ratingAfter = players[i].rating + deltas[i];
    });
    fresh.markModified('participants');
    await fresh.save();
    io?.to(roomOf(match.code)).emit('match:update', serializeMatch(fresh));
  });

  await User.bulkWrite(
    match.participants.map((p, i) => ({
      updateOne: {
        filter: { _id: p.user },
        update: {
          $inc: {
            'stats.matches': 1,
            'stats.wins': rated && p.rank === 1 && p.score > 0 ? 1 : 0,
            'stats.points': p.score,
            'stats.solved': p.solves.length,
            'stats.rating': deltas[i],
          },
          $addToSet: { solvedSlugs: { $each: p.solves.map((s) => s.slug) } },
        },
      },
    }))
  );
}

export async function rematch(code, user) {
  const old = await Match.findOne({ code });
  if (!old) throw notFound('Match not found');
  if (old.status !== 'finished') throw badRequest('The match is not over yet');
  if (old.rematchCode) return Match.findOne({ code: old.rematchCode });
  if (!findParticipant(old, user._id)) throw forbidden('Only players can start a rematch');

  const next = await createMatch(user, {
    name: old.name,
    visibility: old.visibility,
    settings: old.settings.toObject(),
  });
  await mutate(code, (m, say) => {
    m.rematchCode = next.code;
    say(`${user.name} opened a rematch lobby`);
    return m;
  });
  return next;
}

// ---------------------------------------------------------------------------
// Boot / background work
// ---------------------------------------------------------------------------
const polling = new Set();
const STALE_LOBBY_MS = 3 * 60 * 60 * 1000;

export async function recoverMatches() {
  const running = await Match.find({ status: { $in: ['countdown', 'live'] } });
  for (const match of running) {
    if (Date.now() >= new Date(match.endsAt).getTime()) {
      finishMatch(match.code).catch((e) => console.error('[engine] recover finish', e));
    } else {
      schedule(match);
      if (match.status === 'countdown' && Date.now() >= new Date(match.startedAt).getTime()) {
        goLive(match.code).catch(() => {});
      }
    }
  }
  if (running.length) console.log(`[engine] recovered ${running.length} running match(es)`);
}

export function startBackgroundJobs() {
  setInterval(() => {
    for (const code of liveCodes) {
      if (polling.has(code)) continue;
      polling.add(code);
      pollMatch(code)
        .catch((e) => console.warn(`[engine] poll ${code}:`, e.message))
        .finally(() => polling.delete(code));
    }
  }, config.pollIntervalMs);

  setInterval(() => {
    Match.updateMany(
      { status: 'lobby', updatedAt: { $lt: new Date(Date.now() - STALE_LOBBY_MS) } },
      { $set: { status: 'cancelled' } }
    ).catch(() => {});
  }, 10 * 60 * 1000);
}
