import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Match from '../models/Match.js';
import FriendRequest from '../models/FriendRequest.js';
import Invite from '../models/Invite.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../utils/http.js';
import { summarizeMatch } from '../services/matchEngine.js';
import { emitToUser, isOnline } from '../services/presence.js';

const router = Router();
router.use(requireAuth);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACTIVE = ['lobby', 'countdown', 'live'];

const validId = (id, msg = 'Player not found') => {
  if (!mongoose.isValidObjectId(id)) throw notFound(msg);
  return String(id);
};

const me = async (req) => {
  const user = await User.findById(req.userId);
  if (!user) throw notFound('User not found');
  return user;
};

const isFriend = (user, otherId) => user.friends.some((f) => String(f) === String(otherId));

const withOnline = (u) => ({ ...u.toPublic(), online: isOnline(u._id) });

async function makeFriends(aId, bId) {
  await Promise.all([
    User.updateOne({ _id: aId }, { $addToSet: { friends: bId } }),
    User.updateOne({ _id: bId }, { $addToSet: { friends: aId } }),
  ]);
}

function serializeInvite(invite, from, match) {
  return { id: invite._id.toString(), from: from.toPublic(), match: summarizeMatch(match), createdAt: invite.createdAt };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = await me(req);
    const [friends, incoming, outgoing] = await Promise.all([
      User.find({ _id: { $in: user.friends } }).sort({ 'stats.rating': -1 }),
      FriendRequest.find({ to: user._id, status: 'pending' }).sort({ createdAt: -1 }).populate('from'),
      FriendRequest.find({ from: user._id, status: 'pending' }).sort({ createdAt: -1 }).populate('to'),
    ]);
    res.json({
      friends: friends.map(withOnline).sort((a, b) => Number(b.online) - Number(a.online)),
      incoming: incoming
        .filter((r) => r.from)
        .map((r) => ({ id: r._id.toString(), from: r.from.toPublic(), createdAt: r.createdAt })),
      outgoing: outgoing
        .filter((r) => r.to)
        .map((r) => ({ id: r._id.toString(), to: r.to.toPublic(), createdAt: r.createdAt })),
    });
  })
);

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json({ players: [] });
    const user = await me(req);
    const re = { $regex: escapeRegex(q), $options: 'i' };
    const players = await User.find({ _id: { $ne: user._id }, $or: [{ name: re }, { 'leetcode.username': re }] })
      .sort({ 'stats.rating': -1 })
      .limit(10);
    const ids = players.map((p) => p._id);
    const pending = await FriendRequest.find({
      status: 'pending',
      $or: [
        { from: user._id, to: { $in: ids } },
        { to: user._id, from: { $in: ids } },
      ],
    }).lean();
    const relationOf = (p) => {
      if (isFriend(user, p._id)) return 'friend';
      if (pending.some((r) => String(r.from) === String(p._id))) return 'incoming';
      if (pending.some((r) => String(r.to) === String(p._id))) return 'outgoing';
      return 'none';
    };
    res.json({ players: players.map((p) => ({ ...p.toPublic(), relation: relationOf(p) })) });
  })
);

router.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const targetId = validId(req.body?.userId);
    const user = await me(req);
    if (targetId === String(user._id)) throw badRequest('You cannot add yourself');
    const target = await User.findById(targetId);
    if (!target) throw notFound('Player not found');
    if (isFriend(user, target._id)) throw conflict('You are already friends');

    // They already asked us: treat this as accepting.
    const reverse = await FriendRequest.findOne({ from: target._id, to: user._id, status: 'pending' });
    if (reverse) {
      reverse.status = 'accepted';
      await reverse.save();
      await makeFriends(user._id, target._id);
      emitToUser(target._id, 'friend:accepted', { friend: user.toPublic() });
      return res.json({ status: 'accepted', friend: withOnline(target) });
    }

    let request = await FriendRequest.findOne({ from: user._id, to: target._id, status: 'pending' });
    if (!request) {
      request = await FriendRequest.create({ from: user._id, to: target._id });
      emitToUser(target._id, 'friend:request', {
        id: request._id.toString(),
        from: user.toPublic(),
        createdAt: request.createdAt,
      });
    }
    res.status(201).json({
      status: 'pending',
      request: { id: request._id.toString(), to: target.toPublic(), createdAt: request.createdAt },
    });
  })
);

