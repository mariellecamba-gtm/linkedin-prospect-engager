// linkedin-prospect-engager -- one daily run.
//
// config/prospects.csv -> their posts from the last day (Apify) -> a drafted
// comment and DM angle for each one worth engaging (Claude or GPT) -> a markdown
// file you can work top down, plus a Google Sheet and a GitHub issue if you
// configured them.
//
// Required env: APIFY_API_KEY, and one of ANTHROPIC_API_KEY / OPENAI_API_KEY.
// Optional: SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON, SLACK_BOT_TOKEN + SLACK_CHANNEL,
// PUBLISH_ISSUE, POSTED_LIMIT, MAX_POSTS_PER_PROFILE, MAX_DRAFTS, MODEL, DRY_RUN=1.
//
// Flags: --dry-run, --limit=N (only the first N people),
//        --posted-limit=24h|week|month, --lookback-days=N.

import "./lib/env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadProspects } from "./lib/prospects.mjs";
import { fetchPosts, handleOf } from "./lib/apify.mjs";
import { makeClient, draftAll } from "./lib/draft.mjs";
import { renderDigest } from "./lib/digest.mjs";
import { createIssue, addComment } from "./lib/github.mjs";
import { ensureTab, appendRows, existingPostUrls, FEED_HEADERS, FEED_URL_COLUMN, SKIPPED_HEADERS } from "./lib/sheets.mjs";
import { ping } from "./lib/slack.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name) => args.includes(`--${name}`);

const DRY_RUN = has("dry-run") || process.env.DRY_RUN === "1";
// Empty by default: the run targets a calendar day, not a rolling window. Set
// POSTED_LIMIT (or --posted-limit=week) only to backfill.
const POSTED_LIMIT = flag("posted-limit") || process.env.POSTED_LIMIT || "";
const LOOKBACK_DAYS = Number(flag("lookback-days") || process.env.LOOKBACK_DAYS || 1);
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const MAX_POSTS_PER_PROFILE = Number(process.env.MAX_POSTS_PER_PROFILE || 3);
const MAX_DRAFTS = Number(process.env.MAX_DRAFTS || 60);
const BATCH_SIZE = Number(process.env.APIFY_BATCH_SIZE || 60);
const LIMIT = Number(flag("limit") || 0);

const SHEET_ID = process.env.SHEET_ID || "";
const FEED_TAB = process.env.FEED_TAB || "Feed";
const SKIPPED_TAB = process.env.SKIPPED_TAB || "Skipped";
// In Actions the markdown file disappears with the runner, so the issue is the
// default output there. Locally the file is enough. Either way PUBLISH_ISSUE
// forces the answer.
const PUBLISH_ISSUE = process.env.PUBLISH_ISSUE === "1"
  || (process.env.PUBLISH_ISSUE !== "0" && !SHEET_ID && process.env.GITHUB_ACTIONS === "true");

const STATE_DIR = new URL("../state/", import.meta.url);
const SEEN_PATH = new URL("../state/seen.json", import.meta.url);
const OUTPUT_DIR = new URL("../output/", import.meta.url);
const SEEN_KEEP = 8000;

async function loadSeen() {
  try {
    const j = JSON.parse(await readFile(SEEN_PATH, "utf8"));
    return { postUrls: new Set(j.postUrls || []) };
  } catch { return { postUrls: new Set() }; }
}

async function saveSeen(seen) {
  // Newest last, oldest trimmed. A post that falls out of the window can never
  // come back in, so forgetting the oldest entries is safe.
  const urls = [...seen.postUrls].slice(-SEEN_KEEP);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SEEN_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), postUrls: urls }, null, 2) + "\n");
}

