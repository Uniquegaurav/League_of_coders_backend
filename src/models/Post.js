import mongoose from 'mongoose';

const commentSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: String,
    authorAvatar: String,
    body: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: true }
);

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: String,
    authorAvatar: String,
    kind: { type: String, enum: ['discussion', 'announcement', 'match'], default: 'discussion' },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, default: '', maxlength: 8000 },
    link: { type: String, maxlength: 500 },
    tags: { type: [String], default: [] },
    matchCode: String,
    likes: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    comments: { type: [commentSchema], default: [] },
  },
  { timestamps: true }
);

postSchema.index({ createdAt: -1 });

export default mongoose.model('Post', postSchema);
