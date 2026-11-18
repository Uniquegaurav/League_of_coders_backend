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

async function request(query, variables) {
  const wait = coolDownUntil - Date.now();
  if (wait > 0) await sleep(wait);
  leetcodeStats.requests += 1;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://leetcode.com',
      'User-Agent': 'Mozilla/5.0 (LeagueOfCoders)',
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
  if (!res.ok) throw new Error(`LeetCode responded with ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function gql(query, variables = {}) {
  await acquire();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(query, variables);
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
