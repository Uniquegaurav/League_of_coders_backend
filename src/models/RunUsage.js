import mongoose from 'mongoose';

// Site-wide count of code runs per UTC day. Kept in the database (not memory) so restarts or several server
// instances can never push us past the free Judge0 quota.
const runUsageSchema = new mongoose.Schema({
  day: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
});

export default mongoose.model('RunUsage', runUsageSchema);
