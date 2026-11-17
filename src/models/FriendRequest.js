import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const friendRequestSchema = new mongoose.Schema(
  {
    from: { type: ObjectId, ref: 'User', required: true },
    to: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  },
  { timestamps: true }
);

friendRequestSchema.index({ to: 1, status: 1 });
friendRequestSchema.index({ from: 1, status: 1 });

export default mongoose.model('FriendRequest', friendRequestSchema);
