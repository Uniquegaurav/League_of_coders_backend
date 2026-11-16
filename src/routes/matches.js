import { Router } from 'express';
import Match from '../models/Match.js';
import User from '../models/User.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, clampInt, notFound } from '../utils/http.js';
import * as engine from '../services/matchEngine.js';

const router = Router();

const currentUser = async (req) => {
  const user = await User.findById(req.userId);
  if (!user) throw notFound('User not found');
  return user;
};
const codeOf = (req) => String(req.params.code || '').toUpperCase();
const send = (res, match) => res.json({ match: engine.serializeMatch(match) });

router.get(
  '/open',
  asyncHandler(async (_req, res) => {
    const matches = await Match.find({
      visibility: 'public',
      status: { $in: ['lobby', 'countdown', 'live'] },
      updatedAt: { $gt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    })
      .sort({ status: 1, createdAt: -1 })
      .limit(30);
    res.json({ matches: matches.map(engine.summarizeMatch) });
  })
);

router.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 30, 10);
    const matches = await Match.find({ status: 'finished', visibility: 'public', 'participants.1': { $exists: true } })
      .sort({ finishedAt: -1 })
      .limit(limit);
    res.json({ matches: matches.map(engine.summarizeMatch) });
  })
);

router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const matches = await Match.find({
      participants: { $elemMatch: { user: req.userId, left: false } },
      status: { $in: ['lobby', 'countdown', 'live'] },
    }).sort({ updatedAt: -1 });
    res.json({ matches: matches.map(engine.summarizeMatch) });
  })
);

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [players, matches, live] = await Promise.all([
      User.countDocuments(),
      Match.countDocuments({ status: 'finished' }),
      Match.countDocuments({ status: { $in: ['countdown', 'live'] } }),
    ]);
    res.json({ players, matches, live });
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    send(res, await engine.createMatch(await currentUser(req), req.body));
  })
);

router.get(
  '/:code',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const match = await Match.findOne({ code: codeOf(req) });
    if (!match) throw notFound('No match with this code');
    res.json({ match: engine.serializeMatch(match, { withMessages: true }) });
  })
);

router.post(
  '/:code/join',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.joinMatch(codeOf(req), await currentUser(req))))
);

router.post(
  '/:code/leave',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.leaveMatch(codeOf(req), req.userId)))
);

router.patch(
  '/:code',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.updateSettings(codeOf(req), req.userId, req.body || {})))
);

router.patch(
  '/:code/me',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.setPreferences(codeOf(req), req.userId, req.body || {})))
);

router.delete(
  '/:code/players/:userId',
  requireAuth,
  asyncHandler(async (req, res) =>
    send(res, await engine.kickParticipant(codeOf(req), req.userId, req.params.userId))
  )
);

router.post(
  '/:code/start',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.startMatch(codeOf(req), req.userId)))
);

router.post(
  '/:code/end',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.finishMatch(codeOf(req), { byUserId: req.userId })))
);

router.post(
  '/:code/check',
  requireAuth,
  asyncHandler(async (req, res) => res.json(await engine.checkNow(codeOf(req), req.userId)))
);

router.post(
  '/:code/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    await engine.postMessage(codeOf(req), await currentUser(req), req.body?.text);
    res.status(201).json({ ok: true });
  })
);

router.post(
  '/:code/rematch',
  requireAuth,
  asyncHandler(async (req, res) => send(res, await engine.rematch(codeOf(req), await currentUser(req))))
);

export default router;
