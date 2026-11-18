import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Match from '../models/Match.js';
import { config } from '../config.js';
import { todayKey, yesterdayKey } from './progression.js';

// Transactional email through Resend's HTTP API (free tier: 3,000/month, 100/day).
// Without RESEND_API_KEY nothing is sent; the job only logs what it would have done.
const sentToday = { day: null, count: 0 };

const capReached = () => {
  const day = todayKey();
  if (sentToday.day !== day) Object.assign(sentToday, { day, count: 0 });
  return sentToday.count >= config.email.dailyCap;
};

export const emailEnabled = () => !!config.email.resendKey;

export const unsubscribeToken = (userId, kind) => jwt.sign({ u: String(userId), k: kind }, config.jwtSecret, { expiresIn: '180d' });
export const readUnsubscribeToken = (token) => {
  try {
    const { u, k } = jwt.verify(token, config.jwtSecret);
    return { userId: u, kind: k };
  } catch {
    return null;
  }
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout({ heading, lines, cta, unsubscribeUrl }) {
  const body = lines.map((l) => `<p style="margin:0 0 12px;color:#c9cbd6;font-size:15px;line-height:1.55">${escapeHtml(l)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#06070b;font-family:-apple-system,Segoe UI,Inter,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="margin:0 0 24px;color:#a18bff;font-weight:700;font-size:14px;letter-spacing:.08em;text-transform:uppercase">League of Coders</p>
<h1 style="margin:0 0 16px;color:#fff;font-size:22px">${escapeHtml(heading)}</h1>
${body}
<a href="${cta.url}" style="display:inline-block;margin-top:8px;background:#7c5cff;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${escapeHtml(cta.label)}</a>
<p style="margin:32px 0 0;color:#6b6f80;font-size:12px">You get this because you play on League of Coders. <a href="${unsubscribeUrl}" style="color:#8b8fa3">Stop these emails</a></p>
</div></body></html>`;
}

/** Sends one email. Returns true when it was sent (or would have been, in dry-run mode). */
export async function sendEmail(user, kind, { subject, heading, lines, cta }) {
  if (user.emailPrefs?.[kind] === false) return false;
  if (capReached()) {
    console.warn('[email] daily cap reached, skipping', kind);
    return false;
  }
  const unsubscribeUrl = `${config.appUrl}/s/unsubscribe?t=${unsubscribeToken(user._id, kind)}`;
  const html = layout({ heading, lines, cta, unsubscribeUrl });
  const text = `${heading}\n\n${lines.join('\n\n')}\n\n${cta.label}: ${cta.url}\n\nStop these emails: ${unsubscribeUrl}`;
  if (!emailEnabled()) {
    console.log(`[email] (dry run, no RESEND_API_KEY) ${kind} -> user ${user._id}: ${subject}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.email.from,
      to: [user.email],
      subject,
      html,
      text,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.warn('[email] send failed', res.status, (await res.text()).slice(0, 200));
    return false;
  }
  sentToday.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
/** Evening nudge for players whose streak (2+ days) breaks at midnight UTC unless they play today. */
async function streakReminders(now = Date.now()) {
  if (new Date(now).getUTCHours() < config.email.streakHourUtc) return;
  const today = todayKey(now);
  const users = await User.find({
    'practice.lastActiveDay': yesterdayKey(now),
    'practice.streak': { $gte: 2 },
    'emailPrefs.streak': { $ne: false },
    'lastEmails.streakDay': { $ne: today },
  }).limit(50);
  for (const user of users) {
    if (capReached()) return;
    const marked = await User.updateOne({ _id: user._id }, { $set: { 'lastEmails.streakDay': today } }).catch(() => null);
    if (!marked) continue;
    await sendEmail(user, 'streak', {
      subject: `Your ${user.practice.streak}-day streak ends tonight`,
      heading: `Keep your ${user.practice.streak}-day streak alive`,
      lines: ['Solve one problem or finish one battle before midnight UTC and the streak carries on.', 'Today’s problem of the day is a quick way to do it.'],
      cta: { label: 'Open today’s problem', url: `${config.appUrl}/practice` },
    }).catch((err) => console.warn('[email] streak', err.message));
  }
}

export const weekKey = (now = Date.now()) => {
  const monday = weekStart(now);
  return monday.toISOString().slice(0, 10);
};

/** Monday 00:00 UTC of the week containing `now`. */
export function weekStart(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/** Monday recap of last week's XP (and rating, if a tournament moved it) for players who earned any. */
async function weeklyRecaps(now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 4) return;
  const key = weekKey(now);
  const lastWeek = weekKey(now - 7 * 86400000);
  const end = weekStart(now);
  const start = new Date(end.getTime() - 7 * 86400000);
  const users = await User.find({
    $or: [
      { 'practice.weekKey': lastWeek, 'practice.weekXp': { $gt: 0 } },
      { 'practice.prevWeekKey': lastWeek, 'practice.prevWeekXp': { $gt: 0 } },
    ],
    'emailPrefs.weekly': { $ne: false },
    'lastEmails.weeklyKey': { $ne: key },
    bot: { $ne: true },
  }).limit(50);
  if (!users.length) return;
  const rows = await Match.aggregate([
    { $match: { status: 'finished', finishedAt: { $gte: start, $lt: end }, 'participants.user': { $in: users.map((u) => u._id) } } },
    { $unwind: '$participants' },
    {
      $group: {
        _id: '$participants.user',
        battles: { $sum: 1 },
        gain: { $sum: { $subtract: [{ $ifNull: ['$participants.ratingAfter', 0] }, { $ifNull: ['$participants.ratingBefore', 0] }] } },
      },
    },
  ]);
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  for (const user of users) {
    if (capReached()) return;
    const p = user.practice || {};
    const xp = p.weekKey === lastWeek ? p.weekXp : p.prevWeekXp;
    const r = byId.get(String(user._id)) || { battles: 0, gain: 0 };
    const marked = await User.updateOne({ _id: user._id }, { $set: { 'lastEmails.weeklyKey': key } }).catch(() => null);
    if (!marked) continue;
    const lines = [`You earned ${xp} XP${r.battles ? ` across ${r.battles} battle${r.battles === 1 ? '' : 's'}` : ''}.`];
    if (r.gain) lines.push(`Tournament rating: ${r.gain > 0 ? '+' : ''}${r.gain}, now ${user.stats.rating}.`);
    lines.push('The weekly XP board reset this morning, so everyone starts level.');
    await sendEmail(user, 'weekly', {
      subject: `Your week: ${xp} XP`,
      heading: 'Your week on League of Coders',
      lines,
      cta: { label: 'See this week’s board', url: `${config.appUrl}/leaderboard?board=xp&period=week` },
    }).catch((err) => console.warn('[email] weekly', err.message));
  }
}

/** "X challenged you" for a direct challenge from a profile. */
export function sendChallengeEmail(target, from, matchCode) {
  return sendEmail(target, 'challenges', {
    subject: `${from.name} challenged you to a coding battle`,
    heading: `${from.name} wants a 1v1`,
    lines: [`${from.name} opened a battle lobby for the two of you. Join before it starts to accept.`],
    cta: { label: 'Open the battle', url: `${config.appUrl}/m/${matchCode}` },
  });
}

export function startEmailJobs() {
  const run = () =>
    Promise.resolve()
      .then(() => streakReminders())
      .then(() => weeklyRecaps())
      .catch((err) => console.warn('[email] job failed:', err.message));
  if (!emailEnabled()) console.log('[email] RESEND_API_KEY not set: reminder emails run in dry-run mode');
  setTimeout(run, 60 * 1000);
  setInterval(run, 15 * 60 * 1000);
}
