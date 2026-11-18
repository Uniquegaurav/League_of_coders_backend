// Demo community content so a new install does not look empty:
//   * 16 demo players (flagged `bot: true`, cannot sign in, never emailed)
//   * community posts with comments and likes
//   * a few finished public battles and past tournaments (flagged `seeded: true`)
//   * upcoming planned tournaments, which really open and run on schedule
//
//   npm run seed:community              add (safe to run again: it replaces earlier demo data)
//   npm run seed:community -- --remove  delete every demo player, post, battle and planned tournament
import mongoose from 'mongoose';
import { config } from '../config.js';
import User from '../models/User.js';
import Post from '../models/Post.js';
import Match from '../models/Match.js';
import Problem from '../models/Problem.js';
import ScheduledEvent from '../models/ScheduledEvent.js';
import { grantBadges } from '../services/badges.js';
import { assignRanks, recomputeScores } from '../services/scoring.js';
import { SCORING } from '../config.js';
import { roomCode } from '../utils/random.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const sample = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

const PLAYERS = [
  ['Aarav Mehta', 'aarav', 'IIT Bombay', 1612],
  ['Priya Nair', 'priya-codes', 'NIT Trichy', 1548],
  ['Rohan Gupta', 'rohan_g', 'BITS Pilani', 1493],
  ['Sneha Iyer', 'sneha-iyer', 'IIT Madras', 1466],
  ['Kabir Singh', 'kabir-dp', 'DTU', 1421],
  ['Ananya Rao', 'ananya', 'IIIT Hyderabad', 1398],
  ['Vikram Joshi', 'vikram-j', 'IIT Delhi', 1362],
  ['Meera Pillai', 'meera_p', 'VIT Vellore', 1334],
  ['Arjun Reddy', 'arjun-bfs', 'IIIT Hyderabad', 1301],
  ['Ishita Sharma', 'ishita', 'NSUT', 1276],
  ['Dev Patel', 'devpatel', 'NIT Surathkal', 1248],
  ['Zoya Khan', 'zoya-k', 'Jamia Millia Islamia', 1219],
  ['Nikhil Verma', 'nikhil-v', 'IIT Bombay', 1187],
  ['Tanvi Kulkarni', 'tanvi', 'COEP Pune', 1152],
  ['Sam Wilson', 'samw', null, 1124],
  ['Lucas Ferreira', 'lucas-f', null, 1096],
];