router.post(
  '/requests/:id/accept',
  asyncHandler(async (req, res) => {
    const request = await FriendRequest.findById(validId(req.params.id, 'Request not found'));
    if (!request || request.status !== 'pending') throw notFound('Request not found');
    if (String(request.to) !== req.userId) throw forbidden('Only the recipient can accept this request');
    const [user, from] = await Promise.all([me(req), User.findById(request.from)]);
    if (!from) throw notFound('That player no longer exists');
    request.status = 'accepted';
    await request.save();
    await makeFriends(user._id, from._id);
    emitToUser(from._id, 'friend:accepted', { friend: user.toPublic() });
    res.json({ friend: withOnline(from) });
  })
);

router.post(
  '/requests/:id/decline',
  asyncHandler(async (req, res) => {
    const request = await FriendRequest.findById(validId(req.params.id, 'Request not found'));
    if (!request || request.status !== 'pending') throw notFound('Request not found');
    if (![String(request.to), String(request.from)].includes(req.userId)) throw forbidden();
    request.status = 'declined';
    await request.save();
    res.json({ ok: true });
  })
);

router.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const user = await me(req);
    if (!user.friends.length) return res.json({ activity: [] });
    const friendIds = new Set(user.friends.map(String));
    const [matches, friends] = await Promise.all([
      Match.find({ status: 'finished', 'participants.user': { $in: user.friends } })
        .sort({ finishedAt: -1 })
        .limit(20),
      User.find({ _id: { $in: user.friends } }),
    ]);
    const byId = new Map(friends.map((f) => [String(f._id), f]));
    const activity = [];
    matches.forEach((m) => {
      const summary = summarizeMatch(m);
      m.participants
        .filter((p) => friendIds.has(String(p.user)) && byId.has(String(p.user)))
        .forEach((p) =>
          activity.push({
            at: m.finishedAt,
            user: byId.get(String(p.user)).toPublic(),
            match: summary,
            result: {
              rank: p.rank,
              of: m.participants.length,
              score: p.score,
              ratingDelta: p.ratingAfter != null && p.ratingBefore != null ? p.ratingAfter - p.ratingBefore : 0,
            },
          })
        );
    });
    res.json({ activity: activity.slice(0, 20) });
  })
);

router.post(
  '/invite',
  asyncHandler(async (req, res) => {
    const targetId = validId(req.body?.userId);
    const code = String(req.body?.code || '').toUpperCase();
    const user = await me(req);
    if (!isFriend(user, targetId)) throw forbidden('You can only invite friends');
    const match = await Match.findOne({ code });
    if (!match) throw notFound('No match with this code');
    if (match.status !== 'lobby') throw badRequest('This battle has already started');
    if (!match.participants.some((p) => String(p.user) === req.userId && !p.left)) {
      throw forbidden('Join the lobby before inviting friends');
    }
    // Re-inviting refreshes the invite (and its 2h expiry) instead of stacking duplicates.
    const invite = await Invite.findOneAndUpdate(
      { from: user._id, to: targetId, matchCode: code },
      { $set: { status: 'pending', createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true, timestamps: false }
    );
    const payload = serializeInvite(invite, user, match);
    emitToUser(targetId, 'invite:new', payload);
    res.json({ invite: payload });
  })
);

router.get(
  '/invites',
  asyncHandler(async (req, res) => {
    const invites = await Invite.find({ to: req.userId, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('from');
    const matches = await Match.find({ code: { $in: invites.map((i) => i.matchCode) }, status: { $in: ACTIVE } });
    const byCode = new Map(matches.map((m) => [m.code, m]));
    res.json({
      invites: invites
        .filter((i) => i.from && byCode.has(i.matchCode))
        .map((i) => serializeInvite(i, i.from, byCode.get(i.matchCode))),
    });
  })
);

router.post(
  '/invites/:id/dismiss',
  asyncHandler(async (req, res) => {
    await Invite.updateOne({ _id: validId(req.params.id, 'Invite not found'), to: req.userId }, { status: 'dismissed' });
    res.json({ ok: true });
  })
);

router.delete(
  '/:userId',
  asyncHandler(async (req, res) => {
    const otherId = validId(req.params.userId);
    await Promise.all([
      User.updateOne({ _id: req.userId }, { $pull: { friends: otherId } }),
      User.updateOne({ _id: otherId }, { $pull: { friends: req.userId } }),
    ]);
    res.json({ ok: true });
  })
);

export default router;
