import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import User, { CLAIM_TTL_MS } from '../models/User.js';
import Match from '../models/Match.js';
import Problem from '../models/Problem.js';
import { XP, bumpStreak, practiceView, todayKey } from '../services/progression.js';
import { dailySlug } from '../services/daily.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, clampInt, conflict, notFound } from '../utils/http.js';
import { fetchProfile } from '../services/leetcodeProfile.js';
import { createMatch, summarizeMatch } from '../services/matchEngine.js';
import Invite from '../models/Invite.js';
import { grantBadges } from '../services/badges.js';
import { escapeRegex, findByHandle, normalizeCollege, validateUsername } from '../services/identity.js';
import { weekStart } from '../services/email.js';
import { sendChallengeEmail } from '../services/email.js';
import { emitToUser } from '../services/presence.js';

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
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw badRequest('Name cannot be empty');
      user.name = name.slice(0, 60);
    }
    if (body.username !== undefined) {
      const { value, error } = validateUsername(body.username);
      if (error) throw badRequest(error);
      if (value !== user.username && (await User.exists({ username: value, _id: { $ne: user._id } }))) {
        throw conflict('That username is taken');
      }
      user.username = value;
    }
    if (body.college !== undefined) {
      const college = normalizeCollege(body.college);
      if (college) {
        // Reuse an existing spelling so "iit delhi" and "IIT Delhi" land on the same college board.
        const same = await User.findOne({ college: { $regex: `^${escapeRegex(college)}$`, $options: 'i' } }).select('college').lean();
        user.college = same?.college || college;
      } else {
        user.college = undefined;
      }
    }
    if (body.emailPrefs && typeof body.emailPrefs === 'object') {
      for (const key of ['streak', 'challenges', 'weekly']) {
        if (typeof body.emailPrefs[key] === 'boolean') user.set(`emailPrefs.${key}`, body.emailPrefs[key]);
      }
    }
    try {
      await user.save();
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.username) throw conflict('That username is taken');
      throw err;
    }
    res.json({ user: user.toSelf() });
  })
);

const newToken = () => `loc-${randomBytes(4).toString('hex')}`;
const claimExpired = (claim) => !claim?.createdAt || Date.now() - new Date(claim.createdAt).getTime() > CLAIM_TTL_MS;

const verifiedOwnerOf = (username, exceptId) =>
  User.exists({ 'leetcode.username': username, 'leetcode.verified': true, _id: { $ne: exceptId } });

// Step 1: start a claim. Nothing is linked yet; the player gets a code to put in their LeetCode profile ReadMe.
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

// Step 2: prove ownership. The code must appear in the LeetCode profile ReadMe, formerly "Summary" (only the owner can edit it).
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
        throw badRequest(`Couldn't find "${user.leetcode.verifyToken}" in your LeetCode ReadMe yet. In LeetCode profile settings, open ReadMe under General, add the code (or append it) and save, then try again.`);
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
      throw badRequest(`Couldn't find "${claim.token}" in that account's LeetCode ReadMe yet. In LeetCode profile settings, open ReadMe under General, add the code (or append it) and save, then try again. It can take a minute to update.`);
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
    let badges = [];

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
        badges = grantBadges(user);
      } else {
        user.solvedSlugs.pull(slug);
        xpGained = -Math.min(base, user.practice.xp || 0);
      }
      user.practice.xp = (user.practice.xp || 0) + xpGained;
      await user.save();
    }

    const practice = practiceView(user);
    res.json({ slug, solved, xpGained, daily, leveledUp: practice.level > before.level, practice, badges });
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

const rankedFilter = { 'stats.matches': { $gt: 0 } };

/** Rating gained in rated battles since Monday 00:00 UTC, per player. */
async function weeklyStandings() {
  return Match.aggregate([
    { $match: { status: 'finished', finishedAt: { $gte: weekStart() }, 'participants.1': { $exists: true } } },
    { $unwind: '$participants' },
    {
      $group: {
        _id: '$participants.user',
        gain: { $sum: { $subtract: [{ $ifNull: ['$participants.ratingAfter', 0] }, { $ifNull: ['$participants.ratingBefore', 0] }] } },
        battles: { $sum: 1 },
        wins: { $sum: { $cond: [{ $and: [{ $eq: ['$participants.rank', 1] }, { $gt: ['$participants.score', 0] }] }, 1, 0] } },
        points: { $sum: '$participants.score' },
      },
    },
    { $sort: { gain: -1, wins: -1, points: -1 } },
    { $limit: 5000 },
  ]);
}

