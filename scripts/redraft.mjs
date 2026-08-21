// Re-draft the comment for Feed rows that are still "To do".
//
// Use this after editing config/voice.md: it rewrites the backlog in the new
// voice instead of waiting for tomorrow's posts.
//
// It is deliberately narrow. It writes **one column, on one set of rows**:
// the Comment draft cell of rows whose Status is still "To do". Any other
// status means you have worked that row, and worked rows are never touched.
// Why bother, the DM, the status and every other column are left exactly as they
// are, including on the rows it does rewrite.
//
//   node scripts/redraft.mjs --dry-run     # print what would change
//   node scripts/redraft.mjs               # write the comment column on To-do rows only

import "./lib/env.mjs";
import { fetchPosts } from "./lib/apify.mjs";
import { makeClient, draftAll } from "./lib/draft.mjs";
import { readValues, writeCells, FEED_HEADERS } from "./lib/sheets.mjs";
import { pathToFileURL } from "node:url";

const SHEET_ID = process.env.SHEET_ID || "";
const FEED_TAB = process.env.FEED_TAB || "Feed";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const OPEN_STATUS = /^(to do|todo|)$/i;

// Column positions, from FEED_HEADERS. Named so a layout change cannot silently
// point the write at the wrong column.
const COL = {
  status: FEED_HEADERS.indexOf("Status"),
  prospect: FEED_HEADERS.indexOf("Prospect"),
  title: FEED_HEADERS.indexOf("Their title"),
  company: FEED_HEADERS.indexOf("Company"),
  postUrl: FEED_HEADERS.indexOf("Post URL"),
  comment: FEED_HEADERS.indexOf("Comment draft"),
  note: FEED_HEADERS.indexOf("Why they're on your list"),
};
const columnLetter = (i) => String.fromCharCode(65 + i);

async function main() {
  if (!SHEET_ID) throw new Error("SHEET_ID is not set");
  const client = makeClient();
  if (!client) throw new Error("No drafting key set (OPENAI_API_KEY or ANTHROPIC_API_KEY)");

  const values = await readValues(SHEET_ID, `${FEED_TAB}!A2:K1000`);
  const targets = [];
  values.forEach((row, i) => {
    if (!row?.length) return;
    if (!OPEN_STATUS.test(String(row[COL.status] ?? "").trim())) return;
    const postUrl = String(row[COL.postUrl] ?? "").trim();
    if (!postUrl) return;
    targets.push({
      rowNumber: i + 2, // A2 is row 2
      postUrl,
      current: String(row[COL.comment] ?? ""),
      prospect: {
        key: postUrl, name: row[COL.prospect] ?? "", title: row[COL.title] ?? "",
        company: row[COL.company] ?? "", note: row[COL.note] ?? "",
        profileUrl: row[FEED_HEADERS.indexOf("Profile URL")] ?? "",
      },
    });
  });

  const worked = values.filter((r) => r?.length && !OPEN_STATUS.test(String(r[COL.status] ?? "").trim())).length;
  console.log(`${targets.length} row(s) still To do, ${worked} already worked and left alone`);
  if (!targets.length) return;

  // The actor takes post URLs as targets, so only these posts are re-read.
  const { posts } = await fetchPosts(targets.map((t) => t.postUrl), {
    maxPosts: 1,
    onBatch: (done, total, found) => console.log(`  re-read batch ${done}/${total} (${found} posts)`),
  });
  const byUrl = new Map(posts.map((p) => [p.postUrl, p]));

  const jobs = [], missing = [];
  for (const t of targets) {
    const post = byUrl.get(t.postUrl);
    if (post) jobs.push({ ...t, post });
    else missing.push(t);
  }
  if (missing.length) console.log(`  ${missing.length} post(s) could not be re-read and keep their current draft`);
  if (!jobs.length) return;

  const drafts = await draftAll(client, jobs, 4);

  const updates = [];
  for (let i = 0; i < jobs.length; i++) {
    const draft = drafts[i];
    // A failed call or a fresh "skip" must not blank a comment she can still use.
    if (!draft || draft.error || !draft.comment) {
      console.log(`  row ${jobs[i].rowNumber}: no new draft, keeping the old one`);
      continue;
    }
    console.log(`\nrow ${jobs[i].rowNumber} ${jobs[i].prospect.name}\n  was: ${jobs[i].current}\n  now: ${draft.comment}`);
    updates.push({ range: `${FEED_TAB}!${columnLetter(COL.comment)}${jobs[i].rowNumber}`, values: [[draft.comment]] });
  }

  if (DRY_RUN) { console.log(`\n[dry-run] would write ${updates.length} cell(s)`); return; }
  const written = await writeCells(SHEET_ID, updates);
  console.log(`\nupdated ${written} comment cell(s); no other column or row was touched`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("fatal:", e); process.exit(1); });
}
