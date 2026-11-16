import dotenv from 'dotenv';

dotenv.config();

const origins = (process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (!process.env.JWT_SECRET) {
  console.warn('[config] JWT_SECRET is not set; using an insecure development secret.');
}

export const config = {
  port: Number(process.env.PORT) || 5000,
  mongoUrl: process.env.CONNECTION_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: '14d',
  corsOrigin: origins.includes('*') ? true : origins,
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  pollIntervalMs: (Number(process.env.POLL_INTERVAL_SEC) || 20) * 1000,
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