// scope: all (rating), week (rating gained this week), friends, college (?college=Name)
router.get(
  '/leaderboard',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const scope = ['all', 'week', 'friends', 'college'].includes(req.query.scope) ? req.query.scope : 'all';
    const viewer = req.userId ? await User.findById(req.userId) : null;

    if (scope === 'week') {
      const rows = await weeklyStandings();
      const top = rows.slice(0, limit);
      const users = await User.find({ _id: { $in: top.map((r) => r._id) } });
      const byId = new Map(users.map((u) => [String(u._id), u]));
      const players = top
        .filter((r) => byId.has(String(r._id)))
        .map((r) => ({ ...byId.get(String(r._id)).toPublic(), week: { gain: r.gain, battles: r.battles, wins: r.wins, points: r.points } }));
      const idx = viewer ? rows.findIndex((r) => String(r._id) === String(viewer._id)) : -1;
      const me = idx >= 0 ? { rank: idx + 1, week: { gain: rows[idx].gain, battles: rows[idx].battles, wins: rows[idx].wins, points: rows[idx].points } } : null;
      return res.json({ scope, since: weekStart(), players, me });
    }

    if (scope === 'friends') {
      if (!viewer) return res.json({ scope, players: [], me: null, needsLogin: true });
      const users = await User.find({ _id: { $in: [...viewer.friends, viewer._id] } }).sort({ 'stats.rating': -1, 'stats.wins': -1 }).limit(limit);
      const idx = users.findIndex((u) => String(u._id) === String(viewer._id));
      return res.json({ scope, players: users.map((u) => u.toPublic()), me: idx >= 0 ? { rank: idx + 1 } : null });
    }

    const filter = { ...rankedFilter };
    if (scope === 'college') {
      const college = normalizeCollege(req.query.college || viewer?.college);
      if (!college) return res.json({ scope, college: null, players: [], me: null });
      filter.college = college;
    }
    const users = await User.find(filter).sort({ 'stats.rating': -1, 'stats.wins': -1 }).limit(limit);
    let me = null;
    if (viewer?.stats.matches > 0 && (scope === 'all' || viewer.college === filter.college)) {
      const above = await User.countDocuments({ ...filter, 'stats.rating': { $gt: viewer.stats.rating } });
      me = { rank: above + 1 };
    }
    res.json({ scope, college: filter.college || null, players: users.map((u) => u.toPublic()), me });
  })
);

/** Colleges ranked by the average rating of their top 10 players. */
router.get(
  '/colleges',
  asyncHandler(async (req, res) => {
    const q = normalizeCollege(req.query.q);
    if (q) {
      // Suggestions for the profile field.
      const names = await User.distinct('college', { college: { $regex: escapeRegex(q), $options: 'i' } });
      return res.json({ colleges: names.slice(0, 10).map((name) => ({ name })) });
    }
    const rows = await User.aggregate([
      { $match: { college: { $type: 'string' }, ...rankedFilter } },
      { $sort: { 'stats.rating': -1 } },
      { $group: { _id: '$college', players: { $sum: 1 }, wins: { $sum: '$stats.wins' }, ratings: { $push: '$stats.rating' } } },
      { $project: { players: 1, wins: 1, score: { $round: [{ $avg: { $slice: ['$ratings', 10] } }, 0] } } },
      { $sort: { score: -1, players: -1 } },
      { $limit: 50 },
    ]);
    res.json({ colleges: rows.map((r, i) => ({ rank: i + 1, name: r._id, players: r.players, wins: r.wins, score: r.score })) });
  })
);

// Direct 1v1 challenge from a profile: opens a private lobby for two and notifies the other player.
const recentChallenges = new Map(); // userId -> timestamps
router.post(
  '/:id/challenge',
  requireAuth,
  asyncHandler(async (req, res) => {
    const target = await findByHandle(req.params.id);
    if (!target) throw notFound('Player not found');
    if (String(target._id) === String(req.userId)) throw badRequest('You cannot challenge yourself');
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const mine = (recentChallenges.get(String(req.userId)) || []).filter((t) => t > hourAgo);
    if (mine.length >= 5) throw badRequest('You have sent 5 challenges in the last hour. Try again later.');

    const user = await me(req);
    const match = await createMatch(user, {
      name: `${user.name.split(' ')[0]} vs ${target.name.split(' ')[0]}`,
      visibility: 'private',
      settings: { durationMin: 30, easy: 1, medium: 1, hard: 0, maxPlayers: 2 },
    });
    mine.push(Date.now());
    recentChallenges.set(String(req.userId), mine);
    if (recentChallenges.size > 5000) {
      for (const [id, times] of recentChallenges) if (!times.some((t) => t > hourAgo)) recentChallenges.delete(id);
    }

    const invite = await Invite.create({ from: user._id, to: target._id, matchCode: match.code });
    emitToUser(target._id, 'invite:new', {
      id: invite._id.toString(),
      from: user.toPublic(),
      match: summarizeMatch(match),
      createdAt: invite.createdAt,
    });
    sendChallengeEmail(target, user, match.code).catch((err) => console.warn('[email] challenge', err.message));
    res.status(201).json({ matchCode: match.code });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = await findByHandle(req.params.id);
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
