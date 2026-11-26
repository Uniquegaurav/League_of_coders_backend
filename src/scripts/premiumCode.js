// Creates, lists or revokes Premium codes.
//   npm run premium:code -- --for you@example.com      personal code: only this account can redeem it
//   npm run premium:code -- --count 5 --label beta     open codes: each works once, for any account
//   npm run premium:code -- --list
//   npm run premium:code -- --revoke LOC-XXXX-XXXX-XXXX
import mongoose from 'mongoose';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import PremiumCode from '../models/PremiumCode.js';
import User from '../models/User.js';
import { generateCode, hashCode } from '../services/secretBox.js';

const { values } = parseArgs({
  options: {
    for: { type: 'string' },
    count: { type: 'string', default: '1' },
    label: { type: 'string' },
    list: { type: 'boolean', default: false },
    revoke: { type: 'string' },
  },
});

if (!config.mongoUrl) throw new Error('CONNECTION_URL is not set');
await mongoose.connect(config.mongoUrl);

try {
  if (values.list) {
    const codes = await PremiumCode.find().sort({ createdAt: -1 }).populate('redeemedBy', 'email').lean();
    for (const c of codes) {
      const state = c.revoked ? 'revoked' : c.redeemedBy ? `redeemed by ${c.redeemedBy.email}` : 'unused';
      console.log(`${c.createdAt.toISOString().slice(0, 10)}  ${c.label || '-'}  ${c.boundEmail ? `for ${c.boundEmail}` : 'open'}  ${state}`);
    }
  } else if (values.revoke) {
    const code = await PremiumCode.findOneAndUpdate({ codeHash: hashCode(values.revoke) }, { revoked: true }, { new: true });
    if (!code) console.log('No such code.');
    else {
      if (code.redeemedBy) await User.updateOne({ _id: code.redeemedBy, 'premium.code': code._id }, { $set: { 'premium.active': false } });
      console.log('Revoked.');
    }
  } else {
    const email = values.for?.trim().toLowerCase();
    const n = Math.min(100, Math.max(1, Number(values.count) || 1));
    for (let i = 0; i < n; i += 1) {
      const code = generateCode();
      await PremiumCode.create({ codeHash: hashCode(code), label: values.label, boundEmail: email });
      console.log(code);
    }
    console.log(email ? `Personal code(s) for ${email}. Only that account can redeem them.` : 'Open code(s). Each works once.');
    console.log('Codes are stored hashed: copy them now, they cannot be shown again.');
  }
} finally {
  await mongoose.disconnect();
}
