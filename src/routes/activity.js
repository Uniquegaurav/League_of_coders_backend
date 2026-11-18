import { Router } from 'express';
import Match from '../models/Match.js';
import { asyncHandler } from '../utils/http.js';
import { compareStanding } from '../services/scoring.js';

// "Happening now" for the Compete page: live public battles and the latest solves and wins.
// Built from match documents only (no LeetCode calls) and cached for a few seconds for everyone.
const router = Router();
const TTL_MS = 10 * 1000;
let cached = null;

async function build() {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const [live, recent] = await Promise.all([
    Match.find({ visibility: 'public', status: { $in: ['countdown', 'live'] } })
      .sort({ startedAt: -1 })
      .limit(6)
      .select('code name status endsAt participants.name participants.avatar participants.left participants.score event.kind')
      .lean(),
    Match.find({
      visibility: 'public',
      'settings.solo': { $ne: true },
      $or: [{ status: 'live' }, { status: 'finished', finishedAt: { $gte: since } }],
    })
      .sort({ finishedAt: -1 })
      .limit(25)
      .select('code name status finishedAt problems.slug problems.title problems.difficulty participants event.kind')
      .lean(),
  ]);

  const feed = [];
  for (const m of recent) {
    const titles = new Map(m.problems.map((p) => [p.slug, p]));
    for (const p of m.participants) {
      for (const s of p.solves || []) {
        const problem = titles.get(s.slug);
        if (!problem) continue;
        feed.push({ type: 'solve', at: s.solvedAt, name: p.name, avatar: p.avatar || null, problem: problem.title, difficulty: problem.difficulty, firstSolve: !!s.firstSolve, match: { code: m.code, name: m.name } });
      }
    }
    if (m.status === 'finished' && m.participants.length >= 2) {
      const winner = [...m.participants].sort(compareStanding)[0];
      if (winner?.score > 0) {
        feed.push({ type: 'win', at: m.finishedAt, name: winner.name, avatar: winner.avatar || null, score: winner.score, players: m.participants.length, event: m.event?.kind || null, match: { code: m.code, name: m.name } });
      }
    }
  }
  const now = Date.now();
  const valid = feed.filter((f) => f.at && new Date(f.at).getTime() <= now);
  valid.sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    live: live.map((m) => {
      const active = m.participants.filter((p) => !p.left);
      return {
        code: m.code,
        name: m.name,
        status: m.status,
        endsAt: m.endsAt,
        event: m.event?.kind || null,
        players: active.length,
        avatars: active.slice(0, 5).map((p) => ({ name: p.name, avatar: p.avatar || null })),
      };
    }),
    feed: valid.slice(0, 14),
  };
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    if (!cached || Date.now() - cached.at > TTL_MS) cached = { at: Date.now(), data: await build() };
    res.set('Cache-Control', 'public, max-age=10');
    res.json({ ...cached.data, serverNow: Date.now() });
  })
);

export default router;
