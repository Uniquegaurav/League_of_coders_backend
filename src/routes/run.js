import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, badRequest, HttpError } from '../utils/http.js';
import { LANGUAGES, RunnerError, judgeConfig, runCode } from '../services/runner.js';
import RunUsage from '../models/RunUsage.js';

// Compile / run code from the problem editor. Each run is a Judge0 call, and this site must never cost money:
// the site-wide daily cap (RUN_DAILY_CAP, default 50 = Judge0 CE's free plan on RapidAPI) is counted in the
// database so restarts cannot reset it. Players are also limited per minute and per day.
const router = Router();
const PER_MINUTE = 6;
const PER_DAY = Number(process.env.RUN_USER_DAILY) || 15;
export const DAILY_CAP = Number(process.env.RUN_DAILY_CAP) || 50;
const MAX_CODE = 64 * 1024;
const MAX_STDIN = 16 * 1024;

const usage = new Map(); // userId -> { minute, minuteCount, day, dayCount }

export function takeRun(userId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const minute = Math.floor(now / 60000);
  const u = usage.get(userId) || { minute, minuteCount: 0, day, dayCount: 0 };
  if (u.minute !== minute) Object.assign(u, { minute, minuteCount: 0 });
  if (u.day !== day) Object.assign(u, { day, dayCount: 0 });
  if (u.minuteCount >= PER_MINUTE) throw new HttpError(429, 'Too many runs in a minute. Wait a few seconds.');
  if (u.dayCount >= PER_DAY) throw new HttpError(429, `You've used today's ${PER_DAY} runs. They reset at midnight UTC.`);
  u.minuteCount += 1;
  u.dayCount += 1;
  usage.set(userId, u);
  if (usage.size > 20000) usage.delete(usage.keys().next().value);
}

const PAUSED = 'Running code is paused for today (free limit reached). Copy your code to LeetCode to run it.';

/** Atomically takes one run from today's site-wide budget, or refuses. */
export async function takeSiteRun(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    const doc = await RunUsage.findOneAndUpdate({ day, count: { $lt: DAILY_CAP } }, { $inc: { count: 1 } }, { upsert: true, new: true });
    return doc.count;
  } catch (err) {
    // Duplicate key: today's document exists and is already at the cap, so the upsert tried to insert another.
    if (err.code === 11000) throw new HttpError(429, PAUSED);
    throw err;
  }
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const used = (await RunUsage.findOne({ day: new Date().toISOString().slice(0, 10) }).lean())?.count || 0;
    res.json({ enabled: judgeConfig().configured, paused: used >= DAILY_CAP, languages: Object.keys(LANGUAGES), limits: { perMinute: PER_MINUTE, perDay: PER_DAY } });
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { language, code, stdin = '' } = req.body || {};
    if (!LANGUAGES[language]) throw badRequest('Pick C++, Java, Python, JavaScript or Kotlin');
    if (typeof code !== 'string' || !code.trim()) throw badRequest('Write some code first');
    if (code.length > MAX_CODE) throw badRequest('Code is too long (64 KB max)');
    if (typeof stdin !== 'string' || stdin.length > MAX_STDIN) throw badRequest('Input is too long (16 KB max)');
    if (!judgeConfig().configured) throw new HttpError(503, "Running code isn't set up on the server yet.");
    takeRun(String(req.userId));
    await takeSiteRun();
    try {
      res.json(await runCode({ language, code, stdin }));
    } catch (err) {
      if (err instanceof RunnerError) throw new HttpError(err.status, err.message);
      throw err;
    }
  })
);

export default router;
