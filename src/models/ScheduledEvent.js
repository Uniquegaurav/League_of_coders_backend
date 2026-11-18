import mongoose from 'mongoose';

// One-off tournaments planned ahead (e.g. "DP Marathon"). The scheduler opens their lobby 30 minutes before
// `startsAt` and starts them like the daily battle hour.
const scheduledEventSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 60 },
    description: { type: String, maxlength: 300 },
    startsAt: { type: Date, required: true },
    settings: {
      durationMin: Number,
      easy: Number,
      medium: Number,
      hard: Number,
      pool: { type: String, default: 'curated' },
      topics: { type: [String], default: [] },
      maxPlayers: { type: Number, default: 20 },
    },
    seeded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

scheduledEventSchema.index({ startsAt: 1 });

export default mongoose.model('ScheduledEvent', scheduledEventSchema);