/** Calendar date in your timezone, N days back, as YYYY-MM-DD. */
function localDate(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const excerptFor = (post, limit = 600) => {
  const t = String(post.text || "").trim();
  return t.length > limit ? `${t.slice(0, limit).trimEnd()}...` : t;
};

const feedRow = ({ prospect, post, draft }, today) => [
  today, "To do", prospect.name || post.authorName || prospect.key, prospect.title || "",
  prospect.company || "", post.postUrl, draft.comment || "",
  // A draft that failed the blocklist twice still ships, and you should know
  // which one before you paste it.
  (draft.needsEdit ? "⚠ read this one before posting: " : "") + (draft.angle || ""),
  draft.dm || "", prospect.note || "", prospect.profileUrl,
];

const skippedRow = ({ prospect, post, draft }, today) => [
  today, prospect.name || post.authorName || prospect.key, prospect.company || "",
  post.postUrl, draft.tag || "", draft.angle || "", excerptFor(post, 300),
];

async function writeSheet(engage, skipped, today) {
  const feed = await ensureTab(SHEET_ID, FEED_TAB, FEED_HEADERS, {
    // The post sits next to the comment written for it, so one glance covers both.
    wrapColumns: [{ index: 6, width: 460 }, { index: 7, width: 260 }, { index: 8, width: 340 }],
    statusColumn: 1,
  });
  await ensureTab(SHEET_ID, SKIPPED_TAB, SKIPPED_HEADERS, { wrapColumns: [{ index: 5, width: 320 }, { index: 6, width: 400 }] });

  const added = await appendRows(SHEET_ID, FEED_TAB, engage.map((j) => feedRow(j, today)));
  await appendRows(SHEET_ID, SKIPPED_TAB, skipped.map((j) => skippedRow(j, today)));
  return { url: feed.url, added };
}

async function main() {
  const started = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Fail before spending Apify credits, not after. A run without drafts still
  // marks every post it saw as seen, so those posts would never be drafted
  // again: a missing key would quietly cost a day of the feed. Set
  // ALLOW_NO_DRAFTS=1 to publish the raw feed anyway.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !DRY_RUN && process.env.ALLOW_NO_DRAFTS !== "1") {
    throw new Error("No drafting key set (ANTHROPIC_API_KEY or OPENAI_API_KEY). Add one to .env, or set ALLOW_NO_DRAFTS=1 to publish the feed without drafted comments.");
  }

  // 1. Who we are tracking.
  const { prospects: all, skipped: badRows } = await loadProspects();
  console.log(`tracking ${all.length} people from config/prospects.csv${badRows ? ` (${badRows} row(s) without a usable LinkedIn URL were ignored)` : ""}`);

  const prospects = LIMIT ? all.slice(0, LIMIT) : all;
  const byHandle = new Map(prospects.map((p) => [handleOf(p.profileUrl), p]));

  // 2. Their posts. The default window is yesterday in your timezone: a rolling
  //    24h read at 10am would start at 10am yesterday and lose everything posted
  //    before it. The cutoff is midnight UTC of that date, which is more
  //    generous than local midnight and therefore never clips the morning.
  const sinceDate = localDate(LOOKBACK_DAYS);
  const window = POSTED_LIMIT ? `postedLimit=${POSTED_LIMIT}` : `since ${sinceDate}`;
  const { posts, runs, tooOld } = await fetchPosts(prospects.map((p) => p.profileUrl), {
    maxPosts: MAX_POSTS_PER_PROFILE,
    postedLimit: POSTED_LIMIT,
    postedLimitDate: POSTED_LIMIT ? "" : sinceDate,
    minPostedAt: POSTED_LIMIT ? "" : `${sinceDate}T00:00:00Z`,
    batchSize: BATCH_SIZE,
    onBatch: (done, total, found) => console.log(`  scraped batch ${done}/${total} (${found} posts)`),
  });
  const runNote = runs.map((r) => `${r.status}:${r.size}`).join(" ");
  console.log(`apify: ${runs.length} run(s) [${runNote}] -> ${posts.length} posts in window (${window})${tooOld ? `, ${tooOld} older dropped` : ""}`);

  // 3. Keep only fresh posts written by someone we actually track. Quote posts
  //    carry the quoted author, so an untracked handle here is not an error.
  const seen = await loadSeen();

  // Second dedupe layer, independent of state/seen.json: whatever is already in
  // the sheet. state/seen.json can be lost to a fresh clone, and a duplicate row
  // means a comment drafted twice on the same post.
  if (SHEET_ID) {
    try {
      const inSheet = [
        ...(await existingPostUrls(SHEET_ID, FEED_TAB, FEED_URL_COLUMN)),
        ...(await existingPostUrls(SHEET_ID, SKIPPED_TAB, "D")),
      ];
      for (const url of inSheet) seen.postUrls.add(url);
      console.log(`sheet: ${inSheet.length} post(s) already recorded`);
    } catch (e) {
      console.error(`sheet dedupe read failed, falling back to state/seen.json: ${e.message.slice(0, 120)}`);
    }
  }

  const jobs = [];
  let alreadySeen = 0, foreign = 0;
  for (const post of posts) {
    const prospect = byHandle.get(post.authorHandle);
    if (!prospect) { foreign++; continue; }
    if (seen.postUrls.has(post.postUrl)) { alreadySeen++; continue; }
    jobs.push({ prospect, post });
  }
  jobs.sort((a, b) => b.post.engagementTotal - a.post.engagementTotal);

  const capped = Math.max(0, jobs.length - MAX_DRAFTS);
  const toDraft = jobs.slice(0, MAX_DRAFTS);
  console.log(`new posts: ${jobs.length} (skipped ${alreadySeen} already seen, ${foreign} from untracked authors)${capped ? `, drafting the top ${MAX_DRAFTS}` : ""}`);

  // 4. Draft.
  const client = makeClient();
  let drafts = [];
  if (client) console.log(`drafting with ${client.provider}/${client.model}`);
  if (!client) {
    console.log("no drafting key set: publishing the feed without drafts");
    drafts = toDraft.map(() => ({ decision: "comment", tag: "other", angle: "", comment: "(no drafting key set, write it yourself)", dm: "", confidence: "high" }));
  } else if (toDraft.length) {
    let done = 0;
    drafts = await draftAll(client, toDraft, 4, () => { if (++done % 10 === 0) console.log(`  drafted ${done}/${toDraft.length}`); });
  }

  // A failed draft is not a judgment. Those posts stay out of the output and out
  // of state/seen.json so the next run picks them up again: an expired key or an
  // empty credit balance should cost a retry, not the post.
  const engage = [], skipped = [], failed = [];
  toDraft.forEach((job, i) => {
    const draft = drafts[i] ?? { decision: "skip", tag: "other", angle: "no draft returned", confidence: "low", error: true };
    if (draft.error) failed.push({ ...job, draft });
    else if (draft.decision === "comment" && draft.comment) engage.push({ ...job, draft });
    else skipped.push({ ...job, draft });
  });
  if (failed.length) {
    console.error(`${failed.length} draft(s) failed and will be retried next run. First: ${failed[0].draft.angle}`);
  }

  // 5. Publish.
  const stats = {
    prospectsTracked: prospects.length,
    profilesScraped: prospects.length,
    postsFound: posts.length,
    drafted: engage.length,
    draftErrors: failed.length,
    postedLimit: window,
    capped,
  };
  const digest = renderDigest({ engage, skipped, stats, date: today });

  // The markdown file is always written. It is the one output that needs no
  // account anywhere, so a first run works before anything else is configured.
  await mkdir(OUTPUT_DIR, { recursive: true });
  const digestPath = new URL(`../output/digest-${today}.md`, import.meta.url);
  await writeFile(digestPath, [digest.body, ...digest.overflow].join("\n"));
  console.log(`wrote output/digest-${today}.md (${engage.length} to engage, ${skipped.length} skipped)`);

  let issueUrl = "";
  let sheetUrl = "";
  let sheetNote = SHEET_ID ? "sheet: pending" : "sheet: not configured";

  if (DRY_RUN) {
    console.log("[dry-run] nothing written anywhere else, no state saved");
  } else if (engage.length || skipped.length) {
    if (SHEET_ID) {
      try {
        const res = await writeSheet(engage, skipped, today);
        sheetUrl = res.url;
        sheetNote = `sheet: ${res.added} row(s) appended`;
        console.log(`${sheetNote} -> ${sheetUrl}`);
      } catch (e) {
        // A sheet failure must not lose the day's drafts: fall back to the issue.
        sheetNote = `sheet: FAILED (${e.message.slice(0, 120)})`;
        console.error(sheetNote);
      }
    }
    if (PUBLISH_ISSUE || sheetNote.startsWith("sheet: FAILED")) {
      try {
        const issue = await createIssue({ title: digest.title, body: digest.body, labels: ["prospect-posts"] });
        issueUrl = issue.url;
        for (const chunk of digest.overflow) await addComment(issue.number, chunk);
        console.log(`issue #${issue.number} ${issue.url}`);
      } catch (e) {
        // The digest is already on disk, so this is a delivery failure, not a
        // data loss. Say so and carry on.
        console.error(`issue: FAILED (${e.message.slice(0, 160)})`);
      }
    }
    for (const job of [...engage, ...skipped]) seen.postUrls.add(job.post.postUrl);
    await saveSeen(seen);
  } else {
    console.log("nothing new today, nothing recorded");
  }

  const slackNote = DRY_RUN || !engage.length ? "slack: skipped" : await ping(
    `${engage.length} prospect post${engage.length === 1 ? "" : "s"} worth a comment today. ${sheetUrl || issueUrl}`,
  );

  const summary = [
    `people=${stats.prospectsTracked} posts=${stats.postsFound} new=${jobs.length} engage=${engage.length} skip=${skipped.length}` + (failed.length ? ` failed=${failed.length}` : "") + (capped ? ` capped=${capped}` : ""),
    `apify runs: ${runNote}`,
    sheetNote,
    `${slackNote} · ${Math.round((Date.now() - started) / 1000)}s`,
  ].join("\n");
  console.log(summary);

  if (failed.length && !engage.length && !skipped.length) {
    throw new Error(`every draft failed (${failed.length}). Nothing was recorded, so the next run retries them. Cause: ${failed[0].draft.angle}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY && !DRY_RUN) {
    const link = sheetUrl ? `[Open the sheet](${sheetUrl})` : issueUrl ? `[${digest.title}](${issueUrl})` : "";
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `### LinkedIn Prospect Engager\n\n${link ? `${link}\n\n` : ""}\`\`\`\n${summary}\n\`\`\`\n`, { flag: "a" });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("fatal:", e.message || e); process.exit(1); });
}