const POSTS = [
  {
    by: 'aarav',
    replies: [['meera_p', "The \"while, never if\" part is the bug I make every time. Saving this."], ['ishita', "Same shape works for Minimum Window Substring, just with a counter map."]],
    title: 'Sliding window template I use in every battle',
    tags: ['tips', 'sliding-window'],
    body: `Most "longest/shortest subarray with X" problems fit this:

left = 0
for right in range(len(a)):
    add a[right] to the window
    while the window is invalid:
        remove a[left]; left += 1
    update the answer with right - left + 1

Shrink with a while loop, never an if. Saved me ~5 minutes on Longest Substring Without Repeating Characters last night.`,
  },
  {
    by: 'priya-codes',
    replies: [['nikhil-v', "Or a single element. Or INT_MAX. Always one of the three."], ['arjun-bfs', "I now write the empty case first out of spite."]],
    title: 'My code passed 57/58 test cases',
    tags: ['fun'],
    body: 'The 58th one was the empty array. It is always the empty array. Every single time.',
  },
  {
    by: 'rohan_g',
    replies: [['tanvi', "\"Same problem in a trench coat\" is going in my notes."], ['kabir-dp', "Magnetic Force Between Two Balls is another good one for this."]],
    title: 'Binary search on the answer: a checklist',
    tags: ['tips', 'binary-search'],
    body: `If a problem asks for the minimum X such that something is possible, try this:
1. Write can(x): is it possible with x?
2. Check can() is monotonic (false false false true true).
3. Binary search the smallest x where can(x) is true.

Koko Eating Bananas, Capacity to Ship Packages and Split Array Largest Sum are all the same problem in a trench coat.`,
  },
  {
    by: 'sneha-iyer',
    replies: [['devpatel', "Re-solving the one I missed is underrated. Doing this from today."], ['zoya-k', "Agree on speed. Two fast Mediums beat one slow Hard almost every time."]],
    title: 'How I went from Gold to Platinum in two weeks',
    tags: ['progress'],
    body: `Not a secret, just consistency:
- Problem of the day every morning (15 min)
- Battle hour 3-4 times a week
- After every battle, re-solve the one I missed without looking

The speed bonus matters more than I thought. Solving Mediums fast beats solving one extra Hard slowly.`,
  },
  {
    by: 'kabir-dp',
    replies: [['priya-codes', "Accurate."], ['samw', "And then you realise it only needed one row of the table."]],
    title: 'Dynamic programming in one sentence',
    tags: ['dp', 'fun'],
    body: 'Recursion that remembers its mistakes so it can make new ones faster.',
  },
  {
    by: 'ananya',
    replies: [['vikram-j', "Adding: if the graph is a tree, DFS with a return value usually beats BFS."]],
    title: 'Graph problems: BFS or DFS?',
    tags: ['graphs', 'tips'],
    body: `Rough rule that has not failed me yet:
- Shortest path in an unweighted grid or graph: BFS
- "Count the islands / connected parts": either, DFS is shorter to write
- Need to explore every path (backtracking): DFS
- Weighted shortest path: Dijkstra, which is BFS with a heap

Topological sort is just BFS on in-degrees (Kahn's algorithm).`,
  },
  {
    by: 'vikram-j',
    replies: [['rohan_g', "In. Sending you a challenge at 9."], ['ananya', "Good luck on Friday!"]],
    title: 'Anyone up for a 1v1 on trees tonight?',
    tags: ['looking-for-battle'],
    body: 'Want to practise tree problems before an interview on Friday. Challenge me from my profile, I am around after 9 PM IST.',
  },
  {
    by: 'meera_p',
    replies: [['sneha-iyer', "Also: Two Sum II (sorted input) is basically asking for two pointers."]],
    title: 'Two pointers vs hash map for Two Sum style problems',
    tags: ['tips'],
    body: 'If the array is sorted, two pointers gives O(1) extra space. If it is not, sorting costs O(n log n) and loses the original indices, so a hash map is usually the better call.',
  },
  {
    by: 'arjun-bfs',
    replies: [['lucas-f', "The memo of the memo is where it gets interesting."], ['tanvi', "Too real."]],
    title: 'Me: I will just do one quick problem before bed',
    tags: ['fun'],
    body: 'Also me at 2:47 AM: "what if I memoise the memo"',
  },
  {
    by: 'ishita',
    replies: [['aarav', "Storing indices is the key tip. Took me way too long to learn that."]],
    title: 'Monotonic stack cheat sheet',
    tags: ['tips', 'stack'],
    body: `"Next greater element" family:
- Next greater: decreasing stack, pop while a[i] > top
- Next smaller: increasing stack, pop while a[i] < top
- Store indices, not values, so you can compute distances

Daily Temperatures, Largest Rectangle in Histogram and Trapping Rain Water all use it.`,
  },
  {
    by: 'devpatel',
    replies: [['sneha-iyer', "6th in your first Cup is solid. See you next Sunday."], ['rohan_g', "The Hard was rough for everyone, do not worry."]],
    title: 'First Sunday Cup done, finished 6th',
    tags: ['sunday-cup'],
    body: 'Hard problem was brutal but the Easy and the two Mediums were very doable. If you have not tried the Cup yet, just join. Nobody cares about your rank in your first one.',
  },
  {
    by: 'zoya-k',
    replies: [['meera_p', "This helped me a lot in my last round. Silence is the worst."]],
    title: 'Interview tip: say your brute force out loud first',
    tags: ['interviews'],
    body: 'Interviewers want to see that you can get to a working answer. State the brute force and its complexity in 30 seconds, then optimise. It also buys you thinking time.',
  },
  {
    by: 'nikhil-v',
    replies: [['priya-codes', "Took me a second. Well played."]],
    title: 'Off-by-one errors',
    tags: ['fun'],
    body: 'There are two hard things in computer science: cache invalidation, naming things, and off-by-one errors.',
  },
  {
    by: 'tanvi',
    replies: [['aarav', "Blind 75 first. If you finish with time left, do the NeetCode 150 extras."], ['ananya', "With 6 weeks, Blind 75 plus the battle hour a few times a week is plenty."]],
    title: 'Which list should I start with: Blind 75 or NeetCode 150?',
    tags: ['question'],
    body: 'I have about 6 weeks before placements. Is Blind 75 enough or should I go for NeetCode 150? Both are on the Practice page now.',
  },
  {
    by: 'samw',
    replies: [['kabir-dp', "Quickselect is O(n) on average too, if you want to show off."]],
    title: 'Heap tricks for "top K" problems',
    tags: ['tips', 'heap'],
    body: 'For the K largest, keep a min-heap of size K and push/pop as you go. That is O(n log k) instead of sorting everything. For K closest points, same idea with a max-heap on distance.',
  },
  {
    by: 'lucas-f',
    replies: [['zoya-k', "Welcome! Plenty of people here play from other time zones."], ['devpatel', "Lunch-break battles sound great."]],
    title: 'Greetings from Brazil',
    tags: ['hello'],
    body: 'The battle hour lands at 12:30 PM for me, so it doubles as lunch-break practice. Anyone else playing from outside India?',
  },
];


