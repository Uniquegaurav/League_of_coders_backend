import PremiumCode from '../models/PremiumCode.js';
import ProblemList from '../models/ProblemList.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../utils/http.js';
import { hashCode, normalizeCode, open, seal } from './secretBox.js';
import { COMPANY_PERIODS, SessionError, fetchCompanyQuestions, fetchMyLists, fetchSessionUser } from './leetcode.js';
import { ensureProblems } from './problemLists.js';

const MAX_PREMIUM_LISTS = 60;

// Popular companies offered in the picker. Any LeetCode company slug works too.
export const COMPANIES = [
  ['google', 'Google'],
  ['amazon', 'Amazon'],
  ['facebook', 'Meta'],
  ['microsoft', 'Microsoft'],
  ['apple', 'Apple'],
  ['bloomberg', 'Bloomberg'],
  ['uber', 'Uber'],
  ['adobe', 'Adobe'],
  ['oracle', 'Oracle'],
  ['linkedin', 'LinkedIn'],
  ['goldman-sachs', 'Goldman Sachs'],
  ['salesforce', 'Salesforce'],
  ['tiktok', 'TikTok'],
  ['nvidia', 'NVIDIA'],
  ['atlassian', 'Atlassian'],
  ['flipkart', 'Flipkart'],
  ['walmart-labs', 'Walmart'],
  ['de-shaw', 'DE Shaw'],
].map(([slug, name]) => ({ slug, name }));

export const PERIOD_LABELS = {
  'thirty-days': 'Last 30 days',
  'three-months': 'Last 3 months',
  'six-months': 'Last 6 months',
  'more-than-six-months': 'Older than 6 months',
  all: 'All time',
};

const companyName = (slug) =>
  COMPANIES.find((c) => c.slug === slug)?.name || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const safeId = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60);

export function requirePremium(user) {
  if (!user.premium?.active) throw forbidden('This needs Premium. Redeem a code first.');
}

// Wrong guesses are limited per player so codes cannot be brute-forced.
const attempts = new Map(); // userId -> { count, resetAt }
function throttle(userId) {
  const now = Date.now();
  const a = attempts.get(userId);
  if (!a || a.resetAt < now) return attempts.set(userId, { count: 1, resetAt: now + 15 * 60000 });
  a.count += 1;
  if (a.count > 8) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.');
}

export async function redeem(user, rawCode) {
  if (normalizeCode(rawCode).length < 8) throw badRequest('Enter the full code');
  throttle(String(user._id));
  const code = await PremiumCode.findOne({ codeHash: hashCode(rawCode) });
  if (!code || code.revoked) throw notFound('That code is not valid');
  if (code.boundEmail && code.boundEmail !== user.email) throw forbidden('This code belongs to a different account');
  if (code.redeemedBy && String(code.redeemedBy) !== String(user._id)) throw conflict('This code has already been used');
  if (!code.redeemedBy) {
    // Claim atomically so two accounts cannot redeem the same open code at once.
    const claimed = await PremiumCode.findOneAndUpdate(
      { _id: code._id, redeemedBy: { $exists: false } },
      { $set: { redeemedBy: user._id, redeemedAt: new Date() } },
      { new: true }
    );
    if (!claimed) throw conflict('This code has already been used');
  }
  user.set('premium.active', true);
  user.set('premium.since', user.premium?.since || new Date());
  user.set('premium.code', code._id);
  await user.save();
  attempts.delete(String(user._id));
}

const sessionOf = (user) => {
  const session = open(user.premium?.session?.sealed);
  if (!session) throw badRequest('Connect your LeetCode account first');
  return { session, csrf: open(user.premium?.session?.csrfSealed) || undefined };
};

// Marks the stored session expired when LeetCode stops accepting it, then rethrows a friendly error.
async function withSession(user, fn) {
  const auth = sessionOf(user);
  try {
    return await fn(auth);
  } catch (err) {
    if (err instanceof SessionError) {
      user.set('premium.session.status', 'expired');
      user.set('premium.session.checkedAt', new Date());
      await user.save();
      throw new HttpError(401, 'Your LeetCode session has expired. Paste a fresh LEETCODE_SESSION cookie.');
    }
    throw new HttpError(502, `Couldn't read from LeetCode: ${err.message}`);
  }
}

