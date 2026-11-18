import { Router } from 'express';
import Challenge from '../models/Challenge.js';
import Match from '../models/Match.js';
import User from '../models/User.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../utils/http.js';
import { roomCode } from '../utils/random.js';
import { createMatch } from '../services/matchEngine.js';
import { pointsFor } from '../services/scoring.js';

// Async "beat my score" challenges: built from a finished match, attempted solo by anyone with the link.
const router = Router();
const codeOf = (req) => String(req.params.code || '').toUpperCase();

/** The creator's score re-computed as if their run had been a solo attempt, so every attempt is scored alike. */
export function soloScore(match, participant) {
  const startedAt = new Date(match.startedAt).getTime();
  const endsAt = startedAt + match.settings.durationMin * 60 * 1000;
  const base = new Map(match.problems.map((p) => [p.slug, p.basePoints]));
  return participant.solves.reduce((sum, s) => {
    const solvedAt = new Date(s.solvedAt).getTime();
    if (!base.has(s.slug) || solvedAt > endsAt) return sum;
    return sum + pointsFor({ basePoints: base.get(s.slug), solvedAt, startedAt, endsAt, firstSolve: true });
  }, 0);
}

const mix = (problems) => ({
  easy: problems.filter((p) => p.difficulty === 'Easy').length,
  medium: problems.filter((p) => p.difficulty === 'Medium').length,
  hard: problems.filter((p) => p.difficulty === 'Hard').length,
});

function serialize(challenge, viewerId) {
  const viewer = viewerId ? String(viewerId) : null;
  const mine = viewer ? challenge.attempts.find((a) => String(a.user) === viewer) : null;
  const creatorAttempt = challenge.attempts.find((a) => String(a.user) === String(challenge.creator));
  // Problem titles stay hidden until you have finished your attempt, so nobody can prepare.
  const showProblems = !!mine && mine.status === 'done';
  const ranked = challenge.attempts
    .filter((a) => a.status === 'done')
    .sort((a, b) => b.score - a.score || new Date(a.finishedAt) - new Date(b.finishedAt));
  return {
    code: challenge.code,
    name: challenge.name,
    durationMin: challenge.durationMin,
    mix: mix(challenge.problems),
    creator: { id: String(challenge.creator), name: creatorAttempt?.name, avatar: creatorAttempt?.avatar, score: creatorAttempt?.score ?? 0 },
    problems: showProblems ? challenge.problems : [],
    leaderboard: ranked.map((a, i) => ({
      rank: i + 1,
      id: String(a.user),
      name: a.name,
      avatar: a.avatar,
      score: a.score,
      solved: a.solved,
      finishedAt: a.finishedAt,
      creator: String(a.user) === String(challenge.creator),
    })),
    playing: challenge.attempts.filter((a) => a.status === 'playing').length,
    mine: mine ? { status: mine.status, matchCode: mine.matchCode || null, score: mine.score, solved: mine.solved } : null,
    createdAt: challenge.createdAt,
  };
}

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const matchCode = String(req.body?.matchCode || '').toUpperCase();
    const match = await Match.findOne({ code: matchCode });
    if (!match) throw notFound('Match not found');
    if (match.status !== 'finished') throw badRequest('Finish the battle first');
    if (match.challengeCode) throw badRequest('This was already a challenge attempt. Share that challenge instead.');
    const participant = match.participants.find((p) => String(p.user) === String(req.userId));
    if (!participant) throw forbidden('Only players from this battle can turn it into a challenge');
    if (!match.problems.length) throw badRequest('This battle has no problems');

    const existing = await Challenge.findOne({ creator: req.userId, sourceMatch: match.code });
    if (existing) return res.json({ challenge: serialize(existing, req.userId) });

    let code;
    for (let i = 0; i < 5 && !code; i += 1) {
      const candidate = roomCode();
      if (!(await Challenge.exists({ code: candidate }))) code = candidate;
    }
    if (!code) throw conflict('Could not create a challenge code, try again');

    const challenge = await Challenge.create({
      code,
      creator: req.userId,
      sourceMatch: match.code,
      name: match.name,
      durationMin: match.settings.durationMin,
      problems: match.problems.map((p) => p.toObject()),
      attempts: [
        {
          user: req.userId,
          name: participant.name,
          avatar: participant.avatar,
          status: 'done',
          score: soloScore(match, participant),
          solved: participant.solves.filter((s) => new Date(s.solvedAt) <= new Date(match.startedAt.getTime() + match.settings.durationMin * 60000)).length,
          finishedAt: match.finishedAt,
        },
      ],
    });
    res.status(201).json({ challenge: serialize(challenge, req.userId) });
  })
);

router.get(
  '/:code',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const challenge = await Challenge.findOne({ code: codeOf(req) });
    if (!challenge) throw notFound('No challenge with this code');
    res.json({ challenge: serialize(challenge, req.userId) });
  })
);

router.post(
  '/:code/attempt',
  requireAuth,
  asyncHandler(async (req, res) => {
    const challenge = await Challenge.findOne({ code: codeOf(req) });
    if (!challenge) throw notFound('No challenge with this code');
    const mine = challenge.attempts.find((a) => String(a.user) === String(req.userId));
    if (mine && mine.status === 'done') throw badRequest('You already have a score on this challenge');
    if (mine?.matchCode) {
      const existing = await Match.findOne({ code: mine.matchCode }).select('status').lean();
      if (existing && existing.status !== 'cancelled') return res.json({ matchCode: mine.matchCode });
      // The lobby was closed before it started (left idle or abandoned): drop it and open a fresh attempt.
      await Challenge.updateOne({ _id: challenge._id }, { $pull: { attempts: { user: mine.user, status: 'playing' } } });
    }

    const user = await User.findById(req.userId);
    if (!user) throw notFound('User not found');
    const creatorName = challenge.attempts.find((a) => String(a.user) === String(challenge.creator))?.name || 'a friend';
    const match = await createMatch(user, {
      name: `Beat ${creatorName.split(' ')[0]}: ${challenge.name}`.slice(0, 60),
      settings: { solo: true, pool: 'curated', ...mix(challenge.problems) },
    }, { challenge: { code: challenge.code, durationMin: challenge.durationMin } });
    const updated = await Challenge.updateOne(
      { _id: challenge._id, 'attempts.user': { $ne: user._id } },
      { $push: { attempts: { user: user._id, name: user.name, avatar: user.avatar || user.leetcode?.avatar, matchCode: match.code } } }
    );
    if (!updated.modifiedCount) {
      await Match.updateOne({ code: match.code }, { $set: { status: 'cancelled' } });
      const again = await Challenge.findOne({ _id: challenge._id }).lean();
      const attempt = again.attempts.find((a) => String(a.user) === String(user._id));
      return res.json({ matchCode: attempt?.matchCode || null });
    }
    res.status(201).json({ matchCode: match.code });
  })
);

export default router;
