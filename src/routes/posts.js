import { Router } from 'express';
import mongoose from 'mongoose';
import Post from '../models/Post.js';
import User from '../models/User.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, clampInt, forbidden, notFound } from '../utils/http.js';

const router = Router();

const serialize = (post, viewerId) => ({
  id: post._id.toString(),
  kind: post.kind,
  title: post.title,
  body: post.body,
  link: post.link || null,
  tags: post.tags,
  matchCode: post.matchCode || null,
  author: { id: post.author.toString(), name: post.authorName, avatar: post.authorAvatar || null },
  likes: post.likes.length,
  liked: !!viewerId && post.likes.some((id) => id.toString() === viewerId),
  comments: post.comments.map((c) => ({
    id: c._id.toString(),
    body: c.body,
    createdAt: c.createdAt,
    author: { id: c.author.toString(), name: c.authorName, avatar: c.authorAvatar || null },
  })),
  createdAt: post.createdAt,
});

const loadPost = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw notFound('Post not found');
  const post = await Post.findById(id);
  if (!post) throw notFound('Post not found');
  return post;
};

const loadUser = async (id) => {
  const user = await User.findById(id).select('name avatar leetcode');
  if (!user) throw notFound('User not found');
  return user;
};

const cleanLink = (link) => {
  if (!link) return undefined;
  const value = String(link).trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw badRequest('Link must be a valid http(s) URL');
  }
};

router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const page = clampInt(req.query.page, 1, 500, 1);
    const limit = clampInt(req.query.limit, 1, 50, 20);
    const filter = {};
    if (req.query.tag) filter.tags = String(req.query.tag).toLowerCase();
    if (['discussion', 'announcement', 'match'].includes(req.query.kind)) filter.kind = req.query.kind;
    const [total, posts] = await Promise.all([
      Post.countDocuments(filter),
      Post.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    ]);
    res.json({ total, page, posts: posts.map((p) => serialize(p, req.userId)) });
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { title, body, link, tags, matchCode } = req.body || {};
    if (!title?.trim()) throw badRequest('Give your post a title');
    const user = await loadUser(req.userId);
    const post = await Post.create({
      author: user._id,
      authorName: user.name,
      authorAvatar: user.avatar || user.leetcode?.avatar,
      kind: matchCode ? 'match' : 'discussion',
      title: title.trim().slice(0, 140),
      body: String(body || '').trim().slice(0, 8000),
      link: cleanLink(link),
      tags: (Array.isArray(tags) ? tags : String(tags || '').split(','))
        .map((t) => String(t).trim().toLowerCase().replace(/^#/, ''))
        .filter(Boolean)
        .slice(0, 5),
      matchCode: matchCode ? String(matchCode).toUpperCase().slice(0, 10) : undefined,
    });
    res.status(201).json({ post: serialize(post, req.userId) });
  })
);

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await loadPost(req.params.id);
    if (post.author.toString() !== req.userId) throw forbidden('You can only delete your own posts');
    await post.deleteOne();
    res.json({ id: req.params.id });
  })
);

router.post(
  '/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await loadPost(req.params.id);
    const liked = post.likes.some((id) => id.toString() === req.userId);
    const updated = await Post.findByIdAndUpdate(
      post._id,
      liked ? { $pull: { likes: req.userId } } : { $addToSet: { likes: req.userId } },
      { new: true }
    );
    res.json({ post: serialize(updated, req.userId) });
  })
);

router.post(
  '/:id/comments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = String(req.body?.body || '').trim();
    if (!body) throw badRequest('Comment is empty');
    const post = await loadPost(req.params.id);
    const user = await loadUser(req.userId);
    post.comments.push({
      author: user._id,
      authorName: user.name,
      authorAvatar: user.avatar || user.leetcode?.avatar,
      body: body.slice(0, 2000),
    });
    await post.save();
    res.status(201).json({ post: serialize(post, req.userId) });
  })
);

router.delete(
  '/:id/comments/:commentId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const post = await loadPost(req.params.id);
    const comment = post.comments.id(req.params.commentId);
    if (!comment) throw notFound('Comment not found');
    if (comment.author.toString() !== req.userId && post.author.toString() !== req.userId) {
      throw forbidden('You can only delete your own comments');
    }
    comment.deleteOne();
    await post.save();
    res.json({ post: serialize(post, req.userId) });
  })
);

export default router;
