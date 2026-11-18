import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Async "beat my score": a fixed problem set and clock that anyone with the link can attempt solo, any time.
const attemptSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    name: String,
    avatar: String,
    matchCode: String, // the solo match for this attempt (empty for the creator's original run)
    status: { type: String, enum: ['playing', 'done'], default: 'playing' },
    score: { type: Number, default: 0 },
    solved: { type: Number, default: 0 },
    finishedAt: Date,
  },
  { _id: false }
);

const challengeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    creator: { type: ObjectId, ref: 'User', required: true },
    sourceMatch: String,
    name: { type: String, maxlength: 80 },
    durationMin: { type: Number, required: true },
    problems: {
      type: [
        {
          slug: String,
          frontendId: String,
          title: String,
          difficulty: String,
          tags: [String],
          basePoints: Number,
          _id: false,
        },
      ],
      default: [],
    },
    attempts: { type: [attemptSchema], default: [] },
  },
  { timestamps: true }
);

challengeSchema.index({ creator: 1, createdAt: -1 });

export default mongoose.model('Challenge', challengeSchema);
