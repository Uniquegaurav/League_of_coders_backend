import mongoose from 'mongoose';

// A named, ordered set of problems. Curated lists (Blind 75, Top Interview 150, ...) are synced from public
// sources; custom lists belong to one player; premium lists are imported with that player's own LeetCode session.
const problemListSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 60 },
    description: { type: String, maxlength: 300 },
    source: { type: String, enum: ['leetcode', 'neetcode', 'custom', 'premium'], required: true },
    // Premium lists only: imported from the owner's LeetCode ('favorite') or a company's questions ('company').
    kind: { type: String, enum: ['favorite', 'company'] },
    company: String,
    period: String,
    sourceUrl: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    order: { type: Number, default: 100 },
    groups: { type: [{ name: String, slugs: [String], _id: false }], default: [] },
    slugs: { type: [String], default: [] },
    syncedAt: Date,
  },
  { timestamps: true }
);

problemListSchema.index({ owner: 1, updatedAt: -1 });

export default mongoose.model('ProblemList', problemListSchema);
