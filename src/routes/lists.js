import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import ProblemList from '../models/ProblemList.js';
import Problem from '../models/Problem.js';
import User from '../models/User.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../utils/http.js';

// Curated lists (read-only, synced weekly) and each player's own lists.
const router = Router();
const LIMITS = { lists: 20, problems: 500 };

const summary = (list, solved) => ({
  key: list.key,
  name: list.name,
  description: list.description || null,
  source: list.source,
  sourceUrl: list.sourceUrl || null,
  custom: list.source === 'custom',
  count: list.slugs.length,
  solved: solved ? list.slugs.filter((s) => solved.has(s)).length : null,
});

async function solvedSet(userId) {
  if (!userId) return null;
  const user = await User.findById(userId).select('solvedSlugs').lean();
  return new Set(user?.solvedSlugs || []);
}

async function ownList(req) {
  const list = await ProblemList.findOne({ key: req.params.key });
  if (!list) throw notFound('List not found');
  if (list.source !== 'custom' || String(list.owner) !== String(req.userId)) throw forbidden('You can only change your own lists');
  return list;
}

router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const [curated, mine, solved] = await Promise.all([
      ProblemList.find({ source: { $ne: 'custom' } }).sort({ order: 1 }).select('-groups').lean(),
      req.userId ? ProblemList.find({ owner: req.userId }).sort({ updatedAt: -1 }).select('-groups').lean() : [],
      solvedSet(req.userId),
    ]);
    res.json({ curated: curated.map((l) => summary(l, solved)), mine: mine.map((l) => summary(l, solved)) });
  })
);

router.get(
  '/:key',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const list = await ProblemList.findOne({ key: req.params.key }).lean();
    if (!list || (list.source === 'custom' && String(list.owner) !== String(req.userId))) throw notFound('List not found');
    const solved = await solvedSet(req.userId);
    res.json({ list: { ...summary(list, solved), groups: list.groups } });
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw badRequest('Give the list a name');
    if ((await ProblemList.countDocuments({ owner: req.userId })) >= LIMITS.lists) throw badRequest(`You can keep up to ${LIMITS.lists} lists`);
    const first = req.body?.slug ? String(req.body.slug) : null;
    if (first && !(await Problem.exists({ slug: first }))) throw notFound('Problem not found');
    const list = await ProblemList.create({
      key: `u-${randomBytes(5).toString('hex')}`,
      name,
      source: 'custom',
      owner: req.userId,
      slugs: first ? [first] : [],
      groups: [],
    });
    res.status(201).json({ list: summary(list, await solvedSet(req.userId)) });
  })
);

router.patch(
  '/:key',
  requireAuth,
  asyncHandler(async (req, res) => {
    const list = await ownList(req);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw badRequest('Give the list a name');
    list.name = name;
    await list.save();
    res.json({ list: summary(list, await solvedSet(req.userId)) });
  })
);

router.delete(
  '/:key',
  requireAuth,
  asyncHandler(async (req, res) => {
    const list = await ownList(req);
    await list.deleteOne();
    res.json({ ok: true });
  })
);

router.put(
  '/:key/problems/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const list = await ownList(req);
    const slug = String(req.params.slug);
    if (!list.slugs.includes(slug)) {
      if (list.slugs.length >= LIMITS.problems) throw badRequest(`A list can hold up to ${LIMITS.problems} problems`);
      if (!(await Problem.exists({ slug }))) throw notFound('Problem not found');
      list.slugs.push(slug);
      await list.save();
    }
    res.json({ list: summary(list, await solvedSet(req.userId)) });
  })
);

router.delete(
  '/:key/problems/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const list = await ownList(req);
    list.slugs.pull(String(req.params.slug));
    await list.save();
    res.json({ list: summary(list, await solvedSet(req.userId)) });
  })
);

/** Which of my lists contain this problem (for the "Add to list" menu). */
router.get(
  '/mine/containing/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const lists = await ProblemList.find({ owner: req.userId, slugs: req.params.slug }).select('key').lean();
    res.json({ keys: lists.map((l) => l.key) });
  })
);

export default router;
