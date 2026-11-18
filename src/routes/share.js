import { Router } from 'express';
import mongoose from 'mongoose';
import Match from '../models/Match.js';
import User from '../models/User.js';
import Challenge from '../models/Challenge.js';
import { config } from '../config.js';
import { asyncHandler } from '../utils/http.js';
import { findByHandle } from '../services/identity.js';
import { cachedPng, tierFor } from '../services/ogImage.js';
import { battleCard, challengeCard, defaultCard, mixLabel, profileCard, resultCard } from '../services/shareCards.js';
import { readUnsubscribeToken } from '../services/email.js';

// Link previews. The frontend proxies /s/*, /og/* and /sitemap.xml here (see _redirects / vercel.json),
// so shared links stay on the app's own domain. Crawlers read the meta tags; people are redirected at once.
const router = Router();

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Origin of the frontend this request came through, so links keep the host they were shared on. */
export function appOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  return config.appHosts.includes(forwarded) ? `https://${forwarded}` : config.appUrl;
}

const REF_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/i;
const withRef = (path, req) => {
  const ref = String(req.query.ref || '');
  return REF_RE.test(ref) ? `${path}${path.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref.toLowerCase())}` : path;
};

function previewPage(req, { title, description, image, path, version }) {
  const origin = appOrigin(req);
  const target = `${origin}${withRef(path, req)}`;
  const shareUrl = `${origin}${req.originalUrl.replace(/^\/share/, '/s')}`;
  const img = `${origin}${image}${version ? `?v=${version}` : ''}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="League of Coders">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta property="og:image" content="${escapeHtml(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(img)}">
<link rel="canonical" href="${escapeHtml(target)}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>
</head><body style="background:#06070b;color:#c9cbd6;font-family:sans-serif">
<p><a href="${escapeHtml(target)}" style="color:#a18bff">Continue to League of Coders</a></p>
</body></html>`;
}

const sendPage = (res, html) => {
  res.set('Cache-Control', 'public, max-age=120');
  res.type('html').send(html);
};

const fallback = (req, res, path = '/') =>
  sendPage(
    res,
    previewPage(req, {
      title: 'League of Coders',
      description: 'Battle your friends on LeetCode problems. Live scoreboards, Elo ratings and a daily battle hour.',
      image: '/og/default.png',
      path,
    })
  );

const stamp = (doc) => new Date(doc.updatedAt || Date.now()).getTime().toString(36);
const codeParam = (req) => String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

// ----------------------------------------------------------------- pages
router.get(
  '/share/m/:code',
  asyncHandler(async (req, res) => {
    const code = codeParam(req);
    const match = await Match.findOne({ code });
    if (!match) return fallback(req, res, `/m/${code}`);
    const host = match.participants.find((p) => String(p.user) === String(match.host));
    const players = match.participants.filter((p) => !p.left).length;
    const finished = match.status === 'finished';
    const title = finished
      ? `${match.name}: results`
      : match.event?.key
        ? `${match.name} on League of Coders`
        : `${host?.name || 'A player'} invited you to a coding battle`;
    const description = finished
      ? `${players} players · ${mixLabel(match.settings)}. See who won and start your own battle.`
      : `${players}/${match.settings.maxPlayers} players · ${match.settings.durationMin} min · ${mixLabel(match.settings)}. Join with one click.`;
    sendPage(res, previewPage(req, { title, description, image: `/og/m/${code}.png`, path: `/m/${code}`, version: stamp(match) }));
  })
);

router.get(
  '/share/u/:handle',
  asyncHandler(async (req, res) => {
    const user = await findByHandle(req.params.handle);
    if (!user) return fallback(req, res, '/tournaments');
    const handle = user.username || String(user._id);
    const s = user.stats;
    const title = `${user.name} on League of Coders`;
    const description = `${tierFor(s.rating).name} · rating ${s.rating} · ${s.wins} win${s.wins === 1 ? '' : 's'} in ${s.matches} battle${s.matches === 1 ? '' : 's'}${user.college ? ` · ${user.college}` : ''}. Challenge them to a battle.`;
    sendPage(res, previewPage(req, { title, description, image: `/og/u/${handle}.png`, path: `/u/${handle}`, version: stamp(user) }));
  })
);

router.get(
  '/share/r/:code/:userId',
  asyncHandler(async (req, res) => {
    const code = codeParam(req);
    const match = await Match.findOne({ code, status: 'finished' });
    const p = match?.participants.find((x) => String(x.user) === String(req.params.userId));
    if (!p) return fallback(req, res, `/m/${code}`);
    const rated = match.participants.length >= 2;
    const title = rated
      ? p.rank === 1
        ? `${p.name} won ${match.name}`
        : `${p.name} placed ${p.rank} of ${match.participants.length} in ${match.name}`
      : `${p.name} scored ${p.score} in a solo test`;
    const description = `${p.score} points · solved ${p.solves.length}/${match.problems.length} · ${mixLabel(match.settings)}. Think you can beat it?`;
    sendPage(
      res,
      previewPage(req, { title, description, image: `/og/r/${code}/${req.params.userId}.png`, path: `/m/${code}`, version: stamp(match) })
    );
  })
);