const EVENTS = [
  { key: 'weekend-blitz', name: 'Weekend Blitz', description: '30 minutes, three quick problems. Speed wins.', inDays: 2, durationMin: 30, easy: 2, medium: 1, hard: 0, topics: [] },
  { key: 'graph-night', name: 'Graph Night', description: 'BFS, DFS and friends. Grids, islands and shortest paths.', inDays: 5, durationMin: 60, easy: 0, medium: 2, hard: 1, topics: ['Graph', 'BFS', 'DFS'] },
  { key: 'beginner-cup', name: 'Beginner Cup', description: 'For your first tournament: Easy-heavy and friendly.', inDays: 9, durationMin: 40, easy: 2, medium: 1, hard: 0, topics: [] },
  { key: 'dp-marathon', name: 'DP Marathon', description: '90 minutes of dynamic programming.', inDays: 13, durationMin: 90, easy: 0, medium: 2, hard: 1, topics: ['Dynamic Programming'] },
];

async function remove() {
  const bots = await User.find({ bot: true }).select('_id').lean();
  const ids = bots.map((b) => b._id);
  const [posts, matches, events] = await Promise.all([
    Post.deleteMany({ author: { $in: ids } }),
    Match.deleteMany({ seeded: true }),
    ScheduledEvent.deleteMany({ seeded: true }),
  ]);
  await Post.updateMany({}, { $pull: { comments: { author: { $in: ids } }, likes: { $in: ids } } });
  await User.updateMany({}, { $pull: { friends: { $in: ids } } });
  const users = await User.deleteMany({ bot: true });
  console.log(`Removed ${users.deletedCount} demo players, ${posts.deletedCount} posts, ${matches.deletedCount} battles, ${events.deletedCount} planned tournaments.`);
}

function participantsFor(bots, problems, startedAt, durationMin) {
  const end = startedAt.getTime() + durationMin * 60000;
  return bots.map((b) => {
    // Stronger players solve more, sooner.
    const skill = (b.stats.rating - 1000) / 700;
    const solves = [];
    problems.forEach((p) => {
      const chance = { Easy: 0.95, Medium: 0.55 + skill * 0.4, Hard: 0.15 + skill * 0.5 }[p.difficulty];
      if (Math.random() < chance) {
        const t = startedAt.getTime() + Math.min(durationMin - 1, rand(3, durationMin * (1.1 - skill * 0.5))) * 60000;
        solves.push({ slug: p.slug, solvedAt: new Date(Math.min(t, end - 30000)) });
      }
    });
    return {
      user: b._id,
      name: b.name,
      leetcodeUsername: b.username,
      leetcodeVerified: true,
      excludeSolved: false,
      solves,
      ratingBefore: b.stats.rating,
    };
  });
}

