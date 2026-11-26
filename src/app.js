import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { HttpError } from './utils/http.js';
import { leetcodeStats } from './services/leetcode.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import problemRoutes from './routes/problems.js';
import matchRoutes from './routes/matches.js';
import postRoutes from './routes/posts.js';
import friendRoutes from './routes/friends.js';
import challengeRoutes from './routes/challenges.js';
import eventRoutes from './routes/events.js';
import shareRoutes from './routes/share.js';
import listRoutes from './routes/lists.js';
import activityRoutes from './routes/activity.js';
import premiumRoutes from './routes/premium.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => res.json({ name: 'League of Coders API', status: 'ok' }));
  app.get('/health', (_req, res) => res.json({ ok: true, leetcode: leetcodeStats }));

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/problems', problemRoutes);
  app.use('/api/matches', matchRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/friends', friendRoutes);
  app.use('/api/challenges', challengeRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/lists', listRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/premium', premiumRoutes);
  // Link previews, preview images and the sitemap (proxied from the frontend domain).
  app.use(shareRoutes);

  app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const expected = err instanceof HttpError || err.name === 'ValidationError';
    const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
    if (!expected) console.error(err);
    res.status(status).json({ message: expected ? err.message : 'Something went wrong on our side' });
  });

  return app;
}
