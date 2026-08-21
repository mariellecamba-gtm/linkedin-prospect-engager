// Renders the day's feed as one markdown document: every post worth engaging,
// with the comment ready to copy, in the order you should work them.
//
// The same text is written to output/ as a file and, optionally, opened as a
// GitHub issue. The size limits below are GitHub's.

const MAX_BODY = 60_000; // GitHub's hard limit is 65,536 characters per body.

const fence = (s) => "```\n" + String(s).replace(/```/g, "``​`") + "\n```";

function excerpt(text, limit = 700) {
  const clean = String(text || "").trim();
  if (!clean) return "_(media-only post, no text)_";
  const cut = clean.length > limit ? clean.slice(0, limit).trimEnd() + "..." : clean;
  return cut.split("\n").map((l) => `> ${l}`).join("\n");
}

function section({ prospect, post, draft }, index) {
  const who = prospect.name || post.authorName || prospect.key;
  const lines = [];
  lines.push(`### ${index}. [${who}](${prospect.profileUrl})${prospect.title ? ` — ${prospect.title}` : ""}`);

  const meta = [];
  if (prospect.company) meta.push(prospect.company);
  if (prospect.note) meta.push(`on your list because: ${prospect.note}`);
  if (meta.length) lines.push(meta.join(" · "));

  const stats = [`[the post](${post.postUrl})`];
  if (post.postedAt) stats.push(String(post.postedAt).slice(0, 16).replace("T", " "));
  stats.push(`${post.likes} likes, ${post.comments} comments`);
  stats.push(`\`${draft.tag ?? post.postType}\``);
  if (draft.confidence && draft.confidence !== "high") stats.push(`confidence: ${draft.confidence}`);
  if (draft.needsEdit) stats.push("**needs an edit before posting**");
  lines.push(stats.join(" · "));
  lines.push("");
  lines.push(excerpt(post.text));
  lines.push("");
  if (draft.angle) lines.push(`**Why bother:** ${draft.angle}`);
  lines.push("");
  lines.push("**Comment**");
  lines.push(fence(draft.comment));
  if (draft.dm) {
    lines.push("<details><summary>DM angle, for a few days after the comment lands</summary>");
    lines.push("");
    lines.push(fence(draft.dm));
    lines.push("</details>");
  }
  lines.push("");
  return lines.join("\n");
}

function skippedTable(skipped) {
  if (!skipped.length) return "";
  const rows = skipped.slice(0, 60).map(({ prospect, post, draft }) => {
    const who = prospect.name || post.authorName || prospect.key;
    const reason = String(draft?.angle || "no reason recorded").replace(/\|/g, "/").slice(0, 120);
    return `| [${who}](${post.postUrl}) | ${draft?.tag ?? "-"} | ${reason} |`;
  });
  const more = skipped.length > rows.length ? `\n\n_${skipped.length - rows.length} more not listed._` : "";
  return [
    "<details><summary>" + `Skipped (${skipped.length}) — posted, but not worth a comment` + "</summary>",
    "",
    "| Who | Tag | Why skipped |",
    "| --- | --- | --- |",
    ...rows,
    more,
    "</details>",
  ].join("\n");
}

/**
 * @returns {{title: string, body: string, overflow: string[]}} overflow goes in
 * issue comments: a busy day can exceed one issue body.
 */
export function renderDigest({ engage, skipped, stats, date }) {
  const header = [
    `**${engage.length} post${engage.length === 1 ? "" : "s"} to engage** out of ${stats.postsFound} found across ${stats.prospectsTracked} tracked prospects.`,
    "",
    `<sub>window: ${stats.postedLimit} · profiles scraped: ${stats.profilesScraped} · drafted: ${stats.drafted} · skipped: ${skipped.length}${stats.draftErrors ? ` · draft errors: ${stats.draftErrors}` : ""}${stats.capped ? ` · capped: ${stats.capped} not drafted` : ""}</sub>`,
    "",
    engage.length ? "Work them top down. Comment first, DM days later, never both at once." : "_Nothing worth commenting on today._",
    "",
    "---",
    "",
  ].join("\n");

  const sections = engage.map((item, i) => section(item, i + 1));
  const footer = "\n" + skippedTable(skipped) + "\n";

  let body = header;
  const overflow = [];
  let spill = "";
  for (const s of sections) {
    const target = overflow.length === 0 && body.length + s.length < MAX_BODY - footer.length ? "body" : "spill";
    if (target === "body") { body += s + "\n"; continue; }
    if (spill.length + s.length > MAX_BODY) { overflow.push(spill); spill = ""; }
    spill += s + "\n";
  }
  if (spill) overflow.push(spill);
  body += footer;
  if (overflow.length) body += `\n_${overflow.length} more batch(es) of posts are in the comments below._\n`;

  return { title: `Prospect posts — ${date} (${engage.length} to engage)`, body, overflow };
}