router.get(
  '/share/c/:code',
  asyncHandler(async (req, res) => {
    const code = codeParam(req);
    const challenge = await Challenge.findOne({ code });
    if (!challenge) return fallback(req, res, `/c/${code}`);
    const creator = challenge.attempts.find((a) => String(a.user) === String(challenge.creator));
    const title = `${creator?.name || 'A player'} scored ${creator?.score ?? 0}. Can you beat it?`;
    const description = `Same ${challenge.problems.length} LeetCode problems, same ${challenge.durationMin}-minute clock. Play any time on League of Coders.`;
    sendPage(res, previewPage(req, { title, description, image: `/og/c/${code}.png`, path: `/c/${code}`, version: stamp(challenge) }));
  })
);

router.get(
  '/share/unsubscribe',
  asyncHandler(async (req, res) => {
    const token = readUnsubscribeToken(String(req.query.t || ''));
    const KINDS = { streak: 'streak reminders', weekly: 'weekly recaps', challenges: 'challenge emails' };
    let message = 'This link has expired. You can turn emails off from your profile instead.';
    if (token && KINDS[token.kind] && mongoose.isValidObjectId(token.userId)) {
      await User.updateOne({ _id: token.userId }, { $set: { [`emailPrefs.${token.kind}`]: false } });
      message = `Done. You will not get ${KINDS[token.kind]} any more. You can turn them back on from your profile.`;
    }
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title><meta name="robots" content="noindex"></head>
<body style="margin:0;background:#06070b;color:#c9cbd6;font-family:-apple-system,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">
<div style="max-width:420px"><p style="color:#a18bff;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px">League of Coders</p><p style="font-size:17px;line-height:1.5">${escapeHtml(message)}</p><a href="${appOrigin(req)}/u/me" style="color:#a18bff">Open your profile</a></div></body></html>`);
  })
);

// ----------------------------------------------------------------- images
const sendPng = (res, png) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.type('png').send(png);
};

router.get(
  '/og/default.png',
  asyncHandler(async (_req, res) => sendPng(res, await cachedPng('default', defaultCard)))
);

router.get(
  '/og/m/:code.png',
  asyncHandler(async (req, res) => {
    const match = await Match.findOne({ code: codeParam(req) });
    if (!match) return sendPng(res, await cachedPng('default', defaultCard));
    sendPng(res, await cachedPng(`m:${match.code}:${stamp(match)}`, () => battleCard(match)));
  })
);

router.get(
  '/og/u/:handle.png',
  asyncHandler(async (req, res) => {
    const user = await findByHandle(req.params.handle);
    if (!user) return sendPng(res, await cachedPng('default', defaultCard));
    sendPng(res, await cachedPng(`u:${user._id}:${stamp(user)}`, () => profileCard(user)));
  })
);

router.get(
  '/og/r/:code/:userId.png',
  asyncHandler(async (req, res) => {
    const match = await Match.findOne({ code: codeParam(req), status: 'finished' });
    const p = match?.participants.find((x) => String(x.user) === String(req.params.userId));
    if (!p) return sendPng(res, await cachedPng('default', defaultCard));
    sendPng(res, await cachedPng(`r:${match.code}:${req.params.userId}:${stamp(match)}`, () => resultCard(match, p)));
  })
);

router.get(
  '/og/c/:code.png',
  asyncHandler(async (req, res) => {
    const challenge = await Challenge.findOne({ code: codeParam(req) });
    if (!challenge) return sendPng(res, await cachedPng('default', defaultCard));
    sendPng(res, await cachedPng(`c:${challenge.code}:${stamp(challenge)}`, () => challengeCard(challenge)));
  })
);

// ----------------------------------------------------------------- sitemap
export const SEO_PAGES = [
  '/leetcode-with-friends/',
  '/leetcode-alternative/',
  '/competitive-programming-battles/',
  '/gamified-coding-practice/',
];

router.get(
  '/sitemap.xml',
  asyncHandler(async (req, res) => {
    const origin = appOrigin(req);
    const players = await User.find({ username: { $type: 'string' }, 'stats.matches': { $gt: 0 }, bot: { $ne: true } })
      .sort({ 'stats.rating': -1 })
      .limit(1000)
      .select('username updatedAt')
      .lean();
    const urls = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/tournaments', priority: '0.8', changefreq: 'daily' },
      { loc: '/practice', priority: '0.6', changefreq: 'weekly' },
      ...SEO_PAGES.map((loc) => ({ loc, priority: '0.8', changefreq: 'monthly' })),
      ...players.map((p) => ({ loc: `/u/${p.username}`, lastmod: p.updatedAt, priority: '0.5', changefreq: 'weekly' })),
    ];
    const body = urls
      .map(
        (u) =>
          `<url><loc>${escapeHtml(origin + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
      )
      .join('');
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
  })
);

export default router;
