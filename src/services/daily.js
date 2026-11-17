import Problem from '../models/Problem.js';
import { dayHash, todayKey } from './progression.js';

const cache = new Map(); // day -> slug

/** Problem of the day: a deterministic pick from the curated, free pool. */
export async function dailySlug(day = todayKey()) {
  if (cache.has(day)) return cache.get(day);
  const slugs = (await Problem.find({ curated: true, paidOnly: false }).select('slug').sort({ slug: 1 }).lean()).map(
    (p) => p.slug
  );
  if (!slugs.length) return null;
  const slug = slugs[dayHash(day) % slugs.length];
  if (cache.size > 7) cache.clear();
  cache.set(day, slug);
  return slug;
}