export async function connectSession(user, rawSession, rawCsrf) {
  requirePremium(user);
  const session = String(rawSession || '').trim().replace(/^LEETCODE_SESSION=/, '').replace(/;$/, '');
  const csrf = String(rawCsrf || '').trim().replace(/^csrftoken=/, '').replace(/;$/, '') || undefined;
  if (session.length < 40 || /\s/.test(session)) throw badRequest('That does not look like a LEETCODE_SESSION cookie');
  let who;
  try {
    who = await fetchSessionUser({ session, csrf });
  } catch (err) {
    if (err instanceof SessionError) throw badRequest(err.message);
    throw new HttpError(502, `Couldn't reach LeetCode: ${err.message}`);
  }
  user.set('premium.session', {
    sealed: seal(session),
    csrfSealed: csrf ? seal(csrf) : undefined,
    username: who.username,
    status: 'ok',
    checkedAt: new Date(),
    syncedAt: user.premium?.session?.syncedAt,
  });
  await user.save();
  return { username: who.username, isPremium: who.isPremium };
}

export async function disconnectSession(user) {
  user.set('premium.session', undefined);
  await user.save();
}

async function upsertPremiumList(user, { key, name, description, kind, company, period, questions }) {
  await ensureProblems(questions);
  const slugs = [...new Set(questions.map((q) => q.slug).filter(Boolean))];
  const exists = await ProblemList.exists({ key });
  if (!exists && (await ProblemList.countDocuments({ owner: user._id, source: 'premium' })) >= MAX_PREMIUM_LISTS) {
    throw badRequest(`You can keep up to ${MAX_PREMIUM_LISTS} premium lists. Remove one first.`);
  }
  await ProblemList.updateOne(
    { key },
    { $set: { name: name.slice(0, 60), description, source: 'premium', kind, company, period, owner: user._id, slugs, groups: [], syncedAt: new Date() } },
    { upsert: true }
  );
  return { key, count: slugs.length };
}

/** Imports (or refreshes) every list the player created on LeetCode. */
export async function syncMyLists(user) {
  requirePremium(user);
  const lists = await withSession(user, (auth) => fetchMyLists(auth));
  const saved = [];
  for (const l of lists) {
    saved.push(
      await upsertPremiumList(user, {
        key: `p-${user._id}-f-${safeId(l.id)}`,
        name: l.name || 'LeetCode list',
        description: 'Imported from your LeetCode lists.',
        kind: 'favorite',
        questions: l.questions,
      })
    );
  }
  user.set('premium.session.syncedAt', new Date());
  user.set('premium.session.status', 'ok');
  await user.save();
  // Lists deleted on LeetCode go away here too, and refreshed company lists stay.
  const keep = saved.map((s) => s.key);
  await ProblemList.deleteMany({ owner: user._id, source: 'premium', kind: 'favorite', key: { $nin: keep } });
  return saved;
}

/** Adds (or refreshes) a company list, e.g. Google · last 6 months. */
export async function addCompanyList(user, rawCompany, rawPeriod) {
  requirePremium(user);
  const company = safeId(rawCompany);
  const period = COMPANY_PERIODS.includes(rawPeriod) ? rawPeriod : 'six-months';
  if (!company) throw badRequest('Pick a company');
  const questions = await withSession(user, (auth) => fetchCompanyQuestions(auth, company, period));
  if (!questions.length) throw notFound(`No questions found for ${companyName(company)}. Check the company name or your LeetCode Premium.`);
  return upsertPremiumList(user, {
    key: `p-${user._id}-c-${company}-${period}`,
    name: `${companyName(company)} · ${PERIOD_LABELS[period]}`,
    description: `Questions ${companyName(company)} asked (${PERIOD_LABELS[period].toLowerCase()}), from your LeetCode Premium.`,
    kind: 'company',
    company,
    period,
    questions,
  });
}