async function finishedMatch({ name, bots, mix, durationMin, finishedAt, event }) {
  const problems = [];
  for (const [difficulty, n] of Object.entries(mix)) {
    if (!n) continue;
    const pool = await Problem.find({ curated: true, paidOnly: false, difficulty }).select('slug frontendId title difficulty tags patterns').lean();
    sample(pool, n).forEach((p) =>
      problems.push({ slug: p.slug, frontendId: p.frontendId, title: p.title, difficulty, tags: p.tags?.length ? p.tags : p.patterns, basePoints: SCORING.base[difficulty] })
    );
  }
  const startedAt = new Date(finishedAt.getTime() - durationMin * 60000);
  const match = new Match({
    code: roomCode(),
    name,
    host: event ? undefined : bots[0]._id,
    visibility: 'public',
    status: 'finished',
    settings: { durationMin, easy: mix.Easy || 0, medium: mix.Medium || 0, hard: mix.Hard || 0, pool: 'curated', topics: [], maxPlayers: event ? 20 : 8 },
    participants: participantsFor(bots, problems, startedAt, durationMin),
    problems,
    startedAt,
    endsAt: finishedAt,
    finishedAt,
    event,
    seeded: true,
    messages: [{ kind: 'system', text: `${name} finished` }],
  });
  recomputeScores(match);
  assignRanks(match.participants);
  const n = match.participants.length;
  match.participants.forEach((p) => {
    p.ratingAfter = p.ratingBefore + Math.round(((n + 1) / 2 - p.rank) * 6);
  });
  match.createdAt = startedAt;
  await match.save({ timestamps: false });
  return match;
}

