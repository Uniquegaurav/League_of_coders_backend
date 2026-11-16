import mongoose from 'mongoose';

const problemSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    frontendId: { type: String },
    title: { type: String, required: true },
    difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], required: true },
    paidOnly: { type: Boolean, default: false },
    acRate: { type: Number },
    tags: { type: [String], default: [] },
    // Present only for problems in the hand-picked interview list.
    curated: { type: Boolean, default: false },
    patterns: { type: [String], default: [] },
    companies: { type: [String], default: [] },
    detail: {
      content: String,
      hints: [String],
      exampleTestcases: [String],
      snippets: [{ _id: false, lang: String, langSlug: String, code: String }],
      fetchedAt: Date,
    },
  },
  { timestamps: true }
);

problemSchema.index({ difficulty: 1, paidOnly: 1, curated: 1 });
problemSchema.index({ tags: 1 });

problemSchema.methods.toSummary = function toSummary() {
  return {
    slug: this.slug,
    frontendId: this.frontendId,
    title: this.title,
    difficulty: this.difficulty,
    paidOnly: this.paidOnly,
    acRate: this.acRate,
    tags: this.tags.length ? this.tags : this.patterns,
    curated: this.curated,
    url: `https://leetcode.com/problems/${this.slug}/`,
  };
};

export default mongoose.model('Problem', problemSchema);
