import Problem from '../models/Problem.js';
import ProblemList from '../models/ProblemList.js';
import { fetchStudyPlan } from './leetcode.js';

// Well-known interview lists, fetched from their public sources about once a week and stored in the database.
// Players only ever read from the database, so lists cost no LeetCode calls per visit.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NEETCODE_URL = 'https://raw.githubusercontent.com/neetcode-gh/leetcode/main/.problemSiteData.json';

export const CURATED_LISTS = [
  { key: 'blind-75', name: 'Blind 75', description: 'The classic 75 interview questions, grouped by pattern. Premium-only problems are left out.', source: 'neetcode', flag: 'blind75', sourceUrl: 'https://neetcode.io/practice', order: 1 },
  { key: 'neetcode-150', name: 'NeetCode 150', description: 'Blind 75 plus 75 more, grouped by pattern. Premium-only problems are left out.', source: 'neetcode', flag: 'neetcode150', sourceUrl: 'https://neetcode.io/practice', order: 2 },
  { key: 'top-interview-150', name: 'Top Interview 150', description: 'LeetCode’s own study plan for interview prep.', source: 'leetcode', plan: 'top-interview-150', sourceUrl: 'https://leetcode.com/studyplan/top-interview-150/', order: 3 },
  { key: 'leetcode-75', name: 'LeetCode 75', description: 'LeetCode’s 75-question plan for a short runway.', source: 'leetcode', plan: 'leetcode-75', sourceUrl: 'https://leetcode.com/studyplan/leetcode-75/', order: 4 },
  { key: 'top-100-liked', name: 'Top 100 Liked', description: 'The 100 most liked problems on LeetCode.', source: 'leetcode', plan: 'top-100-liked', sourceUrl: 'https://leetcode.com/studyplan/top-100-liked/', order: 5 },
];

async function loadNeetcode() {
  const res = await fetch(NEETCODE_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`NeetCode data responded with ${res.status}`);
  return res.json();
}

/** Groups in source order, e.g. [{ name: 'Arrays & Hashing', slugs: [...] }]. Also returns problem stubs. */
function neetcodeGroups(rows, flag) {
  const groups = new Map();
  const stubs = [];
  for (const row of rows) {
    if (!row[flag] || row.premium) continue;
    const slug = String(row.link || '').replace(/\/$/, '');
    if (!slug) continue;
    if (!groups.has(row.pattern)) groups.set(row.pattern, []);
    groups.get(row.pattern).push(slug);
    stubs.push({ slug, title: row.problem, difficulty: row.difficulty, paidOnly: false });
  }
  return { groups: [...groups].map(([name, slugs]) => ({ name, slugs })), stubs };
}

const normalizeDifficulty = (d) => {
  const v = String(d || '').toLowerCase();
  return v ? v[0].toUpperCase() + v.slice(1) : v;
};

function planGroups(plan) {
  const stubs = [];
  const groups = plan.planSubGroups.map((g) => ({
    name: g.name,
    slugs: g.questions
      .filter((q) => !q.paidOnly)
      .map((q) => {
        stubs.push({ slug: q.titleSlug, title: q.title, difficulty: normalizeDifficulty(q.difficulty), paidOnly: false });
        return q.titleSlug;
      }),
  }));
  return { groups, stubs };
}

// Lists can mention problems the catalogue mirror has not stored yet; add minimal rows so they display.
async function ensureProblems(stubs) {
  const valid = stubs.filter((s) => ['Easy', 'Medium', 'Hard'].includes(s.difficulty));
  if (!valid.length) return;
  await Problem.bulkWrite(
    valid.map((s) => ({ updateOne: { filter: { slug: s.slug }, update: { $setOnInsert: s }, upsert: true } })),
    { ordered: false, timestamps: false }
  );
}

let syncing = false;

export async function syncCuratedLists({ force = false } = {}) {
  if (syncing) return;
  syncing = true;
  try {
    const existing = new Map((await ProblemList.find({ source: { $ne: 'custom' } }).select('key syncedAt').lean()).map((l) => [l.key, l]));
    const due = CURATED_LISTS.filter((def) => force || !existing.get(def.key)?.syncedAt || Date.now() - new Date(existing.get(def.key).syncedAt).getTime() > WEEK_MS);
    if (!due.length) return;
    let neetcode = null;
    for (const def of due) {
      try {
        let built;
        if (def.source === 'neetcode') {
          neetcode = neetcode || (await loadNeetcode());
          built = neetcodeGroups(neetcode, def.flag);
        } else {
          const plan = await fetchStudyPlan(def.plan);
          if (!plan) throw new Error('plan not found');
          built = planGroups(plan);
        }
        await ensureProblems(built.stubs);
        const { flag, plan, ...meta } = def;
        await ProblemList.updateOne(
          { key: def.key },
          { $set: { ...meta, groups: built.groups, slugs: built.groups.flatMap((g) => g.slugs), syncedAt: new Date() } },
          { upsert: true }
        );
        console.log(`[lists] synced ${def.key} (${built.stubs.length} problems)`);
      } catch (err) {
        console.warn(`[lists] could not sync ${def.key}:`, err.message);
      }
    }
  } finally {
    syncing = false;
  }
}

export function startListSync() {
  const run = () => syncCuratedLists().catch((err) => console.warn('[lists] sync failed', err.message));
  setTimeout(run, 15 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
}
