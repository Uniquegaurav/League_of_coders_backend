import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// Encrypts secrets we must keep (a player's LeetCode session) with AES-256-GCM.
// The key comes from PREMIUM_SECRET, falling back to JWT_SECRET so local dev works without extra setup.
const key = () => createHash('sha256').update(process.env.PREMIUM_SECRET || config.jwtSecret).digest();

export function seal(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function open(sealed) {
  if (!sealed) return null;
  try {
    const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Codes are stored hashed, so a database leak does not leak redeemable codes. */
export const hashCode = (code) => createHash('sha256').update(normalizeCode(code)).digest('hex');
export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Human-friendly code like LOC-7KQ2-M9XA-P4TD (no 0/O/1/I to avoid misreads). */
export function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `LOC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
