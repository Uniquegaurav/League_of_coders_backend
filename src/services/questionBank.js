import { readFileSync } from 'node:fs';
import Problem from '../models/Problem.js';
import { SCORING } from '../config.js';
import { shuffle } from '../utils/random.js';
import { badRequest, notFound } from '../utils/http.js';
import { fetchProblemDetail, fetchProblemPage } from './leetcode.js';

const curated = JSON.parse(readFileSync(new URL('../data/curated.json', import.meta.url), 'utf8'));

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 7 * DAY_MS;

export async function seedCurated() {
  await Problem.bulkWrite(
    curated.map((q) => ({
      updateOne: {
        filter: { slug: q.slug },
        update: {
          $set: { curated: true, patterns: q.patterns, companies: q.companies },
          $setOnInsert: { title: q.title, difficulty: q.difficulty, paidOnly: q.premium },
        },
        upsert: true,
      },
    }))
  );
}

let syncing = false;

// Mirrors LeetCode's public problem list (titles, difficulty, tags) so matches can draw from all ~4k problems.
export async function syncLeetCodeCatalog({ force = false } = {}) {
  if (syncing) return;
  const latest = await Problem.findOne({ frontendId: { $exists: true } }).sort({ updatedAt: -1 }).lean();
  if (!force && latest && Date.now() - new Date(latest.updatedAt).getTime() < DAY_MS) return;

  syncing = true;
  try {
    let skip = 0;
    let total = Infinity;
    while (skip < total) {
      const page = await fetchProblemPage(skip, 100);
      total = page.total;
      if (!page.problems.length) break;
      await Problem.bulkWrite(
        page.problems.map((p) => ({
          updateOne: { filter: { slug: p.slug }, update: { $set: p }, upsert: true },
        }))
      );
      skip += page.problems.length;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`[bank] synced ${skip} LeetCode problems`);
  } catch (err) {
    console.warn('[bank] LeetCode sync failed, falling back to the curated list:', err.message);
  } finally {
    syncing = false;
  }
}

const poolFilter = ({ pool, topics }) => {
  const filter = { paidOnly: false };
  if (pool !== 'all') filter.curated = true;
  if (topics?.length) filter.$or = [{ tags: { $in: topics } }, { patterns: { $in: topics } }];
  return filter;
};

export async function listTopics(pool = 'curated') {
  const filter = poolFilter({ pool });
  const [tags, patterns] = await Promise.all([
    Problem.distinct('tags', filter),
    pool === 'all' ? [] : Problem.distinct('patterns', filter),
  ]);
  return [...new Set([...tags, ...patterns])].filter(Boolean).sort();
}

/**
 * Picks problems for a match.
 *  1. Builds the pool (curated or all free LeetCode problems, optionally narrowed to topics).
 *  2. Removes anything in `excludeSlugs` (problems already solved by players who opted in).
 *  3. Shuffles each difficulty bucket with Fisher–Yates and takes the requested count.
 *  4. If exclusion leaves a bucket short, tops it up with previously-solved problems and reports it.
 * Problems are returned ordered Easy → Medium → Hard.
 */
export async function selectProblems(settings, excludeSlugs = new Set()) {
  const base = poolFilter(settings);
  const wanted = [
    ['Easy', settings.easy],
    ['Medium', settings.medium],
    ['Hard', settings.hard],
  ];
  const picked = [];
  let poolSize = 0;
  let excludedCount = 0;
  let reusedSolved = 0;

  for (const [difficulty, count] of wanted) {
    if (!count) continue;
    const candidates = await Problem.find({ ...base, difficulty })
      .select('slug frontendId title difficulty tags patterns')
      .lean();
    poolSize += candidates.length;

    const fresh = candidates.filter((p) => !excludeSlugs.has(p.slug));
    const solved = candidates.filter((p) => excludeSlugs.has(p.slug));
    excludedCount += solved.length;

    const chosen = shuffle(fresh).slice(0, count);
    if (chosen.length < count) {
      const topUp = shuffle(solved).slice(0, count - chosen.length);
      reusedSolved += topUp.length;
      chosen.push(...topUp);
    }
    if (chosen.length < count) {
      throw badRequest(
        `Only ${candidates.length} ${difficulty} problem(s) match these settings. Lower the count or widen the topics.`
      );
    }
    picked.push(
      ...chosen.map((p) => ({
        slug: p.slug,
        frontendId: p.frontendId,
        title: p.title,
        difficulty: p.difficulty,
        tags: p.tags?.length ? p.tags : p.patterns,
        basePoints: SCORING.base[p.difficulty],
      }))
    );
  }

  return { problems: picked, poolSize, excludedCount, reusedSolved };
}

export async function getProblemDetail(slug) {
  let problem = await Problem.findOne({ slug });
  const stale = !problem?.detail?.fetchedAt || Date.now() - problem.detail.fetchedAt.getTime() > DETAIL_TTL_MS;
  if (stale) {
    try {
      const fresh = await fetchProblemDetail(slug);
      if (!fresh && !problem) throw notFound('Problem not found');
      if (fresh) {
        problem = await Problem.findOneAndUpdate({ slug }, { $set: { slug, ...fresh } }, { upsert: true, new: true });
      }
    } catch (err) {
      if (!problem) throw err.status ? err : notFound('Problem could not be loaded from LeetCode');
    }
  }
  return {
    ...problem.toSummary(),
    content: problem.detail?.content || null,
    hints: problem.detail?.hints || [],
    exampleTestcases: problem.detail?.exampleTestcases || [],
    snippets: problem.detail?.snippets || [],
  };
}
