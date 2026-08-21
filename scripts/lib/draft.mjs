// Turns one scraped post into a drafted comment and a DM angle.
//
// config/voice.md and config/about-me.md are the whole prompt. They are loaded
// once per run and cached at the API, so editing them is how you change the
// output: there is deliberately no voice guidance hardcoded in here.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFile } from "node:fs/promises";

// Two providers, one prompt. The rules live in config/, so switching provider
// changes who writes the comment, never what it is allowed to say.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || process.env.MODEL || "claude-sonnet-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const BANNED = [
  /—/,                                   // em dash, the most recognizable tell there is
  /\bgreat post\b/i, /\bwell said\b/i, /\bspot on\b/i, /\bso true\b/i,
  /couldn'?t agree more/i, /\blove this\b/i, /\bthis is gold\b/i,
  /\bgame[- ]changer\b/i, /let that sink in/i, /here'?s what nobody/i,
  /#\w/,                                 // hashtags
  // Praise openers and the "resonates" family. Smaller models satisfy the
  // literal bans above and then write the same empty comment a new way, so
  // these match the opening rating itself rather than a fixed phrase.
  /\bresonate[sd]?\b/i, /\breally speaks to\b/i,
  /^\s*(wow|kudos|amazing|incredible|fantastic)\b/i,
  /^\s*(this|that|it)('s| is| was)? (is )?(such )?(a |an )?(really |truly |so |very )?(impressive|compelling|powerful|inspiring|insightful|refreshing|fascinating)/i,
  /^\s*i (love|really love|absolutely love|admire) (the|how|your|this)/i,
  /^\s*(what|such) an? (great|powerful|compelling|inspiring)/i,
  /\btruly inspiring\b/i,
  // Trying to be valuable. A comment is not a lesson, a reminder or a takeaway.
  /\b(great|good|powerful|important) reminder\b/i,
  /\bthe (real )?(lesson|takeaway) (here )?is\b/i,
  /\bthis is why\b/i,
  /\bkey to (success|growth|scaling)\b/i,
  // Generic opener ban. Blocking praise phrase by phrase is whack-a-mole: a
  // small model just finds a new adjective. Banning "It's / This is / That's"
  // as the opening words forces the first sentence to start on a concrete noun
  // from the post instead of on a rating of it. "This 327 number..." still passes.
  /^\s*(it|this|that)('s|s| is| was| really is)\b/i,
  /\b(great|good|nice) to see\b/i,
  /\b(so|really|truly|very) (inspiring|impressive|powerful|refreshing)\b/i,
  // Hedging preamble in front of a question. Four words of throat-clearing that
  // no line in voice-samples.md contains.
  /\bi(\x27d| would) love to (hear|know|learn)\b/i,
  /\bi(\x27m| am) curious (about|how|what|to)\b/i,
  /\bwould love to (hear|know)\b/i,
  // A semicolon or a colon is two sentences wearing one sentence's punctuation.
  // Told to write one sentence, a small model reaches for these immediately.
  /[;:]/,
  // Grading their post. "X is impressive" is the same empty move as "great
  // post", moved into the predicate where the opener bans cannot see it.
  /\b(is|are|was|were) (impressive|key|fascinating|profound|crucial|powerful|smart|strong|remarkable|notable|inspiring|brilliant|clever|admirable|refreshing|exciting|amazing)\b/i,
  /\b(inspiring|exciting|refreshing|amazing|great) to see\b/i,
];

// Whose voice this is. Only used to address the model; every actual fact about
// them comes from config/about-me.md.
const OWNER = process.env.YOUR_NAME || "the writer described below";

let cachedSystem = null;

async function systemPrompt() {
  if (cachedSystem) return cachedSystem;
  const [voice, about, samples] = await Promise.all([
    readFile(new URL("../../config/voice.md", import.meta.url), "utf8"),
    readFile(new URL("../../config/about-me.md", import.meta.url), "utf8"),
    readFile(new URL("../../config/voice-samples.md", import.meta.url), "utf8"),
  ]);
  cachedSystem = `You draft LinkedIn comments for ${OWNER}, in their own voice, on posts
written by people they want to build a relationship with before ever pitching them.

Every prospect is on the list for a reason, sometimes given to you as a note.
They do not know they are on a list, and they must never feel watched.

${voice}

---

${samples}

---

${about}

---

# Output

Reply with one JSON object and nothing else. No prose around it, no code fence.

{
  "decision": "comment" | "skip",
  "tag": "build" | "hiring" | "gtm-pain" | "industry-take" | "personal" | "promo" | "other",
  "angle": "one sentence, for the person posting the comment, on why this post is or is not worth engaging",
  "comment": "the comment, ready to paste, or \\"\\" when decision is skip",
  "dm": "the DM to send days later, or \\"\\" when decision is skip",
  "confidence": "high" | "medium" | "low"
}

Return "skip" when the post is a job ad, a pure promo, a reshared link with no
words of their own, a bare congratulations, too short to react to, or when the
only comment available would be generic. Skipping is common and correct.

Set "confidence": "low" when the post is ambiguous or when the comment leans on
an inference about them rather than something they actually wrote. Low-confidence
drafts are flagged for a closer read before they get posted.`;
  return cachedSystem;
}

function userPrompt(prospect, post) {
  const ctx = [
    `Prospect: ${prospect.name || post.authorName || prospect.key}`,
    prospect.title ? `Their title: ${prospect.title}` : "",
    prospect.company ? `Company: ${prospect.company}` : "",
    // Context for the DM, and for judging whether a post is worth a comment at
    // all. It must never surface in the comment itself; voice.md forbids it.
    prospect.note ? `Why they are on the list (never mention this in the comment): ${prospect.note}` : "",
    "",
    `Post type: ${post.postType}. Posted ${post.postedAt || "recently"}. ${post.likes} likes, ${post.comments} comments.`,
    "",
    "Their post, verbatim:",
    '"""',
    post.text || "(no text, media-only post)",
    '"""',
  ].filter(Boolean).join("\n");
  return ctx;
}

/** Models sometimes wrap JSON in prose or a fence despite instructions. */
function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON in response: ${text.slice(0, 120)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

const MAX_COMMENT_CHARS = Number(process.env.MAX_COMMENT_CHARS || 140);

/**
 * Sentences in a comment. Splitting on terminal punctuation *followed by a
 * space* leaves "3.5x" and "$20m." intact, which a naive count of periods
 * would not.
 */
function sentenceCount(text) {
  const clean = String(text || "").replace(/https?:\/\/\S+/g, "").trim();
  if (!clean) return 0;
  return clean.split(/(?<=[.!?])\s+/).filter((part) => /\w/.test(part)).length;
}

/**
 * Em dashes, semicolons and colons never reach the sheet. The retry loop fixes
 * most of them; this is the guarantee for the ones that survive it. Each becomes
 * a comma rather than a period, because a period would split the comment into
 * the two sentences it is not allowed to be.
 */
export function sanitize(text) {
  return String(text || "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*[;:]\s*/g, ", ")
    .replace(/\s*,\s*,+/g, ",")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Every reason this draft cannot be posted as-is, phrased for the retry prompt. */
/**
 * Models emit typographic apostrophes, so /it's/ never matched "It\u2019s" and
 * every opener ban silently passed. Matching happens on a normalised copy; the
 * draft itself keeps its real punctuation.
 */
const normalize = (s) => String(s || "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

function violations(draft) {
  const raw = draft.comment ?? "";
  const reasons = [];
  // Name the offending words. "It uses a banned construction" leaves the model
  // guessing, and it guesses wrong: three retries in a row came back with the
  // same phrase still in place.
  const both = `${normalize(raw)}\n${normalize(draft.dm)}`;
  const hits = BANNED.map((re) => both.match(re)?.[0]?.trim()).filter(Boolean);
  if (hits.length) reasons.push(`it contains ${hits.map((h) => `"${h}"`).join(" and ")}, which are banned`);
  if (/[—–;:]/.test(raw)) reasons.push("it contains an em dash, semicolon or colon, none of which are ever allowed. Write one plain sentence");
  const sentences = sentenceCount(raw);
  if (sentences > 1) reasons.push(`the comment is ${sentences} sentences and must be exactly one`);
  if (raw.length > MAX_COMMENT_CHARS) reasons.push(`the comment is ${raw.length} characters, over the ${MAX_COMMENT_CHARS} limit`);
  return reasons;
}

/**
 * Picks a provider from whichever key is present; DRAFT_PROVIDER forces one.
 * Returns null when neither is set, which the caller treats as "no drafts".
 */
export function makeClient() {
  const forced = (process.env.DRAFT_PROVIDER || "").toLowerCase();
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const provider = forced || (hasOpenAI ? "openai" : hasAnthropic ? "anthropic" : "");

  if (provider === "openai" && hasOpenAI) return { provider, model: OPENAI_MODEL, openai: new OpenAI() };
  if (provider === "anthropic" && hasAnthropic) return { provider, model: ANTHROPIC_MODEL, anthropic: new Anthropic() };
  return null;
}

/** One completion, provider-agnostic. Returns raw text, or null if the model declined. */
async function complete(bundle, system, messages) {
  if (bundle.provider === "anthropic") {
    const response = await bundle.anthropic.messages.create({
      model: bundle.model,
      max_tokens: 4000,
      output_config: { effort: "medium" },
      // Identical for every post in a run, so caching it turns ~1,800 tokens
      // per call into a cache read.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    });
    if (response.stop_reason === "refusal") return null;
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  const response = await bundle.openai.chat.completions.create({
    model: bundle.model,
    // Reasoning models bill thinking against this ceiling, so it is not the
    // length of the comment. Too small and the content comes back empty.
    max_completion_tokens: 4000,
    // The system prompt already specifies the object, and json_object mode
    // removes the fenced-code and preamble failure modes entirely.
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, ...messages],
  });
  const choice = response.choices[0];
  if (choice?.finish_reason === "content_filter") return null;
  return choice?.message?.content ?? "";
}

function isRetryable(e) {
  const status = e?.status ?? e?.response?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

export async function draftFor(client, prospect, post) {
  const system = await systemPrompt();
  const messages = [{ role: "user", content: userPrompt(prospect, post) }];

  for (let attempt = 0; attempt < 3; attempt++) {
    let text;
    try {
      text = await complete(client, system, messages);
    } catch (e) {
      if (isRetryable(e)) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      throw e;
    }

    if (text === null) return { decision: "skip", tag: "other", angle: "model declined to draft this one", comment: "", dm: "", confidence: "low" };

    let draft;
    try {
      draft = parseJson(text);
    } catch {
      messages.push({ role: "assistant", content: text }, { role: "user", content: "That was not parseable JSON. Reply with the JSON object only." });
      continue;
    }

    if (draft.decision !== "comment") return { ...draft, decision: "skip" };

    const bad = violations(draft);
    if (bad.length && attempt < 2) {
      // One correction pass. Small models routinely return three sentences on the
      // first try, and the em dash slips through often enough to be worth the
      // extra call: it is the first thing a reader notices.
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: `That draft is not usable: ${bad.join("; ")}. Rewrite it. One sentence for the comment, under ${MAX_COMMENT_CHARS} characters, opening on something concrete from their post. JSON only.` },
      );
      continue;
    }
    // Last line of defence, after every retry is spent.
    const comment = sanitize(draft.comment);
    const dm = sanitize(draft.dm);
    const repaired = comment !== String(draft.comment ?? "").trim() || dm !== String(draft.dm ?? "").trim();
    return { ...draft, comment, dm, needsEdit: bad.length > 0 || repaired, violations: bad, repaired };
  }
  return null;
}

/** Small concurrency pool: the API is fine with more, the rate limit is not. */
export async function draftAll(client, jobs, concurrency = 4, onEach = () => {}) {
  const out = new Array(jobs.length);
  let idx = 0;
  // An exhausted credit balance or a bad key fails identically on every post.
  // Stop after the first one rather than burning 60 calls to learn it 60 times.
  let fatal = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (idx < jobs.length) {
      const i = idx++;
      const { prospect, post } = jobs[i];
      if (fatal) {
        out[i] = { decision: "skip", tag: "other", angle: `not attempted: ${fatal}`, comment: "", dm: "", confidence: "low", error: true };
        continue;
      }
      try {
        out[i] = await draftFor(client, prospect, post);
      } catch (e) {
        if (/credit balance|authentication|invalid x-api-key|permission/i.test(e.message)) fatal = e.message.slice(0, 200);
        out[i] = { decision: "skip", tag: "other", angle: `draft failed: ${e.message}`, comment: "", dm: "", confidence: "low", error: true };
      }
      onEach(out[i], i);
    }
  }));
  return out;
}
