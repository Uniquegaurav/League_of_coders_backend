import { Router } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import User from '../models/User.js';
import Match from '../models/Match.js';
import Problem from '../models/Problem.js';
import { XP, bumpStreak, practiceView, todayKey } from '../services/progression.js';
import { dailySlug } from '../services/daily.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, clampInt, conflict, notFound } from '../utils/http.js';
import { fetchProfile } from '../services/leetcodeProfile.js';
import { summarizeMatch } from '../services/matchEngine.js';

const router = Router();
const LC_USERNAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const me = async (req) => {
  const user = await User.findById(req.userId);
  if (!user) throw notFound('User not found');
  return user;
};

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw badRequest('Name cannot be empty');
      user.name = name.slice(0, 60);
    }
    await user.save();
    res.json({ user: user.toSelf() });
  })
);

router.put(
  '/me/leetcode',
  requireAuth,
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    if (!LC_USERNAME_RE.test(username)) throw badRequest('That does not look like a LeetCode username');

    const profile = await fetchProfile(username);
    if (!profile) throw badRequest(`No LeetCode user named "${username}"`);

    const taken = await User.exists({ 'leetcode.username': profile.username.toLowerCase(), _id: { $ne: req.userId } });
    if (taken) throw conflict('This LeetCode account is already linked to another player');

    const user = await me(req);
    user.leetcode = {
      username: profile.username.toLowerCase(),
      displayName: profile.username,
      avatar: profile.avatar,
      verified: false,
      verifyToken: `loc-${randomBytes(4).toString('hex')}`,
    };
    await user.save();
    res.json({ user: user.toSelf() });
  })
);

// Ownership proof: the player pastes their token into their LeetCode profile "Summary" (aboutMe).
router.post(
  '/me/leetcode/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    if (!user.leetcode?.username) throw badRequest('Link a LeetCode username first');
    if (user.leetcode.verified) return res.json({ user: user.toSelf() });

    const profile = await fetchProfile(user.leetcode.username, { fresh: true });
    if (!profile?.aboutMe?.includes(user.leetcode.verifyToken)) {
      throw badRequest(
        `Couldn't find "${user.leetcode.verifyToken}" in your LeetCode profile summary yet. Save it there and try again (it can take a minute to update).`
      );
    }
    user.leetcode.verified = true;
    await user.save();
    res.json({ user: user.toSelf() });
  })
);

router.delete(
  '/me/leetcode',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    user.leetcode = undefined;
    await user.save();
    res.json({ user: user.toSelf() });
  })
);

router.get(
  '/me/solved',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('solvedSlugs').lean();
    res.json({ slugs: user?.solvedSlugs || [] });
  })
);

router.put(
  '/me/solved/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const slug = req.params.slug;
    const solved = req.body?.solved !== false;
    const user = await me(req);
    const before = practiceView(user);
    const has = user.solvedSlugs.includes(slug);
    let xpGained = 0;
    let daily = false;

    if (solved !== has) {
      const problem = await Problem.findOne({ slug }).select('difficulty').lean();
      const base = XP[problem?.difficulty] ?? XP.Easy;
      if (!user.practice) user.practice = {};
      if (solved) {
        user.solvedSlugs.push(slug);
        const today = todayKey();
        daily = user.practice.dailyDay !== today && slug === (await dailySlug(today));
        if (daily) user.practice.dailyDay = today;
        xpGained = daily ? base * 2 : base;
        bumpStreak(user);
      } else {
        user.solvedSlugs.pull(slug);
        xpGained = -Math.min(base, user.practice.xp || 0);
      }
      user.practice.xp = (user.practice.xp || 0) + xpGained;
      await user.save();
    }

    const practice = practiceView(user);
    res.json({ slug, solved, xpGained, daily, leveledUp: practice.level > before.level, practice });
  })
);

router.get(
  '/me/progress',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('solvedSlugs').lean();
    const solvedSlugs = user?.solvedSlugs || [];
    const base = { curated: true, paidOnly: false };
    const solvedExpr = { $cond: [{ $in: ['$slug', solvedSlugs] }, 1, 0] };

    const [diff, topics] = await Promise.all([
      Problem.aggregate([
        { $match: base },
        { $group: { _id: '$difficulty', total: { $sum: 1 }, solved: { $sum: solvedExpr } } },
      ]),
      Problem.aggregate([
        { $match: base },
        { $project: { slug: 1, topic: { $cond: [{ $gt: [{ $size: '$tags' }, 0] }, '$tags', '$patterns'] } } },
        { $unwind: '$topic' },
        { $group: { _id: '$topic', total: { $sum: 1 }, solved: { $sum: solvedExpr } } },
        { $sort: { total: -1, _id: 1 } },
        { $limit: 12 },
      ]),
    ]);

    const byDifficulty = { Easy: { solved: 0, total: 0 }, Medium: { solved: 0, total: 0 }, Hard: { solved: 0, total: 0 } };
    diff.forEach((d) => {
      if (byDifficulty[d._id]) byDifficulty[d._id] = { solved: d.solved, total: d.total };
    });
    res.json({ byDifficulty, topics: topics.map((t) => ({ topic: t._id, solved: t.solved, total: t.total })) });
  })
);

router.get(
  '/leaderboard',
  asyncHandler(async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const users = await User.find({ 'stats.matches': { $gt: 0 } })
      .sort({ 'stats.rating': -1, 'stats.wins': -1 })
      .limit(limit);
    res.json({ players: users.map((u) => u.toPublic()) });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Player not found');
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('Player not found');
    const matches = await Match.find({ 'participants.user': user._id, status: 'finished' })
      .sort({ finishedAt: -1 })
      .limit(20);
    const history = matches.map((m) => {
      const p = m.participants.find((x) => String(x.user) === String(user._id));
      return {
        ...summarizeMatch(m),
        result: {
          rank: p.rank,
          of: m.participants.length,
          score: p.score,
          solved: p.solves.length,
          problems: m.problems.length,
          ratingDelta: p.ratingAfter != null && p.ratingBefore != null ? p.ratingAfter - p.ratingBefore : 0,
        },
      };
    });
    res.json({ player: user.toPublic(), history });
  })
);

export default router;
