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

// Lists keep their own order (Blind 75 by pattern, custom lists the way you arranged them).
async function listScope(key, userId) {
  const list = await ProblemList.findOne({ key }).select('slugs source owner').lean();
  if (!list || (list.owner && String(list.owner) !== String(userId))) throw notFound('List not found');
  return list;
}

const DIFF_RANK = { Easy: 0, Medium: 1, Hard: 2 };
const byNumber = (a, b) => (Number(a.frontendId) || 1e9) - (Number(b.frontendId) || 1e9) || a.title.localeCompare(b.title);
// "default" keeps a list's own order (or problem number for the big pools).
export const SORTS = {
  number: byNumber,
  difficulty: (a, b) => DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty] || byNumber(a, b),
  'difficulty-desc': (a, b) => DIFF_RANK[b.difficulty] - DIFF_RANK[a.difficulty] || byNumber(a, b),
  acceptance: (a, b) => (b.acRate ?? -1) - (a.acRate ?? -1) || byNumber(a, b),
  'acceptance-asc': (a, b) => (a.acRate ?? 101) - (b.acRate ?? 101) || byNumber(a, b),
  title: (a, b) => a.title.localeCompare(b.title),
};
const MONGO_SORTS = {
  number: { frontendId: 1, title: 1 },
  acceptance: { acRate: -1, frontendId: 1 },
  'acceptance-asc': { acRate: 1, frontendId: 1 },
  title: { title: 1 },
};

/** Shared by the list, the progress breakdown and the "pick a problem" endpoint. */
async function scopeFor(req) {
  const { difficulty, topic, search, pool = 'curated', list: listKey } = req.query;
  const user = req.userId ? await User.findById(req.userId).select('solvedSlugs premium.active').lean() : null;
  const solvedSlugs = user?.solvedSlugs || [];

  const base = {};
  let order = null;
  if (listKey) {
    const list = await listScope(String(listKey), req.userId);
    order = list.slugs;
    base.slug = { $in: order };
    // Premium lists may hold LeetCode Premium problems; every other view shows free problems only.
    if (!(list.source === 'premium' && user?.premium?.active)) base.paidOnly = false;
  } else {
    base.paidOnly = false;
    if (pool !== 'all') base.curated = true;
  }
  if (topic) base.$or = [{ tags: topic }, { patterns: topic }];
  if (search?.trim()) {
    const term = search.trim().slice(0, 80);
    base.$and = [{ $or: [{ title: { $regex: escapeRegex(term), $options: 'i' } }, { frontendId: term }] }];
  }
  // Difficulty is applied separately so the progress breakdown can still show all three.
  const withDifficulty = ['Easy', 'Medium', 'Hard'].includes(difficulty) ? { ...base, difficulty } : base;

  const view = req.query.onlySolved === 'true' ? 'solved' : req.query.hideSolved === 'true' && user ? 'todo' : 'all';
  const filter = { ...withDifficulty };
  if (view !== 'all' && user) {
    filter.$and = [...(filter.$and || []), { slug: view === 'solved' ? { $in: solvedSlugs } : { $nin: solvedSlugs } }];
  }
  return { user, solvedSlugs, base, withDifficulty, filter, order, view };
}

router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { user, solvedSlugs, base, withDifficulty, filter, order, view } = await scopeFor(req);
    const sort = SORTS[req.query.sort] ? req.query.sort : 'default';
    const page = clampInt(req.query.page, 1, 1000, 1);
    // A list is small enough to show in one go, which is what drag-and-drop reordering needs.
    const limit = clampInt(req.query.limit, 1, order ? 500 : 100, 50);

    const solvedIn = { $cond: [{ $in: ['$slug', solvedSlugs] }, 1, 0] };
    // One request returns the page, the tab counts and the per-difficulty progress, so the page needs no follow-up calls.
    const breakdownPromise = Problem.aggregate([
      { $match: base },
      { $group: { _id: '$difficulty', total: { $sum: 1 }, solved: { $sum: solvedIn } } },
    ]).then((rows) =>
      Object.fromEntries(['Easy', 'Medium', 'Hard'].map((d) => [d, { total: 0, solved: 0, ...(({ _id, ...r }) => r)(rows.find((r) => r._id === d) || {}) }]))
    );
    const countsPromise = user
      ? Promise.all([
          Problem.countDocuments(withDifficulty),
          Problem.countDocuments({ ...withDifficulty, $and: [...(withDifficulty.$and || []), { slug: { $in: solvedSlugs } }] }),
        ]).then(([all, solved]) => ({ all, solved, todo: all - solved }))
      : Promise.resolve(null);

    if (view !== 'all' && !user) {
      return res.json({ total: 0, page, limit, problems: [], counts: null, breakdown: await breakdownPromise });
    }

    let total;
    let problems;
    if (order || sort === 'difficulty' || sort === 'difficulty-desc') {
      // Lists hold at most a few thousand problems, and difficulty is not a sortable field: sort in memory.
      const rows = await Problem.find(filter).select('-detail');
      if (sort === 'default' && order) {
        const position = new Map(order.map((slug, i) => [slug, i]));
        rows.sort((a, b) => position.get(a.slug) - position.get(b.slug));
      } else rows.sort(SORTS[sort] || SORTS.number);
      total = rows.length;
      problems = rows.slice((page - 1) * limit, page * limit);
    } else {
      [total, problems] = await Promise.all([
        Problem.countDocuments(filter),
        Problem.find(filter)
          .select('-detail')
          .sort(MONGO_SORTS[sort] || MONGO_SORTS.number)
          .collation({ locale: 'en', numericOrdering: true })
          .skip((page - 1) * limit)
          .limit(limit),
      ]);
    }
    res.vary('Authorization');
    if (!user) res.set('Cache-Control', 'public, max-age=120');
    res.json({
      total,
      page,
      limit,
      problems: problems.map((p) => p.toSummary()),
      counts: await countsPromise,
      breakdown: await breakdownPromise,
    });
  })
);

/** "Continue" (first unsolved, in list order) or "Random" (any unsolved) within the current list and filters. */
router.get(
  '/pick',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { solvedSlugs, withDifficulty, order } = await scopeFor(req);
    const unsolved = { ...withDifficulty, $and: [...(withDifficulty.$and || []), { slug: { $nin: solvedSlugs } }] };
    let pick = null;
    if (req.query.mode === 'random') {
      [pick] = await Problem.aggregate([{ $match: unsolved }, { $sample: { size: 1 } }, { $project: { slug: 1 } }]);
    } else if (order) {
      const rows = await Problem.find(unsolved).select('slug').lean();
      const left = new Set(rows.map((r) => r.slug));
      const slug = order.find((s) => left.has(s));
      pick = slug ? { slug } : null;
    } else {
      pick = await Problem.findOne(unsolved).select('slug').sort({ frontendId: 1 }).collation({ locale: 'en', numericOrdering: true }).lean();
    }
    if (!pick) throw notFound('Everything here is solved. Nice work!');
    res.json({ slug: pick.slug });
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
