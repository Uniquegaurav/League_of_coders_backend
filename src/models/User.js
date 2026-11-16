import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
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
    stats: {
      rating: { type: Number, default: 1200 },
      matches: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      points: { type: Number, default: 0 },
      solved: { type: Number, default: 0 },
    },
    // Problems solved on this platform (matches + practice marks); powers the "exclude solved" filter.
    solvedSlugs: { type: [String], default: [] },
  },
  { timestamps: true }
);

userSchema.index(
  { 'leetcode.username': 1 },
  { unique: true, partialFilterExpression: { 'leetcode.username': { $type: 'string' } } }
);
userSchema.index({ 'stats.rating': -1 });

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    name: this.name,
    avatar: this.avatar || this.leetcode?.avatar || null,
    leetcode: this.leetcode?.username
      ? { username: this.leetcode.displayName || this.leetcode.username, verified: !!this.leetcode.verified }
      : null,
    stats: this.stats,
    createdAt: this.createdAt,
  };
};

userSchema.methods.toSelf = function toSelf() {
  return {
    ...this.toPublic(),
    email: this.email,
    leetcodeVerifyToken: this.leetcode?.verified ? null : this.leetcode?.verifyToken || null,
    solvedCount: this.solvedSlugs.length,
  };
};

export default mongoose.model('User', userSchema);
