import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const solveSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true },
    solvedAt: { type: Date, required: true },
    points: { type: Number, default: 0 },
    firstSolve: { type: Boolean, default: false },
  },
  { _id: false }
);

const participantSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    name: String,
    avatar: String,
    leetcodeUsername: String,
    leetcodeVerified: Boolean,
    excludeSolved: { type: Boolean, default: true },
    left: { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
    score: { type: Number, default: 0 },
    solves: { type: [solveSchema], default: [] },
    lastCheckedAt: Date,
    rank: Number,
    ratingBefore: Number,
    ratingAfter: Number,
    xp: Number, // XP earned from this battle
  },
  { _id: false }
);

const problemSchema = new mongoose.Schema(
  {
    slug: String,
    frontendId: String,
    title: String,
    difficulty: String,
    tags: [String],
    basePoints: Number,
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User' },
    name: String,
    kind: { type: String, enum: ['chat', 'system', 'solve'], default: 'chat' },
    text: { type: String, maxlength: 500 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const matchSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, maxlength: 60 },
    // Scheduled events (battle hour, Sunday Cup) have no host: the server starts them on time.
    host: { type: ObjectId, ref: 'User' },
    event: {
      key: String, // e.g. "daily-2026-11-19" or "cup-2026-11-22"; one match per key
      kind: { type: String, enum: ['daily', 'cup', 'special'] },
      description: String,
      startsAt: Date,
    },
    // Set on a solo attempt at an async "beat my score" challenge; problems come from the challenge.
    challengeCode: String,
    // Demo data created by `npm run seed:community`; removed by `npm run seed:community -- --remove`.
    seeded: { type: Boolean, default: false },
    visibility: { type: String, enum: ['public', 'private'], default: 'public' },
    status: {
      type: String,
      enum: ['lobby', 'countdown', 'live', 'finished', 'cancelled'],
      default: 'lobby',
    },
    settings: {
      durationMin: { type: Number, default: 45 },
      easy: { type: Number, default: 1 },
      medium: { type: Number, default: 2 },
      hard: { type: Number, default: 0 },
      pool: { type: String, enum: ['curated', 'all'], default: 'curated' },
      topics: { type: [String], default: [] },
      maxPlayers: { type: Number, default: 8 },
      solo: { type: Boolean, default: false },
    },
    participants: { type: [participantSchema], default: [] },
    problems: { type: [problemSchema], default: [] },
    selection: {
      poolSize: Number,
      excludedCount: Number,
      reusedSolved: Number,
    },
    messages: { type: [messageSchema], default: [] },
    startedAt: Date,
    endsAt: Date,
    finishedAt: Date,
    rematchCode: String,
    // Set when the match finishes: true only for official tournaments with 2+ players (they move rating).
    rated: Boolean,
  },
  { timestamps: true }
);

matchSchema.index({ status: 1, visibility: 1, createdAt: -1 });
matchSchema.index({ 'participants.user': 1, finishedAt: -1 });
matchSchema.index({ 'event.key': 1 }, { unique: true, partialFilterExpression: { 'event.key': { $type: 'string' } } });
matchSchema.index({ 'event.kind': 1, finishedAt: -1 });
matchSchema.index({ status: 1, finishedAt: -1 });

export default mongoose.model('Match', matchSchema);
