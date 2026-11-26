import { Router } from 'express';
import User, { premiumView } from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { COMPANIES, PERIOD_LABELS, addCompanyList, connectSession, disconnectSession, redeem, syncMyLists } from '../services/premium.js';

// Premium: redeem a code, connect your own LeetCode session, import your lists and company lists.
const router = Router();

const me = async (req) => {
  const user = await User.findById(req.userId);
  if (!user) throw notFound('User not found');
  return user;
};

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    res.json({ premium: premiumView(user), companies: COMPANIES, periods: PERIOD_LABELS });
  })
);

router.post(
  '/redeem',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    await redeem(user, req.body?.code);
    res.json({ premium: premiumView(user) });
  })
);

router.put(
  '/session',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    const who = await connectSession(user, req.body?.session, req.body?.csrf);
    res.json({ premium: premiumView(user), leetcodePremium: who.isPremium });
  })
);

router.delete(
  '/session',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    await disconnectSession(user);
    res.json({ premium: premiumView(user) });
  })
);

router.post(
  '/sync',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    const lists = await syncMyLists(user);
    res.json({ premium: premiumView(user), imported: lists.length });
  })
);

router.post(
  '/companies',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await me(req);
    const list = await addCompanyList(user, req.body?.company, req.body?.period);
    res.status(201).json({ list });
  })
);

export default router;
