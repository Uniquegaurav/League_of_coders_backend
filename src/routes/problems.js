import { Router } from 'express';
import Problem from '../models/Problem.js';
import ProblemList from '../models/ProblemList.js';
import User from '../models/User.js';
import { optionalAuth } from '../middleware/auth.js';
import { asyncHandler, clampInt, notFound } from '../utils/http.js';
import { dailySlug } from '../services/daily.js';
import { todayKey } from '../services/progression.js';
import { getProblemDetail, listTopics } from '../services/questionBank.js';

const router = Router();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lists keep their own order (Blind 75 by pattern, custom lists by when you added them).
async function listScope(key, userId) {
  const list = await ProblemList.findOne({ key }).select('slugs source owner').lean();
  if (!list || (list.source === 'custom' && String(list.owner) !== String(userId))) throw notFound('List not found');
  return list.slugs;
}

router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { difficulty, topic, search, pool = 'curated', list: listKey } = req.query;
    const page = clampInt(req.query.page, 1, 1000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 50);

    const base = { paidOnly: false };
    let order = null;
    if (listKey) {
      order = await listScope(String(listKey), req.userId);
      base.slug = { $in: order };
    } else if (pool !== 'all') base.curated = true;
    if (['Easy', 'Medium', 'Hard'].includes(difficulty)) base.difficulty = difficulty;
    if (topic) base.$or = [{ tags: topic }, { patterns: topic }];
    if (search?.trim()) {
      const term = search.trim().slice(0, 80);
      base.$and = [{ $or: [{ title: { $regex: escapeRegex(term), $options: 'i' } }, { frontendId: term }] }];
    }

    const user = req.userId ? await User.findById(req.userId).select('solvedSlugs').lean() : null;
    const solvedSlugs = user?.solvedSlugs || [];
    // Signed-out visitors have nothing solved: "to solve" is everything, "solved" is empty.
    const view = req.query.onlySolved === 'true' ? 'solved' : req.query.hideSolved === 'true' && user ? 'todo' : 'all';
    const filter = { ...base };
    if (view !== 'all') {
      if (!user) return res.json({ total: 0, page, limit, problems: [], counts: null });
      const extra = view === 'solved' ? { $in: solvedSlugs } : { $nin: solvedSlugs };
      filter.$and = [...(filter.$and || []), { slug: extra }];
    }

    // One request returns the page plus the counts for every tab, so the page needs no follow-up calls.
    const countsPromise = user
      ? Promise.all([
          Problem.countDocuments(base),
          Problem.countDocuments({ ...base, $and: [...(base.$and || []), { slug: { $in: solvedSlugs } }] }),
        ]).then(([all, solved]) => ({ all, solved, todo: all - solved }))
      : Promise.resolve(null);

    let total;
    let problems;
    if (order) {
      // Lists hold at most a few hundred problems: sort by list position in memory.
      const rows = await Problem.find(filter).select('-detail');
      const position = new Map(order.map((slug, i) => [slug, i]));
      rows.sort((a, b) => position.get(a.slug) - position.get(b.slug));
      total = rows.length;
      problems = rows.slice((page - 1) * limit, page * limit);
    } else {
      [total, problems] = await Promise.all([
        Problem.countDocuments(filter),
        Problem.find(filter)
          .select('-detail')
          .sort({ frontendId: 1, title: 1 })
          .collation({ locale: 'en', numericOrdering: true })
          .skip((page - 1) * limit)
          .limit(limit),
      ]);
    }
    res.vary('Authorization');
    if (!user) res.set('Cache-Control', 'public, max-age=120');
    res.json({ total, page, limit, problems: problems.map((p) => p.toSummary()), counts: await countsPromise });
  })
);

router.get(
  '/topics',
  asyncHandler(async (req, res) => {
    res.json({ topics: await listTopics(req.query.pool === 'all' ? 'all' : 'curated') });
  })
);

router.get(
  '/daily',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const day = todayKey();
    const slug = await dailySlug(day);
    const problem = slug && (await Problem.findOne({ slug }).select('-detail'));
    if (!problem) throw notFound('No daily problem available');
    let done = false;
    if (req.userId) {
      const user = await User.findById(req.userId).select('practice.dailyDay solvedSlugs').lean();
      done = user?.practice?.dailyDay === day;
    }
    res.json({ day, problem: problem.toSummary(), done });
  })
);

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    res.json({ problem: await getProblemDetail(req.params.slug) });
  })
);

export default router;
