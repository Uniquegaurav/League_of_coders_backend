import { C, avatar, chip, frame, h, stat, tierFor } from './ogImage.js';
import { compareStanding } from './scoring.js';
import { config } from '../config.js';

const SITE = new URL(config.appUrl).host;

// The four preview cards. Each takes plain data and returns a satori tree.
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const mixLabel = (s) =>
  [
    s.easy && `${s.easy} Easy`,
    s.medium && `${s.medium} Medium`,
    s.hard && `${s.hard} Hard`,
  ]
    .filter(Boolean)
    .join(' · ');

const mixFromProblems = (problems) =>
  mixLabel({
    easy: problems.filter((p) => p.difficulty === 'Easy').length,
    medium: problems.filter((p) => p.difficulty === 'Medium').length,
    hard: problems.filter((p) => p.difficulty === 'Hard').length,
  });

const title = (text, size = 64) =>
  h('div', { fontSize: size, fontWeight: 800, lineHeight: 1.1, maxWidth: 1072, overflow: 'hidden' }, text);

export function battleCard(match) {
  const active = match.participants.filter((p) => !p.left);
  const host = match.participants.find((p) => String(p.user) === String(match.host));
  if (match.status === 'finished') {
    const top = [...match.participants].sort(compareStanding).slice(0, 3);
    return frame(
      h(
        'div',
        { flexDirection: 'column' },
        h('div', { fontSize: 26, color: C.sub, textTransform: 'uppercase', letterSpacing: 3 }, 'Battle results'),
        title(match.name, 56),
        h(
          'div',
          { marginTop: 28, gap: 20 },
          ...top.map((p, i) =>
            h(
              'div',
              { alignItems: 'center', padding: '16px 22px', background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, gap: 16 },
              h('div', { fontSize: 40, fontWeight: 800, color: [C.medium, '#d4d6e0', '#fb923c'][i] }, String(i + 1)),
              avatar(p.name, 64, [C.medium, '#d4d6e0', '#fb923c'][i]),
              h('div', { flexDirection: 'column' }, h('div', { fontSize: 26, fontWeight: 600 }, p.name.slice(0, 16)), h('div', { fontSize: 22, color: C.sub }, `${p.score} pts`))
            )
          )
        )
      ),
      `${match.participants.length} players · ${mixLabel(match.settings)} · ${SITE}`
    );
  }
  const who = match.event?.key ? match.name : `${host?.name || 'A player'} invited you to a coding battle`;
  return frame(
    h(
      'div',
      { flexDirection: 'column' },
      h('div', { fontSize: 26, color: C.neon, textTransform: 'uppercase', letterSpacing: 3 }, match.status === 'lobby' ? 'Lobby open' : 'Live now'),
      title(who, 60),
      !match.event?.key && h('div', { fontSize: 30, color: C.sub, marginTop: 10 }, match.name),
      h(
        'div',
        { marginTop: 32, gap: 14, alignItems: 'center' },
        chip(`${active.length}/${match.settings.maxPlayers} players`, C.text),
        chip(`${match.settings.durationMin} min`),
        chip(mixLabel(match.settings)),
        h('div', { marginLeft: 12, fontSize: 40, fontWeight: 800, letterSpacing: 8, color: C.brand }, match.code)
      )
    ),
    'Join with one click · scores come from accepted LeetCode submissions'
  );
}

