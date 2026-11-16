const ENDPOINT = 'https://leetcode.com/graphql';
const TIMEOUT_MS = 15000;

async function gql(query, variables = {}) {
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
  if (!res.ok) throw new Error(`LeetCode responded with ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
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

// LeetCode caps this list at the 20 most recent accepted submissions.
export async function fetchRecentAccepted(username) {
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
