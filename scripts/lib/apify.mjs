// Fetches the tracked prospects' recent LinkedIn posts through the same actor
// the linkedin-writer-learner repo uses: harvestapi/linkedin-profile-posts.
//
// Two differences from that repo's src/apify.ts, both forced by scale. It scrapes
// ~25 profiles, this scrapes ~500:
//   1. `targetUrls` takes a batch, so profiles go in chunks rather than one run each.
//   2. The run is started asynchronously and polled. run-sync-get-dataset-items
//      holds one HTTP connection open for the whole run, which a 500-profile
//      batch will outlive.

const BASE = "https://api.apify.com/v2";
const ACTOR = "harvestapi~linkedin-profile-posts";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.APIFY_API_KEY || process.env.APIFY_TOKEN;
  if (!t) throw new Error("APIFY_API_KEY is not set");
  return t;
}

/** The `/in/<handle>/` segment, lowercased. The only stable identity a post carries. */
export function handleOf(url) {
  return (String(url || "").match(/\/in\/([^/?#]+)/)?.[1] ?? "").toLowerCase();
}

function detectPostType(raw) {
  if (raw?.document) return "carousel";
  const images = Array.isArray(raw?.postImages) ? raw.postImages.length : 0;
  if (images > 1) return "carousel";
  if (images === 1) return "image";
  if (raw?.video || raw?.postVideo) return "video";
  if (raw?.poll) return "poll";
  if (raw?.article) return "article";
  return "text";
}

function normalize(item) {
  const postUrl = item?.linkedinUrl ?? item?.shareLinkedinUrl;
  if (!postUrl) return null;
  const eng = item?.engagement ?? {};
  const likes = Number(eng.likes) || 0;
  const comments = Number(eng.comments) || 0;
  const reposts = Number(eng.shares) || 0;
  return {
    authorHandle: String(item?.author?.publicIdentifier ?? "").toLowerCase(),
    authorName: String(item?.author?.name ?? "").trim(),
    postUrl,
    postedAt: item?.postedAt?.date ?? item?.postedAt?.timestamp ?? "",
    postType: detectPostType(item),
    text: String(item?.content ?? "").slice(0, 4000),
    likes, comments, reposts,
    engagementTotal: likes + comments + reposts,
    scrapedAt: new Date().toISOString(),
  };
}

async function api(path, init = {}, timeoutMs = 60000) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${BASE}${path}${sep}token=${encodeURIComponent(token())}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 401 || r.status === 403) throw new Error("Apify auth failed. Check APIFY_API_KEY.");
  if (r.status === 402) throw new Error("Apify usage limit reached. Raise the monthly cap or wait for the reset.");
  if (!r.ok) throw new Error(`Apify ${init.method ?? "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function runBatch(targetUrls, { maxPosts, postedLimit, postedLimitDate, runTimeoutSecs }) {
  const started = await api(`/acts/${ACTOR}/runs?timeout=${runTimeoutSecs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetUrls,
      maxPosts,
      // Reposts are not the prospect's own words, so there is nothing to react
      // to in a comment. Quote posts are kept: the quote is theirs.
      includeReposts: false,
      includeQuotePosts: true,
      scrapeReactions: false,
      scrapeComments: false,
      // postedLimitDate is an exact cutoff ("2026-08-19"), postedLimit is a
      // rolling window ("24h"). The date is what "yesterday's posts" needs: a
      // rolling 24h read at 10am starts at 10am yesterday and loses the morning.
      ...(postedLimitDate ? { postedLimitDate } : {}),
      ...(postedLimit && postedLimit !== "any" ? { postedLimit } : {}),
    }),
  });

  const runId = started?.data?.id;
  const datasetId = started?.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error("Apify did not return a run id");

  const deadline = Date.now() + (runTimeoutSecs + 120) * 1000;
  let status = started.data.status;
  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) throw new Error(`Apify run ${runId} still ${status} past its deadline`);
    await sleep(10_000);
    status = (await api(`/actor-runs/${runId}`)).data?.status ?? status;
  }
  // A FAILED run usually still has partial results in the dataset. Take them and
  // report the failure rather than losing a whole day of posts to one bad profile.
  const items = await api(`/datasets/${datasetId}/items?clean=true&format=json`, {}, 120_000);
  return { status, items: Array.isArray(items) ? items : [], runId };
}

/**
 * @param {string[]} profileUrls
 * @returns {Promise<{posts: object[], runs: {runId: string, status: string, size: number}[]}>}
 */
export async function fetchPosts(profileUrls, {
  maxPosts = 3,
  postedLimit = "",
  postedLimitDate = "",
  minPostedAt = "",
  batchSize = 60,
  runTimeoutSecs = 1800,
  onBatch = () => {},
} = {}) {
  const posts = [];
  const runs = [];
  const seenUrls = new Set();
  // Belt and braces. If the actor ever ignores postedLimitDate it would return
  // each profile's newest posts whatever their age, and stale posts would be
  // drafted as if they were yesterday's.
  const cutoff = minPostedAt ? Date.parse(minPostedAt) : NaN;
  let tooOld = 0;

  for (let i = 0; i < profileUrls.length; i += batchSize) {
    const chunk = profileUrls.slice(i, i + batchSize);
    let result;
    try {
      result = await runBatch(chunk, { maxPosts, postedLimit, postedLimitDate, runTimeoutSecs });
    } catch (e) {
      // One dead batch should not take the other 400 profiles with it.
      runs.push({ runId: "-", status: `ERROR: ${e.message}`, size: 0 });
      if (/auth failed|usage limit/i.test(e.message)) throw e;
      continue;
    }
    runs.push({ runId: result.runId, status: result.status, size: result.items.length });
    // Nine sequential batches take minutes. Without this the run looks hung.
    onBatch(runs.length, Math.ceil(profileUrls.length / batchSize), result.items.length);
    for (const item of result.items) {
      const post = normalize(item);
      if (!post || seenUrls.has(post.postUrl)) continue;
      // An unparseable date is kept rather than dropped: better a stale post in
      // the sheet than a silent hole in the feed.
      const posted = Date.parse(post.postedAt);
      if (Number.isFinite(cutoff) && Number.isFinite(posted) && posted < cutoff) { tooOld++; continue; }
      seenUrls.add(post.postUrl);
      posts.push(post);
    }
  }
  return { posts, runs, tooOld };
}
