// npm run setup -- asks for what the tool needs and writes .env for you.
//
// Nothing here is magic: it writes the same .env you could write by hand from
// .env.example. It exists so a first run needs no reading.
//
//   npm run setup          # ask, then check
//   npm run check          # check what is already configured, ask nothing

import { readFile, writeFile, access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROOT = new URL("../", import.meta.url);
const ENV_PATH = new URL(".env", ROOT);
const CSV_PATH = new URL("config/prospects.csv", ROOT);
const CSV_EXAMPLE = new URL("config/prospects.example.csv", ROOT);
const ABOUT_PATH = new URL("config/about-me.md", ROOT);
const SAMPLES_PATH = new URL("config/voice-samples.md", ROOT);

const CHECK_ONLY = process.argv.includes("--check");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const exists = async (url) => access(url).then(() => true).catch(() => false);

/** Existing .env values, so re-running setup keeps what you already answered. */
async function readEnvFile() {
  const out = {};
  try {
    const text = await readFile(ENV_PATH, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env yet */ }
  return out;
}

/** Values with whitespace or a quote in them break a naive .env. Quote those. */
function envLine(key, value) {
  const v = String(value ?? "");
  if (!v) return `${key}=`;
  return /[\s"'#]/.test(v) ? `${key}="${v.replace(/"/g, '\\"')}"` : `${key}=${v}`;
}

/** Long secrets are echoed back trimmed, so a shared screen does not leak one. */
const mask = (v) => (v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v);

async function askAll(current) {
  const rl = createInterface({ input: stdin, output: stdout });
  // An async iterator rather than rl.question(): piped stdin emits every line
  // at once, and the questions asked after the first await would miss them all.
  // Iterating pauses the stream between reads, so a pipe behaves like a person.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question, fallback = "") => {
    const shown = fallback ? ` ${dim(`[${mask(fallback)}]`)}` : "";
    stdout.write(`${question}${shown}\n> `);
    const { value, done } = await lines.next();
    if (done) { stdout.write("\n"); return fallback; }  // stdin closed, keep the default
    return String(value).trim() || fallback;
  };

  const answers = { ...current };

  console.log(`\n${bold("1. Who is writing the comments?")}`);
  console.log(dim("   Your name. Only used to address the model. Every fact about you comes from config/about-me.md."));
  answers.YOUR_NAME = await ask("Your name", current.YOUR_NAME || "");

  console.log(`\n${bold("2. Apify")} ${dim("(required, this is what reads the posts)")}`);
  console.log(dim("   Sign up at https://console.apify.com, then Settings -> API & Integrations -> Personal API token."));
  console.log(dim("   The free tier includes $5/month of credit, which covers a few thousand profile reads."));
  answers.APIFY_API_KEY = await ask("Apify API token", current.APIFY_API_KEY || "");

  console.log(`\n${bold("3. The model that writes the drafts")} ${dim("(required, pick one)")}`);
  console.log(dim("   a) Anthropic (Claude)  -> https://console.anthropic.com/settings/keys"));
  console.log(dim("   b) OpenAI (GPT)        -> https://platform.openai.com/api-keys"));
  const provider = (await ask("Type a or b", current.OPENAI_API_KEY && !current.ANTHROPIC_API_KEY ? "b" : "a")).toLowerCase();
  if (provider.startsWith("b")) {
    answers.OPENAI_API_KEY = await ask("OpenAI API key", current.OPENAI_API_KEY || "");
    answers.ANTHROPIC_API_KEY = current.ANTHROPIC_API_KEY || "";
  } else {
    answers.ANTHROPIC_API_KEY = await ask("Anthropic API key", current.ANTHROPIC_API_KEY || "");
    answers.OPENAI_API_KEY = current.OPENAI_API_KEY || "";
  }

  console.log(`\n${bold("4. Google Sheet")} ${dim("(optional, press enter to skip)")}`);
  console.log(dim("   Skip this and the day's drafts land in output/digest-<date>.md instead."));
  console.log(dim("   The sheet is nicer: it has a Status column you tick off as you comment."));
  console.log(dim('   Setup is in the README under "Put the drafts in a Google Sheet".'));
  answers.SHEET_ID = await ask("Spreadsheet ID (the long string in its URL)", current.SHEET_ID || "");
  if (answers.SHEET_ID) {
    console.log(dim("   Path to the service account JSON file you downloaded from Google Cloud."));
    answers.GOOGLE_SERVICE_ACCOUNT_FILE = await ask("Path to service-account.json", current.GOOGLE_SERVICE_ACCOUNT_FILE || "");
  }

  console.log(`\n${bold("5. Slack ping")} ${dim("(optional, press enter to skip)")}`);
  answers.SLACK_BOT_TOKEN = await ask("Slack bot token (xoxb-...)", current.SLACK_BOT_TOKEN || "");
  if (answers.SLACK_BOT_TOKEN) answers.SLACK_CHANNEL = await ask("Slack channel ID", current.SLACK_CHANNEL || "");

  rl.close();
  return answers;
}

const KEYS = [
  "YOUR_NAME", "APIFY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_FILE", "SLACK_BOT_TOKEN", "SLACK_CHANNEL",
];

async function writeEnv(answers) {
  const body = [
    "# Written by npm run setup. Safe to edit by hand.",
    "# Never commit this file. .gitignore already excludes it.",
    "",
    ...KEYS.map((k) => envLine(k, answers[k])),
    "",
    "# Optional knobs, see .env.example for the full list.",
    "# MAX_POSTS_PER_PROFILE=3",
    "# MAX_DRAFTS=60",
    "# MAX_COMMENT_CHARS=140",
    "# TIMEZONE=America/New_York",
    "",
  ].join("\n");
  await writeFile(ENV_PATH, body);
}

async function verifyApify(token) {
  if (!token) return { ok: false, note: "not set" };
  try {
    const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20000) });
    if (r.status === 401 || r.status === 403) return { ok: false, note: "rejected, check the token" };
    if (!r.ok) return { ok: false, note: `Apify returned ${r.status}` };
    const d = await r.json();
    return { ok: true, note: `signed in as ${d?.data?.username ?? "your account"}` };
  } catch (e) {
    return { ok: false, note: `could not reach Apify (${e.message.slice(0, 60)})` };
  }
}

async function countProspects() {
  try {
    const { loadProspects } = await import("./lib/prospects.mjs");
    const { prospects } = await loadProspects();
    return { ok: true, note: `${prospects.length} ${prospects.length === 1 ? "person" : "people"}` };
  } catch (e) {
    // First sentence only. Splitting on ". " keeps "prospects.csv" intact.
    return { ok: false, note: e.message.split(". ")[0] };
  }
}

async function stillATemplate(url, marker) {
  try { return (await readFile(url, "utf8")).includes(marker); } catch { return true; }
}

async function report(env) {
  console.log(`\n${bold("Checking your setup")}\n`);
  const line = (ok, label, note) => console.log(`  ${ok ? green("ok  ") : red("todo")}  ${label.padEnd(28)} ${dim(note)}`);

  const apify = await verifyApify(env.APIFY_API_KEY);
  line(apify.ok, "Apify token", apify.note);

  const hasModel = !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
  line(hasModel, "Drafting key", hasModel ? (env.ANTHROPIC_API_KEY ? "Anthropic" : "OpenAI") : "set ANTHROPIC_API_KEY or OPENAI_API_KEY");

  const people = await countProspects();
  line(people.ok, "config/prospects.csv", people.note);

  const aboutTemplate = await stillATemplate(ABOUT_PATH, "Replace everything below with your own facts");
  line(!aboutTemplate, "config/about-me.md", aboutTemplate ? "still the template, drafts stay vague until you fill it in" : "filled in");

  const samplesTemplate = await stillATemplate(SAMPLES_PATH, "Replace the sample lines below");
  line(!samplesTemplate, "config/voice-samples.md", samplesTemplate ? "still the template, drafts will not sound like you yet" : "filled in");

  line(true, "Google Sheet", env.SHEET_ID ? "configured" : "not configured, drafts go to output/ instead");
  line(true, "Slack ping", env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL ? "configured" : "not configured, optional");

  const blocking = !apify.ok || !hasModel || !people.ok;
  console.log("");
  if (blocking) {
    console.log(yellow("Fix the todo lines above, then run npm run check again."));
  } else {
    console.log(`${green("Ready.")} Try a small run first:\n`);
    console.log(`  npm run dry          ${dim("# 5 people, writes nothing anywhere, prints what it would do")}`);
    console.log(`  npm start            ${dim("# the real thing")}\n`);
  }
  return !blocking;
}

async function main() {
  const current = await readEnvFile();

  if (!CHECK_ONLY) {
    console.log(bold("\nLinkedIn Prospect Engager setup\n"));
    console.log("Press enter to keep an existing answer, or to skip an optional one.");
    const answers = await askAll(current);
    await writeEnv(answers);
    console.log(`\n${green("Wrote .env")}`);

    if (!(await exists(CSV_PATH))) {
      await writeFile(CSV_PATH, await readFile(CSV_EXAMPLE, "utf8"));
      console.log(`${green("Created config/prospects.csv")} ${dim("from the example. Put your people in it, one per row.")}`);
    }
    Object.assign(current, answers);
  }

  // .env is not loaded into this process, so the check reads what was just
  // written rather than process.env.
  const ok = await report(current);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("setup failed:", e.message || e); process.exit(1); });
