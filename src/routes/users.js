import { Router } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import User, { CLAIM_TTL_MS } from '../models/User.js';
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

const newToken = () => `loc-${randomBytes(4).toString('hex')}`;
const claimExpired = (claim) => !claim?.createdAt || Date.now() - new Date(claim.createdAt).getTime() > CLAIM_TTL_MS;

const verifiedOwnerOf = (username, exceptId) =>
  User.exists({ 'leetcode.username': username, 'leetcode.verified': true, _id: { $ne: exceptId } });

// Step 1: start a claim. Nothing is linked yet; the player gets a code to put in their LeetCode profile summary.
router.put(
  '/me/leetcode',
  requireAuth,
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    if (!LC_USERNAME_RE.test(username)) throw badRequest('That does not look like a LeetCode username');

    const profile = await fetchProfile(username);
    if (!profile) throw badRequest(`No LeetCode user named "${username}"`);
    const lower = profile.username.toLowerCase();

    if (await verifiedOwnerOf(lower, req.userId)) {
      throw conflict('This LeetCode account is already verified by another player');
    }

    const user = await me(req);
    if (user.leetcode?.verified && user.leetcode.username === lower) return res.json({ user: user.toSelf() });

    const current = user.leetcodeClaim;
    const keep = current?.username === lower && !claimExpired(current);
    user.leetcodeClaim = {
      username: lower,
      displayName: profile.username,
      avatar: profile.avatar,
      token: keep ? current.token : newToken(),
      createdAt: keep ? current.createdAt : new Date(),
    };
    await user.save();
    res.json({ user: user.toSelf() });
  })
);

// Step 2: prove ownership. The code must appear in the LeetCode profile summary (only the owner can edit it).
router.post(
  '/me/leetcode/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    const claim = user.leetcodeClaim?.username ? user.leetcodeClaim : null;

    // Accounts linked before verification was required can still prove ownership with their old code.
    if (!claim) {
      if (!user.leetcode?.username) throw badRequest('Enter your LeetCode username first');
      if (user.leetcode.verified) return res.json({ user: user.toSelf() });
      const legacy = await fetchProfile(user.leetcode.username, { fresh: true });
      if (!legacy?.aboutMe?.includes(user.leetcode.verifyToken)) {
        throw badRequest(`Couldn't find "${user.leetcode.verifyToken}" in your LeetCode profile summary yet. Save it there and try again.`);
      }
      user.leetcode.verified = true;
      user.leetcode.verifyToken = undefined;
      await user.save();
      return res.json({ user: user.toSelf() });
    }

    if (claimExpired(claim)) {
      user.leetcodeClaim = undefined;
      await user.save();
      throw badRequest('That code expired. Enter your username again to get a new one.');
    }

    const profile = await fetchProfile(claim.username, { fresh: true });
    if (!profile) throw badRequest(`No LeetCode user named "${claim.displayName || claim.username}"`);
    if (!profile.aboutMe?.includes(claim.token)) {
      throw badRequest(`Couldn't find "${claim.token}" in that account's profile summary yet. Save it on LeetCode and try again (it can take a minute to update).`);
    }
    if (await verifiedOwnerOf(claim.username, user._id)) {
      throw conflict('This LeetCode account is already verified by another player');
    }

    // The owner has proven it: drop any unverified link someone else made to this account.
    await User.updateMany(
      { _id: { $ne: user._id }, 'leetcode.username': claim.username, 'leetcode.verified': { $ne: true } },
      { $unset: { leetcode: 1 } }
    );
    user.leetcode = { username: claim.username, displayName: claim.displayName, avatar: claim.avatar, verified: true };
    user.leetcodeClaim = undefined;
    try {
      await user.save();
    } catch (err) {
      if (err.code === 11000) throw conflict('This LeetCode account was just linked by another player');
      throw err;
    }
    res.json({ user: user.toSelf() });
  })
);

router.delete(
  '/me/leetcode/claim',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    user.leetcodeClaim = undefined;
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
    user.leetcodeClaim = undefined;
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
