import { Router } from 'express';
import Problem from '../models/Problem.js';
import User from '../models/User.js';
import { optionalAuth } from '../middleware/auth.js';
import { asyncHandler, clampInt, notFound } from '../utils/http.js';
import { dailySlug } from '../services/daily.js';
import { todayKey } from '../services/progression.js';
import { getProblemDetail, listTopics } from '../services/questionBank.js';

const router = Router();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { difficulty, topic, search, pool = 'curated' } = req.query;
    const page = clampInt(req.query.page, 1, 1000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 50);

    const filter = { paidOnly: false };
    if (pool !== 'all') filter.curated = true;
    if (['Easy', 'Medium', 'Hard'].includes(difficulty)) filter.difficulty = difficulty;
    if (topic) filter.$or = [{ tags: topic }, { patterns: topic }];
    if (search?.trim()) {
      const term = search.trim().slice(0, 80);
      filter.$and = [{ $or: [{ title: { $regex: escapeRegex(term), $options: 'i' } }, { frontendId: term }] }];
    }
    if (req.userId && (req.query.onlySolved === 'true' || req.query.hideSolved === 'true')) {
      const user = await User.findById(req.userId).select('solvedSlugs').lean();
      const slugs = user?.solvedSlugs || [];
      if (req.query.onlySolved === 'true') {
        if (!slugs.length) return res.json({ total: 0, page, limit, problems: [] });
        filter.slug = { $in: slugs };
      } else if (slugs.length) {
        filter.slug = { $nin: slugs };
      }
    } else if (req.query.onlySolved === 'true') {
      return res.json({ total: 0, page, limit, problems: [] });
    }

    const [total, problems] = await Promise.all([
      Problem.countDocuments(filter),
      Problem.find(filter)
        .select('-detail')
        .sort({ frontendId: 1, title: 1 })
        .collation({ locale: 'en', numericOrdering: true })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    res.json({ total, page, limit, problems: problems.map((p) => p.toSummary()) });
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
