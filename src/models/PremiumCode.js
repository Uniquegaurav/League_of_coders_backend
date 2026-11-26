import mongoose from 'mongoose';

// A one-time code that unlocks Premium. Created with `npm run premium:code`.
// A code can be bound to one email (personal) or left open (first account to redeem it).
const premiumCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    label: { type: String, maxlength: 80 },
    boundEmail: { type: String, lowercase: true, trim: true },
    redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    redeemedAt: Date,
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model('PremiumCode', premiumCodeSchema);
