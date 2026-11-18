import Match from '../models/Match.js';
import User from '../models/User.js';
import Challenge from '../models/Challenge.js';
import { battleFacts, grantBadges } from './badges.js';
import { MATCH_LIMITS, config } from '../config.js';
import { badRequest, conflict, forbidden, notFound, clampInt } from '../utils/http.js';
import { roomCode } from '../utils/random.js';
import { fetchRecentAccepted } from './leetcode.js';
import { selectProblems } from './questionBank.js';
import { addXp, battleXp, kFactor, recordActivity } from './progression.js';
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

// Finished matches record whether they were rated. Older ones (before tournaments-only rating) were rated with 2+ players.
const matchRated = (match) =>
  match.status === 'finished' ? match.rated ?? match.participants.length >= 2 : !!match.event?.key;

export function serializeMatch(match, { withMessages = false } = {}) {
  const online = new Set(onlineUsers(match.code));
  const showStandings = ['live', 'finished', 'countdown'].includes(match.status);
  const participants = [...match.participants];
  if (showStandings) participants.sort(compareStanding);

  return {
    code: match.code,
    name: match.name,
    host: match.host ? match.host.toString() : null,
    event: match.event?.key ? { kind: match.event.kind, startsAt: match.event.startsAt, description: match.event.description || null } : null,
    challengeCode: match.challengeCode || null,
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
      xp: p.xp ?? null,
    })),
    rated: matchRated(match),
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
    hostName: match.event?.key ? 'League of Coders' : host?.name || 'Unknown',
    event: match.event?.key ? { kind: match.event.kind, startsAt: match.event.startsAt } : null,
    players: match.participants.filter((p) => !p.left).length,
    maxPlayers: match.settings.maxPlayers,
    settings: match.settings,
    startedAt: match.startedAt,
    endsAt: match.endsAt,
    finishedAt: match.finishedAt,
    createdAt: match.createdAt,
    winner: winner && winner.score > 0 ? { id: String(winner.user), name: winner.name, avatar: winner.avatar || null, score: winner.score } : null,
    rated: matchRated(match),
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
// Minutes granted per problem in a solo test. Keep in sync with src/lib/soloTime.js on the frontend.
export const SOLO_MINUTES = { easy: 10, medium: 20, hard: 35 };

export function soloDurationMin({ easy = 0, medium = 0, hard = 0 }) {
  const raw = easy * SOLO_MINUTES.easy + medium * SOLO_MINUTES.medium + hard * SOLO_MINUTES.hard;
  return clampInt(raw, MATCH_LIMITS.minDuration, MATCH_LIMITS.maxDuration, MATCH_LIMITS.minDuration);
}

export function normalizeSettings(input = {}, prev = {}) {
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : prev[key] ?? fallback);
  const solo = pick('solo', false) === true;
  const easy = clampInt(pick('easy', 1), 0, MATCH_LIMITS.maxPerDifficulty, 1);
  const medium = clampInt(pick('medium', 2), 0, MATCH_LIMITS.maxPerDifficulty, 2);
  const hard = clampInt(pick('hard', 0), 0, MATCH_LIMITS.maxPerDifficulty, 0);
  const settings = {
    durationMin: solo
      ? soloDurationMin({ easy, medium, hard })
      : clampInt(pick('durationMin', 45), MATCH_LIMITS.minDuration, MATCH_LIMITS.maxDuration, 45),
    easy,
    medium,
    hard,
    pool: pick('pool', 'curated') === 'all' ? 'all' : 'curated',
    topics: (Array.isArray(pick('topics', [])) ? pick('topics', []) : [])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().slice(0, 50))
      .slice(0, 12),
    maxPlayers: solo ? 1 : clampInt(pick('maxPlayers', 8), 2, MATCH_LIMITS.maxPlayers, 8),
    solo,
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
    throw badRequest('Link your LeetCode account in your profile first. That is how solves are verified.');
  }
  if (!user.leetcode.verified) {
    throw badRequest('Verify your LeetCode account in your profile before competing. It proves the solves are yours.');
  }
};

const findParticipant = (match, userId) => match.participants.find((p) => String(p.user) === String(userId));
const activeParticipants = (match) => match.participants.filter((p) => !p.left);
const isHost = (match, userId) => !!match.host && String(match.host) === String(userId);

