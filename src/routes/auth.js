import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import User from '../models/User.js';
import { config } from '../config.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { asyncHandler, badRequest, conflict, notFound, unauthorized } from '../utils/http.js';
import { saveWithUsername } from '../services/identity.js';

/** Credits whoever shared the link this player arrived from (their username, sent as `ref`). */
async function referrerFor(ref) {
  const handle = String(ref || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle)) return undefined;
  const referrer = await User.findOne({ username: handle }).select('_id').lean();
  return referrer?._id;
}

const router = Router();
const google = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// `created` lets the client tell a sign-up from a sign-in (for onboarding and analytics).
const respond = (res, user, created = false) => res.json({ token: signToken(user), user: user.toSelf(), created });

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name?.trim()) throw badRequest('Name is required');
    if (!EMAIL_RE.test(email || '')) throw badRequest('Enter a valid email');
    if (!password || password.length < 6) throw badRequest('Password must be at least 6 characters');
    if (await User.exists({ email: email.toLowerCase() })) throw conflict('An account with this email already exists');

    const user = new User({
      name: name.trim(),
      email,
      password: await bcrypt.hash(password, 12),
      referredBy: await referrerFor(req.body?.ref),
    });
    await saveWithUsername(user);
    respond(res, user, true);
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email: (email || '').toLowerCase() }).select('+password');
    if (!user?.password || !(await bcrypt.compare(password || '', user.password))) {
      throw unauthorized('Invalid email or password');
    }
    respond(res, user);
  })
);

router.post(
  '/google',
  asyncHandler(async (req, res) => {
    if (!google) throw badRequest('Google sign-in is not configured on this server');
    const ticket = await google
      .verifyIdToken({ idToken: req.body?.credential, audience: config.googleClientId })
      .catch(() => null);
    const payload = ticket?.getPayload();
    if (!payload?.email_verified) throw unauthorized('Google sign-in failed');

    let user = await User.findOne({ email: payload.email.toLowerCase() });
    let created = false;
    if (!user) {
      user = new User({
        name: payload.name || payload.email.split('@')[0],
        email: payload.email,
        googleId: payload.sub,
        avatar: payload.picture,
        referredBy: await referrerFor(req.body?.ref),
      });
      await saveWithUsername(user);
      created = true;
    } else if (!user.googleId) {
      user.googleId = payload.sub;
      user.avatar = user.avatar || payload.picture;
      await user.save();
    }
    respond(res, user, created);
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw notFound('User not found');
    res.json({ user: user.toSelf() });
  })
);

export default router;
