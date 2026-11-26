import mongoose from 'mongoose';
import { practiceView } from '../services/progression.js';

export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** What the player may see about their own Premium (never the session itself). */
export function premiumView(user) {
  const p = user.premium || {};
  const s = p.session || {};
  return {
    active: !!p.active,
    since: p.since || null,
    leetcode: s.sealed ? { username: s.username || null, status: s.status || 'ok', checkedAt: s.checkedAt || null, syncedAt: s.syncedAt || null } : null,
  };
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Public handle used in profile URLs (/u/:username). Lowercase letters, digits, - and _.
    username: { type: String, lowercase: true, trim: true },
    college: { type: String, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, select: false },
    googleId: { type: String },
    avatar: { type: String },
    leetcode: {
      username: { type: String, lowercase: true, trim: true },
      displayName: { type: String },
      avatar: { type: String },
      verified: { type: Boolean, default: false },
      verifyToken: { type: String },
    },
    // A LeetCode account the player is trying to link. It only becomes `leetcode` once ownership is proven.
    leetcodeClaim: {
      username: { type: String, lowercase: true, trim: true },
      displayName: { type: String },
      avatar: { type: String },
      token: { type: String },
      createdAt: { type: Date },
    },
    stats: {
      rating: { type: Number, default: 1200 },
      matches: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      points: { type: Number, default: 0 },
      solved: { type: Number, default: 0 },
      // Official tournaments played (battle hour, Sunday Cup, planned). Only these move rating.
      ratedEvents: { type: Number, default: 0 },
    },
    // Premium: unlocked with a code. The LeetCode session is stored encrypted (services/secretBox.js), is never sent
    // back to any client, and is only used to fetch this player's own lists and company lists.
    premium: {
      active: { type: Boolean, default: false },
      since: Date,
      code: { type: mongoose.Schema.Types.ObjectId, ref: 'PremiumCode' },
      session: {
        sealed: String,
        csrfSealed: String,
        username: String,
        status: { type: String, enum: ['ok', 'expired'] },
        checkedAt: Date,
        syncedAt: Date,
      },
    },
    // Problems solved on this platform (matches + practice marks); powers the "exclude solved" filter.
    solvedSlugs: { type: [String], default: [] },
    practice: {
      xp: { type: Number, default: 0 },
      streak: { type: Number, default: 0 },
      bestStreak: { type: Number, default: 0 },
      lastActiveDay: { type: String },
      dailyDay: { type: String },
      // XP earned this week (resets on Monday UTC) and last week's total for the recap email.
      weekKey: { type: String },
      weekXp: { type: Number, default: 0 },
      prevWeekKey: { type: String },
      prevWeekXp: { type: Number, default: 0 },
      // Daily cap on self-reported practice XP.
      practiceXpDay: { type: String },
      practiceXpToday: { type: Number, default: 0 },
    },
    friends: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    // Referrals: who brought this player in, and whether the reward was paid (after their first finished battle).
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralRewarded: { type: Boolean, default: false },
    referralCount: { type: Number, default: 0 },
    // Demo players created by `npm run seed:community` (removable with `-- --remove`). They cannot sign in.
    bot: { type: Boolean, default: false },
    badges: {
      type: [{ key: String, at: { type: Date, default: Date.now }, _id: false }],
      default: [],
    },
    emailPrefs: {
      streak: { type: Boolean, default: true },
      challenges: { type: Boolean, default: true },
      weekly: { type: Boolean, default: true },
    },
    // Dedupe keys so a reminder goes out at most once per day / week.
    lastEmails: {
      streakDay: String,
      weeklyKey: String,
    },
  },
  { timestamps: true }
);

userSchema.index(
  { 'leetcode.username': 1 },
  { unique: true, partialFilterExpression: { 'leetcode.username': { $type: 'string' } } }
);
userSchema.index({ 'stats.rating': -1 });
userSchema.index({ 'practice.xp': -1 });
userSchema.index({ 'practice.weekKey': 1, 'practice.weekXp': -1 });
userSchema.index({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: 'string' } } });
userSchema.index({ college: 1, 'stats.rating': -1 });

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    username: this.username || null,
    name: this.name,
    college: this.college || null,
    avatar: this.avatar || this.leetcode?.avatar || null,
    leetcode: this.leetcode?.username
      ? { username: this.leetcode.displayName || this.leetcode.username, verified: !!this.leetcode.verified }
      : null,
    stats: this.stats,
    practice: practiceView(this),
    badges: (this.badges || []).map((b) => ({ key: b.key, at: b.at })),
    referralCount: this.referralCount || 0,
    createdAt: this.createdAt,
  };
};

userSchema.methods.toSelf = function toSelf() {
  return {
    ...this.toPublic(),
    email: this.email,
    leetcodeVerifyToken: this.leetcode?.verified ? null : this.leetcode?.verifyToken || null,
    leetcodeClaim: this.leetcodeClaim?.username
      ? {
          username: this.leetcodeClaim.displayName || this.leetcodeClaim.username,
          token: this.leetcodeClaim.token,
          expiresAt: new Date(new Date(this.leetcodeClaim.createdAt).getTime() + CLAIM_TTL_MS),
        }
      : null,
    solvedCount: this.solvedSlugs.length,
    premium: premiumView(this),
    emailPrefs: {
      streak: this.emailPrefs?.streak !== false,
      challenges: this.emailPrefs?.challenges !== false,
      weekly: this.emailPrefs?.weekly !== false,
    },
  };
};

export default mongoose.model('User', userSchema);
