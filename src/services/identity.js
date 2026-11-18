import mongoose from 'mongoose';
import User from '../models/User.js';

// Public handles: 3-30 chars, starts with a letter or digit, then letters, digits, - or _.
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESERVED = new Set(['me', 'admin', 'api', 'login', 'new', 'settings', 'leaderboard', 'support', 'league', 'system']);

export function validateUsername(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!USERNAME_RE.test(value)) return { error: 'Use 3-30 letters, numbers, - or _, starting with a letter or number' };
  if (RESERVED.has(value)) return { error: 'That username is reserved' };
  if (/^[a-f0-9]{24}$/.test(value)) return { error: 'Pick a username that is not a 24-character code' };
  return { value };
}

/** Turns any text into a username-shaped base, e.g. "Rahul Sharma" -> "rahul-sharma". */
export function usernameBase(text) {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 22);
  return base.length >= 3 && !RESERVED.has(base) ? base : `coder${base ? `-${base}` : ''}`.slice(0, 22);
}

const randomSuffix = () => String(Math.floor(1000 + Math.random() * 9000));

/** Picks a free username for a user (mutates; caller saves). Prefers the LeetCode handle, then the name. */
export async function assignUsername(user) {
  if (user.username) return user.username;
  const base = usernameBase(user.leetcode?.username || user.name || user.email?.split('@')[0]);
  const candidates = [base, ...Array.from({ length: 8 }, () => `${base}-${randomSuffix()}`)];
  for (const candidate of candidates) {
    if (!(await User.exists({ username: candidate }))) {
      user.username = candidate;
      return candidate;
    }
  }
  user.username = `${base}-${Date.now().toString(36)}`;
  return user.username;
}

/** Saves a user that may have just been given a username, retrying once if another player took it first. */
export async function saveWithUsername(user) {
  try {
    await assignUsername(user);
    return await user.save();
  } catch (err) {
    if (err.code !== 11000 || !err.keyPattern?.username) throw err;
    user.username = undefined;
    await assignUsername(user);
    return user.save();
  }
}

/** One-off migration for accounts created before usernames existed. */
export async function backfillUsernames() {
  const users = await User.find({ username: { $exists: false } }).limit(5000);
  for (const user of users) {
    await saveWithUsername(user).catch((err) => console.warn('[identity] backfill failed', String(user._id), err.message));
  }
  if (users.length) console.log(`[identity] gave ${users.length} player(s) a username`);
}

export function normalizeCollege(raw) {
  const value = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return value || null;
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds a player by username or (older links) by id. */
export function findByHandle(handle) {
  const raw = String(handle || '').trim();
  if (mongoose.isValidObjectId(raw) && /^[a-f0-9]{24}$/i.test(raw)) return User.findById(raw);
  return User.findOne({ username: raw.toLowerCase() });
}
