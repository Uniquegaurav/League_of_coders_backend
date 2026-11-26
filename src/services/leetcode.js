// Overridable so tests can point at a stand-in server.
const ENDPOINT = process.env.LEETCODE_GRAPHQL_URL || 'https://leetcode.com/graphql';
const TIMEOUT_MS = 15000;

// --- Protection against rate limits -------------------------------------------------------------
// More players means more polling. These guards keep us a polite client so LeetCode does not block us:
//   * at most MAX_CONCURRENT requests in flight, the rest wait in a queue
//   * 429 / 5xx responses are retried with exponential backoff
//   * after a 429 every caller pauses (cool-down) instead of hammering the API
//   * concurrent "recent accepted" lookups for the same player share one request
const MAX_CONCURRENT = Number(process.env.LEETCODE_MAX_CONCURRENT) || 4;
const MAX_RETRIES = 3;
let active = 0;
const queue = [];
let coolDownUntil = 0;
export const leetcodeStats = { requests: 0, retries: 0, rateLimited: 0, failures: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise((resolve) => queue.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  queue.shift()?.();
}

class RetryableError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export class SessionError extends Error {}

// `auth` ({ session, csrf }) signs the request in as that player. Only used for a Premium player's own data.
function authHeaders(auth) {
  if (!auth?.session) return {};
  const cookies = [`LEETCODE_SESSION=${auth.session}`];
  if (auth.csrf) cookies.push(`csrftoken=${auth.csrf}`);
  return { Cookie: cookies.join('; '), ...(auth.csrf ? { 'x-csrftoken': auth.csrf } : {}) };
}

async function request(query, variables, auth) {
  const wait = coolDownUntil - Date.now();
  if (wait > 0) await sleep(wait);
  leetcodeStats.requests += 1;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://leetcode.com',
      'User-Agent': 'Mozilla/5.0 (LeagueOfCoders)',
      ...authHeaders(auth),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
    if (res.status === 429) {
      leetcodeStats.rateLimited += 1;
      coolDownUntil = Math.max(coolDownUntil, Date.now() + Math.max(retryAfter, 10000));
    }
    throw new RetryableError(`LeetCode responded with ${res.status}`, retryAfter);
  }
  if (auth && (res.status === 401 || res.status === 403)) throw new SessionError('LeetCode did not accept this session');
  if (!res.ok) throw new Error(`LeetCode responded with ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function gql(query, variables = {}, auth = null) {
  await acquire();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(query, variables, auth);
      } catch (err) {
        const retryable = err instanceof RetryableError || err.name === 'TimeoutError' || err.cause?.code === 'ECONNRESET';
        if (!retryable || attempt >= MAX_RETRIES) {
          leetcodeStats.failures += 1;
          throw err;
        }
        leetcodeStats.retries += 1;
        const backoff = Math.max(err.retryAfterMs || 0, 1000 * 2 ** attempt) + Math.random() * 500;
        await sleep(backoff);
      }
    }
  } finally {
    release();
  }
}

export async function fetchUserProfile(username) {
  const data = await gql(
    `query($username: String!) {
      matchedUser(username: $username) {
        username
        profile { aboutMe userAvatar realName }
      }
    }`,
    { username }
  ).catch((err) => {
    if (/does not exist/i.test(err.message)) return { matchedUser: null };
    throw err;
  });
  const user = data.matchedUser;
  if (!user) return null;
  return {
    username: user.username,
    aboutMe: user.profile?.aboutMe || '',
    avatar: user.profile?.userAvatar || null,
  };
}

// Several matches can ask for the same player at the same moment; they share one in-flight request.
// Finished results are never reused, so the final sweep at the buzzer always sees the latest solves.
const inFlight = new Map(); // username -> promise

// LeetCode caps this list at the 20 most recent accepted submissions.
export function fetchRecentAccepted(username, { fresh = false } = {}) {
  const key = String(username).toLowerCase();
  if (fresh) return loadRecentAccepted(username);
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = loadRecentAccepted(username).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function loadRecentAccepted(username) {
  const data = await gql(
    `query($username: String!, $limit: Int!) {
      recentAcSubmissionList(username: $username, limit: $limit) { titleSlug timestamp }
    }`,
    { username, limit: 20 }
  );
  return (data.recentAcSubmissionList || []).map((s) => ({
    slug: s.titleSlug,
    solvedAt: new Date(Number(s.timestamp) * 1000),
  }));
}

export async function fetchProblemPage(skip, limit = 100) {
  const data = await gql(
    `query($skip: Int, $limit: Int) {
      questionList(categorySlug: "", limit: $limit, skip: $skip, filters: {}) {
        total: totalNum
        data {
          frontendId: questionFrontendId
          title
          titleSlug
          difficulty
          paidOnly: isPaidOnly
          acRate
          topicTags { name }
        }
      }
    }`,
    { skip, limit }
  );
  return {
    total: data.questionList.total,
    problems: data.questionList.data.map((q) => ({
      slug: q.titleSlug,
      frontendId: q.frontendId,
      title: q.title,
      difficulty: q.difficulty,
      paidOnly: q.paidOnly,
      acRate: q.acRate,
      tags: q.topicTags.map((t) => t.name),
    })),
  };
}

export async function fetchProblemDetail(slug) {
  const data = await gql(
    `query($slug: String!) {
      question(titleSlug: $slug) {
        questionFrontendId
        title
        difficulty
        isPaidOnly
        content
        hints
        exampleTestcaseList
        topicTags { name }
        codeSnippets { lang langSlug code }
      }
    }`,
    { slug }
  );
  const q = data.question;
  if (!q) return null;
  return {
    frontendId: q.questionFrontendId,
    title: q.title,
    difficulty: q.difficulty,
    paidOnly: q.isPaidOnly,
    tags: q.topicTags.map((t) => t.name),
    detail: {
      content: q.content,
      hints: q.hints || [],
      exampleTestcases: q.exampleTestcaseList || [],
      snippets: q.codeSnippets || [],
      fetchedAt: new Date(),
    },
  };
}

// A LeetCode study plan (Top Interview 150, LeetCode 75, ...). Called about once a week per plan.
export async function fetchStudyPlan(slug) {
  const data = await gql(
    `query($slug: String!) {
      studyPlanV2Detail(planSlug: $slug) {
        slug
        name
        planSubGroups { name questions { titleSlug title difficulty paidOnly } }
      }
    }`,
    { slug }
  );
  return data.studyPlanV2Detail || null;
}

// --- Premium: a player's own LeetCode data, read with their session -----------------------------

const normDifficulty = (d) => {
  const v = String(d || '').toLowerCase();
  return v ? v[0].toUpperCase() + v.slice(1) : v;
};
const toStub = (q) => ({
  slug: q.titleSlug,
  title: q.title,
  frontendId: q.questionFrontendId || q.frontendId || undefined,
  difficulty: normDifficulty(q.difficulty),
  paidOnly: !!(q.paidOnly ?? q.isPaidOnly),
});

/** Who this session belongs to. Throws SessionError when it is not signed in. */
export async function fetchSessionUser(auth) {
  const data = await gql(`query { userStatus { isSignedIn isPremium username } }`, {}, auth);
  const s = data.userStatus;
  if (!s?.isSignedIn) throw new SessionError('This session is signed out. Copy a fresh LEETCODE_SESSION cookie.');
  return { username: s.username, isPremium: !!s.isPremium };
}

const FAVORITE_QUESTIONS = `query($favoriteSlug: String!, $skip: Int, $limit: Int) {
  favoriteQuestionList(favoriteSlug: $favoriteSlug, skip: $skip, limit: $limit) {
    questions { titleSlug title difficulty paidOnly questionFrontendId }
    totalLength
    hasMore
  }
}`;

/** Every question in one LeetCode favourite (a saved list, or a company list such as google-six-months). */
export async function fetchFavoriteQuestions(auth, favoriteSlug) {
  const out = [];
  for (let skip = 0; skip < 5000; ) {
    const data = await gql(FAVORITE_QUESTIONS, { favoriteSlug, skip, limit: 100 }, auth);
    const page = data.favoriteQuestionList;
    if (!page) break;
    out.push(...page.questions.map(toStub));
    skip += page.questions.length;
    if (!page.hasMore || !page.questions.length) break;
  }
  return out;
}

/** The lists this player created on LeetCode, with their questions. */
export async function fetchMyLists(auth) {
  try {
    const data = await gql(`query { myCreatedFavoriteList { favorites { slug name } } }`, {}, auth);
    const favorites = data.myCreatedFavoriteList?.favorites || [];
    const lists = [];
    for (const f of favorites) lists.push({ id: f.slug, name: f.name, questions: await fetchFavoriteQuestions(auth, f.slug) });
    return lists;
  } catch (err) {
    if (err instanceof SessionError) throw err;
    // Older schema, still served on some accounts.
    const data = await gql(
      `query { favoritesLists { allFavorites { idHash name questions { titleSlug title difficulty isPaidOnly questionFrontendId } } } }`,
      {},
      auth
    );
    return (data.favoritesLists?.allFavorites || []).map((f) => ({ id: f.idHash, name: f.name, questions: f.questions.map(toStub) }));
  }
}

export const COMPANY_PERIODS = ['thirty-days', 'three-months', 'six-months', 'more-than-six-months', 'all'];

/** Questions a company asked in a period. Needs a LeetCode Premium session. */
export async function fetchCompanyQuestions(auth, company, period = 'six-months') {
  try {
    return await fetchFavoriteQuestions(auth, `${company}-${period}`);
  } catch (err) {
    if (err instanceof SessionError) throw err;
    // Older schema. An unknown company errors on both: report it as "no questions" rather than a failure.
    const data = await gql(
      `query($slug: String!) { companyTag(slug: $slug) { name questions { titleSlug title difficulty isPaidOnly questionFrontendId } } }`,
      { slug: company },
      auth
    ).catch((e) => {
      if (e instanceof SessionError) throw e;
      return null;
    });
    return (data?.companyTag?.questions || []).map(toStub);
  }
}
