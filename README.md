# League of Coders — backend

Express + MongoDB (Mongoose 8) + socket.io. Node 18+.

```bash
cp .env.example .env
npm install
npm run dev        # or npm start
npm test           # scoring / rating / shuffle unit tests
```

| Variable | Purpose |
| --- | --- |
| `CONNECTION_URL` | MongoDB connection string |
| `JWT_SECRET` | **Required in production.** Secret used to sign session tokens |
| `CLIENT_ORIGIN` | Comma-separated allowed frontend origins (`*` allowed) |
| `GOOGLE_CLIENT_ID` | Optional, enables Google sign-in (ID tokens are verified server-side) |
| `POLL_INTERVAL_SEC` | How often live battles check LeetCode for accepted submissions (default 20) |

## How a battle works

1. **Lobby.** A host creates a match and gets a 6-character code (no look-alike characters) and invite link
   `/m/CODE`. State lives in MongoDB, so refreshes, reconnects and late page loads all recover.
2. **Start.** Only the host can start. The server picks the problems, shows a 5-second countdown, then reveals
   the problems to everyone at the same moment. Timers are rescheduled automatically if the server restarts.
3. **Live.** Players submit on LeetCode. Every `POLL_INTERVAL_SEC` the server reads each player's recent accepted
   submissions (players can also press "Check my submissions", 8s cooldown). Accepted submissions only count if
   they're for a problem in the match **and** were accepted between the start and the buzzer.
4. **Finish.** At the buzzer, when every active player has solved everything, or when the host ends it. A final
   check runs first so last-second solves count. Then ranks, Elo ratings and career stats are written.

### Where questions come from and how they're picked

- **Interview classics:** the 170 hand-picked problems in `src/data/curated.json`, seeded on boot.
- **All free LeetCode:** the full public catalogue (~4k problems) mirrored from LeetCode's GraphQL API on boot
  and every 6 hours (skipped if it synced in the last 24h). Premium problems are always excluded.

Selection (`services/questionBank.js`): filter the pool by difficulty and optional topics → remove excluded
problems → **Fisher–Yates shuffle using `crypto.randomInt`** → take N per difficulty → order Easy → Medium → Hard.
The selection happens on the server at start time, so nobody sees the problems early.

**Skip solved problems (per player, on by default):** for every player who opted in, the server excludes problems they
solved in past battles, problems they marked solved in Practice, and their 20 most recent LeetCode accepted
submissions (LeetCode's public API returns only the last 20). If excluding leaves too few problems, it reuses
already-solved ones and says so in the room.

### Scoring (`services/scoring.js`)

```
points = base + speed bonus + first-solve bonus
base         Easy 100 · Medium 200 · Hard 300
speed bonus  round(base × 0.5 × time_remaining / duration)
first solve  +25 for the earliest accepted submission on that problem
```

Times come from LeetCode's submission timestamps, not from when we noticed them, and scores are recomputed from
scratch on every new solve. So the polling order never changes who got first solve.
Ranking: score → problems solved → earliest final solve. Battles with 2+ players are rated with pairwise
(multiplayer) Elo, K = 40 spread over the field. Everyone starts at 1200.

### Fair play

- Each LeetCode account can be linked to only one League of Coders account.
- Optional ownership proof: the player puts a generated token in their LeetCode profile summary and we check it.
  Verified players get a shield badge.
- Players can't join once a match has started (they can spectate). Leaving mid-match counts as a forfeit and keeps
  the score earned so far.

## API overview

`/api/auth` (register, login, google, me) · `/api/users` (profile, LeetCode link/verify, solved list,
leaderboard) · `/api/problems` (list, topics, detail) · `/api/matches` (create, open, recent, mine, stats,
get, join, leave, settings, prefs, kick, start, end, check, messages, rematch) · `/api/posts` (feed, create,
delete, like, comments) · `/api/challenges` (create from a finished match, get, attempt) · `/api/events`
(next battle hour / Sunday Cup, past cups).

`/users/leaderboard?scope=all|week|friends|college`, `/users/colleges`, and `/users/:handle/challenge` (direct 1v1).
Profiles accept a username or an id.

## Growth features

- **Usernames and referrals.** Every player gets a `username` (backfilled on boot). Sign-up accepts `ref=<username>`;
  the referrer and the new player each get 100 XP once the new player finishes a battle with at least one solve.
- **Badges** (`services/badges.js`) are awarded after battles, practice solves and referrals.
- **Async challenges** (`models/Challenge.js`): a finished match becomes a fixed problem set and clock that anyone can
  attempt solo. The creator's score is recomputed as a solo run so every attempt is scored the same way.
- **Battle hour and Sunday Cup** (`services/events.js`): a public lobby opens 30 minutes before `BATTLE_HOUR_UTC`
  (default 15:30 UTC = 9 PM IST) and starts on its own with 2+ players. On Sundays it is the Sunday Cup.
- **Link previews** (`routes/share.js`): `/share/*` returns Open Graph tags then redirects into the app, `/og/*.png`
  renders the preview image (satori + resvg), `/sitemap.xml` lists public pages and profiles. The frontend proxies
  `/s/*`, `/og/*` and `/sitemap.xml` here, so links stay on the app's domain.
- **Emails** (`services/email.js`): streak reminders, Monday recap and 1v1 challenges through Resend. Off (dry run)
  until `RESEND_API_KEY` is set; capped at `EMAIL_DAILY_CAP` per day; every email has a one-click unsubscribe.
- **Problem lists** (`services/problemLists.js`): Blind 75 and NeetCode 150 (from NeetCode's public data) and LeetCode's
  Top Interview 150, LeetCode 75 and Top 100 Liked (study plans) are synced weekly into `ProblemList`. Players can make
  up to 20 private lists of their own (`/api/lists`).
- **Planned tournaments** (`models/ScheduledEvent.js`): one-off events that open and run like the battle hour.
- **Demo community** (`scripts/seedCommunity.js`): `npm run seed:community` adds 16 demo players (flagged `bot`, cannot
  sign in, never emailed, left out of the sitemap), posts, past tournaments and planned tournaments.
  `npm run seed:community -- --remove` deletes all of it.
- **LeetCode rate limits** (`services/leetcode.js`): at most 4 requests in flight, retries with backoff on 429/5xx,
  a shared cool-down after a 429, and one request for concurrent lookups of the same player. Counters are on `/health`.

All writes go through REST. Sockets are push-only: clients emit `match:watch { code }` and receive
`match:update`, `match:message` and `match:presence`.

Single-instance by design: per-match locking and timers live in process memory. To run several instances you'd
need a shared lock and the socket.io Redis adapter.