// ---------------------------------------------------------------------------
// Lobby actions
// ---------------------------------------------------------------------------
export async function createMatch(user, input = {}, { challenge = null } = {}) {
  requireLeetCode(user);
  const openHosted = await Match.countDocuments({ host: user._id, status: 'lobby' });
  if (openHosted >= 3) throw conflict('You already have 3 open lobbies. Start or leave one first.');

  const settings = normalizeSettings(input.settings || input);
  // A challenge attempt keeps the challenge's clock so every attempt is scored the same way.
  if (challenge) settings.durationMin = clampInt(challenge.durationMin, MATCH_LIMITS.minDuration, MATCH_LIMITS.maxDuration, settings.durationMin);
  let code;
  for (let i = 0; i < 5 && !code; i += 1) {
    const candidate = roomCode();
    if (!(await Match.exists({ code: candidate }))) code = candidate;
  }
  if (!code) throw conflict('Could not allocate a room code, try again');

  const match = await Match.create({
    code,
    name: (input.name || `${user.name.split(' ')[0]}'s ${settings.solo ? 'test' : 'battle'}`).toString().trim().slice(0, 60),
    host: user._id,
    visibility: settings.solo || input.visibility === 'private' ? 'private' : 'public',
    settings,
    challengeCode: challenge?.code,
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
    if (match.status !== 'lobby') throw badRequest('This match has already started. You can still spectate.');
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
      // Scheduled lobbies stay open until their start time even if everyone steps out.
      if (match.status === 'lobby') {
        if (!match.event?.key) match.status = 'cancelled';
      }
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
    if (match.challengeCode) throw badRequest('Challenge attempts use the challenge settings');
    if (match.status !== 'lobby') throw badRequest('Settings are locked once the match starts');
    match.settings = normalizeSettings(input.settings || input, match.settings.toObject());
    if (input.name !== undefined) match.name = String(input.name).trim().slice(0, 60) || match.name;
    if (match.settings.solo) match.visibility = 'private';
    else if (input.visibility) match.visibility = input.visibility === 'private' ? 'private' : 'public';
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

async function presetProblems(match) {
  if (!match.challengeCode) return null;
  const challenge = await Challenge.findOne({ code: match.challengeCode }).lean();
  if (!challenge) throw notFound('That challenge no longer exists');
  return { problems: challenge.problems, poolSize: challenge.problems.length, excludedCount: 0, reusedSolved: 0 };
}

/** Starts a lobby. `system: true` is used by the scheduler for events that have no host. */
export async function startMatch(code, userId, { system = false } = {}) {
  // Exclusions need network calls, so gather them before taking the lock.
  const snapshot = await Match.findOne({ code });
  if (!snapshot) throw notFound('Match not found');
  if (!system && !isHost(snapshot, userId)) {
    throw forbidden(snapshot.event?.key ? 'This battle starts automatically at its scheduled time' : 'Only the host can start the match');
  }
  if (snapshot.status !== 'lobby') throw badRequest('Match already started');
  const preset = await presetProblems(snapshot);
  const exclude = preset ? new Set() : await buildExclusions(snapshot);

  const match = await mutate(code, async (m, say) => {
    if (m.status !== 'lobby') throw badRequest('Match already started');
    if (!activeParticipants(m).length) throw badRequest('Nobody is in the lobby');
    const { problems, ...selection } = preset || (await selectProblems(m.settings, exclude));
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
    say('Match is live. Good luck.');
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

async function collectAccepted(participants, { fresh = false } = {}) {
  const results = await Promise.allSettled(participants.map((p) => fetchRecentAccepted(p.leetcodeUsername, { fresh })));
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
  // The final sweep and manual checks never reuse a request that started before the solve.
  const fetched = await collectAccepted(targets, { fresh: finalSweep || !!onlyUserId });

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
  if (wait > 0) throw badRequest(`Checked a moment ago. Try again in ${Math.ceil(wait / 1000)}s`);
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

/** True when a match moves rating: an official tournament (battle hour, Sunday Cup, planned) with 2+ players. */
export const isRatedMatch = (match) => !!match.event?.key && match.participants.length >= 2;

/**
 * Updates rating, career stats and XP once a match is over.
 * Rating only moves in official tournaments; every battle and solo test earns XP.
 */
async function afterFinish(match) {
  clearTimers(match.code);
  const ids = match.participants.map((p) => p.user);
  const users = await User.find({ _id: { $in: ids } }).select('stats');
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const multiplayer = match.participants.length >= 2;
  const rated = isRatedMatch(match);

  const players = match.participants.map((p) => {
    const stats = byId.get(String(p.user))?.stats;
    const rating = stats?.rating ?? 1200;
    return { rating, rank: p.rank ?? match.participants.length, k: kFactor({ ratedEvents: stats?.ratedEvents || 0, rating }) };
  });
  const deltas = rated ? ratingChanges(players) : players.map(() => 0);

  await withLock(match.code, async () => {
    const fresh = await Match.findOne({ code: match.code });
    fresh.rated = rated;
    fresh.participants.forEach((p, i) => {
      // Unrated battles keep no rating numbers, so nothing suggests they moved it.
      p.ratingBefore = rated ? players[i].rating : undefined;
      p.ratingAfter = rated ? players[i].rating + deltas[i] : undefined;
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
            'stats.wins': multiplayer && p.rank === 1 && p.score > 0 ? 1 : 0,
            'stats.points': p.score,
            'stats.solved': p.solves.length,
            'stats.rating': deltas[i],
            'stats.ratedEvents': rated ? 1 : 0,
          },
          $addToSet: { solvedSlugs: { $each: p.solves.map((s) => s.slug) } },
        },
      },
    }))
  );

  awardMatchXp(match)
    .then(() => awardBattleBadges(match.code))
    .then(() => rewardReferrals(match))
    .catch((err) => console.error('Match rewards failed', err));
  if (match.challengeCode) recordChallengeAttempt(match).catch((err) => console.error('Challenge attempt update failed', err));
}

/** Badges earned in this battle. Reads the saved match so rating before/after is present. */
async function awardBattleBadges(code) {
  const match = await Match.findOne({ code });
  if (!match) return;
  const users = await User.find({ _id: { $in: match.participants.map((p) => p.user) } });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  await Promise.all(
    match.participants.map(async (p) => {
      const user = byId.get(String(p.user));
      if (!user) return;
      if (grantBadges(user, battleFacts(match, p)).length) await user.save();
    })
  );
}

export const REFERRAL = { xp: 100, maxRewarded: 25 };

/**
 * Pays the referral reward once a referred player finishes their first battle with at least one accepted solve.
 * Signing up alone earns nothing, so throwaway accounts cannot farm it.
 */
async function rewardReferrals(match) {
  for (const p of match.participants) {
    if (!p.solves.length) continue;
    // Claim the reward atomically first, so it can only ever be paid once.
    const user = await User.findOneAndUpdate(
      { _id: p.user, referredBy: { $exists: true }, referralRewarded: { $ne: true } },
      { $set: { referralRewarded: true } },
      { new: true }
    );
    if (!user) continue;
    addXp(user, REFERRAL.xp);
    await user.save();
    const referrer = await User.findOneAndUpdate(
      { _id: user.referredBy, referralCount: { $lt: REFERRAL.maxRewarded } },
      { $inc: { referralCount: 1 } },
      { new: true }
    );
    if (!referrer) continue;
    addXp(referrer, REFERRAL.xp);
    grantBadges(referrer);
    await referrer.save();
  }
}

async function recordChallengeAttempt(match) {
  const fresh = await Match.findOne({ code: match.code }).lean();
  const p = fresh?.participants[0];
  if (!p) return;
  await Challenge.updateOne(
    { code: fresh.challengeCode, 'attempts.matchCode': fresh.code },
    {
      $set: {
        'attempts.$.status': 'done',
        'attempts.$.score': p.score,
        'attempts.$.solved': p.solves.length,
        'attempts.$.finishedAt': fresh.finishedAt || new Date(),
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Scheduled events (battle hour, Sunday Cup)
// ---------------------------------------------------------------------------
export async function createEventMatch({ key, kind, name, description, startsAt, settings, seeded = false }) {
  let code;
  for (let i = 0; i < 5 && !code; i += 1) {
    const candidate = roomCode();
    if (!(await Match.exists({ code: candidate }))) code = candidate;
  }
  if (!code) throw conflict('Could not allocate a room code');
  try {
    return await Match.create({
      code,
      name,
      visibility: 'public',
      settings: normalizeSettings(settings),
      participants: [],
      event: { key, kind, startsAt, description },
      seeded: !!seeded,
      messages: [{ kind: 'system', text: `${name} is open. It starts automatically at the scheduled time.` }],
    });
  } catch (err) {
    if (err.code === 11000) return Match.findOne({ 'event.key': key });
    throw err;
  }
}

/** Called at an event's start time: starts it with 2+ players, otherwise closes the lobby. */
export async function startEventMatch(code) {
  const match = await Match.findOne({ code }).select('status participants').lean();
  if (!match || match.status !== 'lobby') return match;
  const close = (text) =>
    mutate(code, (m, say) => {
      if (m.status !== 'lobby') return m;
      m.status = 'cancelled';
      say(text);
      return m;
    });
  if (match.participants.filter((p) => !p.left).length < 2) return close('Not enough players joined this time. See you at the next one.');
  try {
    return await startMatch(code, null, { system: true });
  } catch (err) {
    // e.g. the topic pool is too small: close the lobby instead of retrying forever.
    console.warn(`[events] could not start ${code}:`, err.message);
    return close(`This event could not start: ${err.message}`);
  }
}

/** XP and streaks for battle play (see progression.XP_RULES). Best effort: never blocks or fails a finish. */
async function awardMatchXp(match) {
  const users = await User.find({ _id: { $in: match.participants.map((p) => p.user) } });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const difficulty = new Map(match.problems.map((p) => [p.slug, p.difficulty]));
  const earned = new Map();
  await Promise.all(
    match.participants.map(async (p) => {
      const user = byId.get(String(p.user));
      if (!user || !p.solves.length) return;
      const xp =
        battleXp({
          solves: p.solves,
          difficultyOf: (slug) => difficulty.get(slug),
          rank: p.rank,
          score: p.score,
          players: match.participants.length,
          tournament: !!match.event?.key,
        }) + recordActivity(user);
      earned.set(String(p.user), addXp(user, xp));
      await user.save();
    })
  );
  if (!earned.size) return;
  await withLock(match.code, async () => {
    const fresh = await Match.findOne({ code: match.code });
    if (!fresh) return;
    fresh.participants.forEach((p) => {
      if (earned.has(String(p.user))) p.xp = earned.get(String(p.user));
    });
    fresh.markModified('participants');
    await fresh.save();
    io?.to(roomOf(match.code)).emit('match:update', serializeMatch(fresh));
  });
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