async function add() {
  await remove();
  const curated = (await Problem.find({ curated: true, paidOnly: false }).select('slug').lean()).map((p) => p.slug);
  if (!curated.length) throw new Error('No problems in the database yet. Start the server once so it seeds the problem bank, then run this again.');

  const now = Date.now();
  const bots = [];
  for (const [name, wanted, college, rating] of PLAYERS) {
    // Never take a real player's username.
    let username = wanted;
    for (let n = 2; await User.exists({ username }); n += 1) username = `${wanted}-${n}`;
    const matches = rand(6, 48);
    const wins = Math.max(0, Math.round(matches * (0.12 + (rating - 1100) / 1500)));
    const streak = rand(0, 12);
    const user = new User({
      name,
      username,
      college: college || undefined,
      email: `${username}@demo.invalid`,
      bot: true,
      emailPrefs: { streak: false, challenges: false, weekly: false },
      stats: { rating, matches, wins, points: matches * rand(250, 520), solved: rand(matches, matches * 2) },
      solvedSlugs: sample(curated, Math.min(curated.length, rand(15, 110))),
      practice: {
        xp: rand(200, 4200),
        streak,
        bestStreak: streak + rand(0, 15),
        lastActiveDay: new Date(now - (streak ? 0 : 3) * DAY).toISOString().slice(0, 10),
      },
    });
    grantBadges(user);
    user.createdAt = new Date(now - rand(5, 70) * DAY);
    await user.save({ timestamps: false });
    bots.push(user);
  }
  const byHandle = new Map(bots.map((b, i) => [PLAYERS[i][1], b]));

  for (const [i, def] of POSTS.entries()) {
    const author = byHandle.get(def.by);
    const createdAt = new Date(now - (POSTS.length - i) * rand(5, 14) * HOUR);
    const replies = (def.replies || []).map(([handle, body]) => [byHandle.get(handle), body]).filter(([b]) => b);
    await Post.collection.insertOne({
      author: author._id,
      authorName: author.name,
      authorAvatar: null,
      kind: 'discussion',
      title: def.title,
      body: def.body,
      tags: def.tags,
      likes: sample(bots, rand(2, 11)).map((b) => b._id),
      comments: replies.map(([c, body], j) => ({
        _id: new mongoose.Types.ObjectId(),
        author: c._id,
        authorName: c.name,
        authorAvatar: null,
        body,
        createdAt: new Date(createdAt.getTime() + (j + 1) * rand(20, 120) * 60000),
        updatedAt: new Date(createdAt.getTime() + (j + 1) * rand(20, 120) * 60000),
      })),
      createdAt,
      updatedAt: createdAt,
    });
  }

  // Recent public battles for the home page.
  for (let i = 0; i < 4; i += 1) {
    const players = sample(bots, rand(3, 6));
    await finishedMatch({ name: `${players[0].name.split(' ')[0]}'s battle`, bots: players, mix: { Easy: 1, Medium: 2 }, durationMin: 45, finishedAt: new Date(now - rand(2, 40) * HOUR) });
  }

  // Past Sunday Cups (previous three Sundays) and one past special tournament.
  const lastSunday = new Date(now);
  lastSunday.setUTCDate(lastSunday.getUTCDate() - ((lastSunday.getUTCDay() + 7) % 7 || 7));
  lastSunday.setUTCHours(16, 30, 0, 0);
  for (let w = 0; w < 3; w += 1) {
    const day = new Date(lastSunday.getTime() - w * 7 * DAY);
    const label = day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const key = `cup-${day.toISOString().slice(0, 10)}`;
    if (await Match.exists({ 'event.key': key })) continue;
    await finishedMatch({
      name: `Sunday Cup · ${label}`,
      bots: sample(bots, rand(9, 14)),
      mix: { Easy: 1, Medium: 2, Hard: 1 },
      durationMin: 60,
      finishedAt: day,
      event: { key, kind: 'cup', startsAt: new Date(day.getTime() - HOUR) },
    });
  }
  await finishedMatch({
    name: 'Arrays Sprint',
    bots: sample(bots, 10),
    mix: { Easy: 2, Medium: 1 },
    durationMin: 30,
    finishedAt: new Date(now - 4 * DAY),
    event: { key: `seed-arrays-sprint-${now}`, kind: 'special', startsAt: new Date(now - 4 * DAY - 30 * 60000), description: 'Arrays and hashing, 30 minutes.' },
  });

  // Upcoming planned tournaments. These are real: their lobbies open 30 minutes before and run on schedule.
  const [h, m] = config.events.startUtc.split(':').map(Number);
  for (const e of EVENTS) {
    const at = new Date(now + e.inDays * DAY);
    at.setUTCHours(h, m, 0, 0);
    // Keep clear of the daily battle hour slot by starting 90 minutes later.
    at.setTime(at.getTime() + 90 * 60000);
    await ScheduledEvent.create({
      key: `${e.key}-${at.toISOString().slice(0, 10)}`,
      name: e.name,
      description: e.description,
      startsAt: at,
      settings: { durationMin: e.durationMin, easy: e.easy, medium: e.medium, hard: e.hard, pool: 'curated', topics: e.topics, maxPlayers: 20 },
      seeded: true,
    });
  }

  console.log(`Added ${bots.length} demo players, ${POSTS.length} posts, 4 battles, 4 past tournaments and ${EVENTS.length} planned tournaments.`);
  console.log('Remove them any time with: npm run seed:community -- --remove');
}

async function main() {
  if (!config.mongoUrl) throw new Error('CONNECTION_URL is not set');
  await mongoose.connect(config.mongoUrl);
  if (process.argv.includes('--remove')) await remove();
  else await add();
  await mongoose.disconnect();
}

if (process.argv[1]?.endsWith('seedCommunity.js')) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

export { add as seedCommunity, remove as removeCommunity };
