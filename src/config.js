import dotenv from 'dotenv';

dotenv.config();

// Public OAuth client id (it ships in the frontend). Override with GOOGLE_CLIENT_ID if you rotate it.
const DEFAULT_GOOGLE_CLIENT_ID = '146423725963-28dc9pj5sbjj12d44lbtlnimqltcmkrb.apps.googleusercontent.com';

// Always allow the live site and local dev, even if CLIENT_ORIGIN was set to something else.
const ALWAYS_ALLOWED = [
  'https://codersleague.netlify.app',
  'https://codersleague.mysummit.space',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function corsOrigin() {
  const fromEnv = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (fromEnv.includes('*') || fromEnv.length === 0) return true;
  return [...new Set([...ALWAYS_ALLOWED, ...fromEnv])];
}

if (!process.env.JWT_SECRET) {
  console.warn('[config] JWT_SECRET is not set; using an insecure development secret.');
}

export const config = {
  port: Number(process.env.PORT) || 5000,
  mongoUrl: process.env.CONNECTION_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: '14d',
  corsOrigin: corsOrigin(),
  googleClientId: process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID,
  pollIntervalMs: (Number(process.env.POLL_INTERVAL_SEC) || 20) * 1000,
  // Public address of the frontend. Share links, link previews, emails and the sitemap point here.
  appUrl: (process.env.APP_URL || 'https://codersleague.mysummit.space').replace(/\/$/, ''),
  // Hosts the frontend may proxy share/preview requests from; links then keep the host they were opened on.
  appHosts: ALWAYS_ALLOWED.filter((o) => o.startsWith('https://')).map((o) => new URL(o).host),
  email: {
    // Resend (resend.com) has a free tier. Without a key, emails are skipped and logged.
    resendKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'League of Coders <noreply@codersleague.mysummit.space>',
    // Hard daily cap so a free-tier quota is never exceeded.
    dailyCap: Number(process.env.EMAIL_DAILY_CAP) || 90,
    // UTC hour after which "your streak is about to break" goes out (14 UTC = 7:30 PM IST).
    streakHourUtc: Number(process.env.STREAK_EMAIL_HOUR_UTC ?? 14),
  },
  events: {
    // Daily public battle ("battle hour") and the Sunday Cup start at this UTC time. 15:30 UTC = 9 PM IST.
    startUtc: process.env.BATTLE_HOUR_UTC || '15:30',
    enabled: process.env.BATTLE_HOUR_ENABLED !== 'false',
  },
};

export const SCORING = {
  base: { Easy: 100, Medium: 200, Hard: 300 },
  // Up to this fraction of base points is awarded for speed, decaying linearly to 0 at the buzzer.
  speedBonusMax: 0.5,
  firstSolveBonus: 25,
};

export const MATCH_LIMITS = {
  minDuration: 10,
  maxDuration: 180,
  maxPerDifficulty: 6,
  maxProblems: 10,
  maxPlayers: 20,
  countdownMs: 5000,
  verifyCooldownMs: 8000,
  chatHistory: 150,
};