export function profileCard(user, { weekRank = null } = {}) {
  const s = user.stats;
  const tier = tierFor(s.rating);
  const winRate = s.matches ? Math.round((s.wins / s.matches) * 100) : 0;
  return frame(
    h(
      'div',
      { flexDirection: 'column' },
      h(
        'div',
        { alignItems: 'center', gap: 32 },
        avatar(user.name, 140, tier.color),
        h(
          'div',
          { flexDirection: 'column' },
          h('div', { fontSize: 26, fontWeight: 600, color: tier.color, textTransform: 'uppercase', letterSpacing: 3 }, tier.name),
          title(user.name, 64),
          h('div', { fontSize: 26, color: C.sub, marginTop: 6 }, [`@${user.username}`, user.college].filter(Boolean).join(' · '))
        )
      ),
      h(
        'div',
        { marginTop: 36, gap: 18 },
        stat('Rating', s.rating, C.brand),
        stat('Wins', s.wins, C.medium),
        stat('Battles', s.matches),
        stat('Win rate', `${winRate}%`),
        stat('Solved', Math.max(s.solved, user.solvedSlugs?.length || 0), C.easy)
      )
    ),
    weekRank ? `#${weekRank} this week · ${SITE}` : `${(user.badges || []).length} badges · ${SITE}`
  );
}

export function resultCard(match, participant) {
  const rated = match.participants.length >= 2; // multiplayer: show place
  const ratingMoved = match.rated ?? rated;
  const rank = participant.rank || [...match.participants].sort(compareStanding).indexOf(participant) + 1;
  const delta = participant.ratingAfter != null && participant.ratingBefore != null ? participant.ratingAfter - participant.ratingBefore : null;
  const headline = !rated
    ? `${participant.name} scored ${participant.score} in a solo test`
    : rank === 1
      ? `${participant.name} won ${match.name}`
      : `${participant.name} finished ${ordinal(rank)} of ${match.participants.length}`;
  return frame(
    h(
      'div',
      { flexDirection: 'column' },
      h(
        'div',
        { alignItems: 'center', gap: 28 },
        avatar(participant.name, 120, rank === 1 && rated ? C.medium : C.brandSolid),
        h(
          'div',
          { flexDirection: 'column', maxWidth: 880 },
          h('div', { fontSize: 26, color: C.sub, textTransform: 'uppercase', letterSpacing: 3 }, rated ? 'Battle result' : 'Solo test'),
          title(headline, 56)
        )
      ),
      h(
        'div',
        { marginTop: 36, gap: 18 },
        rated && stat('Place', ordinal(rank), rank === 1 ? C.medium : C.text),
        stat('Points', participant.score, C.brand),
        stat('Solved', `${participant.solves.length}/${match.problems.length}`, C.easy),
        delta !== null && ratingMoved && stat('Rating', delta > 0 ? `+${delta}` : String(delta), delta >= 0 ? C.easy : C.hard),
        !(delta !== null && ratingMoved) && participant.xp ? stat('XP', `+${participant.xp}`, C.neon) : null
      )
    ),
    `${mixLabel(match.settings)} · ${match.settings.durationMin} min · think you can beat it? ${SITE}`
  );
}

export function challengeCard(challenge) {
  const creator = challenge.attempts.find((a) => String(a.user) === String(challenge.creator));
  const done = challenge.attempts.filter((a) => a.status === 'done');
  const best = [...done].sort((a, b) => b.score - a.score)[0];
  return frame(
    h(
      'div',
      { flexDirection: 'column' },
      h('div', { fontSize: 26, color: C.medium, textTransform: 'uppercase', letterSpacing: 3 }, 'Beat my score'),
      title(`${creator?.name || 'A player'} scored ${creator?.score ?? 0}. Can you beat it?`, 60),
      h(
        'div',
        { marginTop: 32, gap: 14, alignItems: 'center' },
        chip(mixFromProblems(challenge.problems), C.text),
        chip(`${challenge.durationMin} min`),
        chip(`${done.length} attempt${done.length === 1 ? '' : 's'}`),
        best && best !== creator && chip(`Top: ${best.name} ${best.score}`, C.medium)
      )
    ),
    `Same problems, same clock, any time · ${SITE}`
  );
}

export function defaultCard() {
  return frame(
    h(
      'div',
      { flexDirection: 'column' },
      title('Battle your friends on LeetCode problems', 68),
      h('div', { fontSize: 30, color: C.sub, marginTop: 18 }, 'Live scoreboards, Elo ratings, daily battle hour and the Sunday Cup.')
    ),
    `${SITE} · free to play`
  );
}
