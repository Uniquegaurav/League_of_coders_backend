import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const inviteSchema = new mongoose.Schema(
  {
    from: { type: ObjectId, ref: 'User', required: true },
    to: { type: ObjectId, ref: 'User', required: true },
    matchCode: { type: String, required: true },
    status: { type: String, enum: ['pending', 'dismissed'], default: 'pending' },
  },
  { timestamps: true }
);

inviteSchema.index({ to: 1, status: 1, createdAt: -1 });
inviteSchema.index({ from: 1, to: 1, matchCode: 1 }, { unique: true });
// Invites are only useful while a lobby is open; let Mongo clean them up.
inviteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 60 * 60 });

export default mongoose.model('Invite', inviteSchema);
