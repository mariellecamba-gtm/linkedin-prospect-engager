// Optional. Opens the daily digest as a GitHub issue when the tool runs in
// Actions, so the feed lands somewhere you can read on your phone.
//
// Zero dependencies: Node 20's fetch is enough. Needs GITHUB_TOKEN and
// GITHUB_REPOSITORY, both of which Actions injects for you.

const API = "https://api.github.com";

function headers() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "linkedin-prospect-engager",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh(path, init = {}, timeoutMs = 30000) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export function currentRepo() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set, so there is no repo to open the issue in. Set PUBLISH_ISSUE=0 to skip the issue.");
  return repo;
}

export async function createIssue({ title, body, labels = [] }, repo = currentRepo()) {
  const issue = await gh(`/repos/${repo}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels }),
  });
  return { number: issue.number, url: issue.html_url };
}

export async function addComment(issueNumber, body, repo = currentRepo()) {
  return gh(`/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}
