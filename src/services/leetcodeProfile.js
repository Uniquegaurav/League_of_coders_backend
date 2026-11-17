import { fetchUserProfile } from './leetcode.js';
import { HttpError } from '../utils/http.js';

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function fetchProfile(username, { fresh = false } = {}) {
  const key = username.toLowerCase();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.profile;
  const profile = await fetchUserProfile(username).catch((err) => {
    console.warn('[leetcode] profile lookup failed:', err.message);
    throw new HttpError(502, "Couldn't reach LeetCode right now. Please try again in a moment.");
  });
  cache.set(key, { profile, at: Date.now() });
  return profile;
}
