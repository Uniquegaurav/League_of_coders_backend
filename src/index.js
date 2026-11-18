import http from 'node:http';
import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';
import { createSocketServer } from './socket.js';
import { recoverMatches, startBackgroundJobs } from './services/matchEngine.js';
import { seedCurated, syncLeetCodeCatalog } from './services/questionBank.js';
import { backfillUsernames } from './services/identity.js';
import { startEventScheduler } from './services/events.js';
import { startEmailJobs } from './services/email.js';
import { startListSync } from './services/problemLists.js';

async function main() {
  if (!config.mongoUrl) throw new Error('CONNECTION_URL is not set');
  await mongoose.connect(config.mongoUrl);
  console.log('[db] connected');

  await seedCurated();
  await recoverMatches();
  startBackgroundJobs();
  backfillUsernames().catch((err) => console.warn('[identity] backfill', err.message));
  startEventScheduler();
  startEmailJobs();
  startListSync();
  syncLeetCodeCatalog();
  setInterval(() => syncLeetCodeCatalog(), 6 * 60 * 60 * 1000);

  const server = http.createServer(createApp());
  createSocketServer(server);
  server.listen(config.port, () => console.log(`[http] listening on :${config.port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
