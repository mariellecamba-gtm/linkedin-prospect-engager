# LinkedIn Prospect Engager

Give it a list of people you want to know. Every morning it reads what they
posted on LinkedIn yesterday, throws out the posts not worth reacting to, and
hands you one short, honest comment for each of the rest, ready to paste.

You paste it. It never posts anything for you.

The point is to be a familiar name in someone's comments long before you ever
pitch them. Comments do that. Generic comments do the opposite, which is why
most of this repo is not code, it is the [rules](config/voice.md) for writing a
comment that does not read as generated.

**A day's output looks like this:**

| Prospect | Post | Comment draft |
| --- | --- | --- |
| Dana Reyes, Head of RevOps | *"we killed our lead scoring model this week..."* | killing the scoring model before replacing it takes more nerve than the rebuild |
| Sam Okafor, VP Sales | *"day 4 of the offsite and my voice is gone"* | day 4 voice is a real measure of an offsite |

---

## What you need

Three things, two of which cost money in small amounts:

| | What for | Cost |
| --- | --- | --- |
| **Node 20+** | running it | free, [nodejs.org](https://nodejs.org) |
| **An Apify account** | reading the posts | free tier is $5/month of credit, enough for a few thousand profile reads |
| **An Anthropic or OpenAI key** | writing the drafts | pennies per run, see [What it costs](#what-it-costs) |

Optional extras, all skippable: a Google Sheet to work out of, a Slack ping, and
GitHub Actions to run the whole thing on a schedule so you never touch a
terminal again.

---

## Quick start

```bash
git clone https://github.com/mariellecamba-gtm/linkedin-prospect-engager.git
cd linkedin-prospect-engager
npm install
npm run setup
```

`npm run setup` asks for each key one at a time, tells you where to get it,
writes your `.env`, and then checks that everything works. Nothing else to
configure by hand.

Then do these three things, in this order. The third one is what separates a
useful comment from an embarrassing one.

### 1. Put your people in `config/prospects.csv`

One row each. The LinkedIn URL is the only column that has to be filled in.

```csv
name,profileUrl,title,company,note
Dana Reyes,https://www.linkedin.com/in/danareyes,Head of RevOps,Northwind,she runs the team we'd sell into
Sam Okafor,https://www.linkedin.com/in/sokafor,VP Sales,Acme,met at SaaStr, never followed up
```

`note` is why they are on your list. It shapes the DM and it helps the model
decide what is worth a comment. **It never appears in the comment itself** —
telling someone you noticed their funding round or their job posting in public
reads as surveillance.

Any CSV a spreadsheet exports will work: 10 people or 500, header names like
`LinkedIn URL` or `full name` are matched too.

### 2. Fill in `config/about-me.md`

This is the only set of facts a comment is allowed to claim about you. Your role,
the tools you actually use, two or three opinions you would say out loud. If it
is not in this file and not in their post, the draft cannot say it.

Spend ten minutes here. It is the difference between "great point about pipeline
hygiene" and a comment that names the thing you also broke last quarter.

### 3. Fill in `config/voice-samples.md`

Paste 15 to 40 lines you have actually written. Not your best ones, your normal
ones. Rules describe a voice, samples *are* one, and when a draft disagrees with
a rule but sounds like your samples, the samples win.

### Then run it

```bash
npm run dry     # 5 people, writes nothing anywhere, prints what it would do
npm start       # the real thing
```

Every run writes `output/digest-<date>.md`: each post worth engaging, the comment
under it, in the order to work them. Open it, read each comment, change what you
would say differently, paste.

---

## Make the comments sound like you

Four files control the output. All four are plain markdown loaded straight into
the prompt, so editing one changes every comment from the next run onward. There
is no voice guidance hidden in the code.

| File | What it controls |
| --- | --- |
| [`config/about-me.md`](config/about-me.md) | every fact a comment may claim about you |
| [`config/voice-samples.md`](config/voice-samples.md) | how your sentences actually sound |
| [`config/voice.md`](config/voice.md) | the craft rules: what is banned, what a good comment does |
| [`config/prospects.csv`](config/prospects.example.csv) | who is watched, and why each of them is on the list |

`voice.md` ships with strong opinions already in it, and they are the reason the
output does not read as AI. The short version:

- **One sentence.** 8 to 16 words, 140 characters hard maximum. A single sentence
  has no room for a compliment, a summary and a question, so it forces the one
  thing worth saying.
- **No em dashes, semicolons or colons.** The most recognizable tell there is.
  Enforced in code, not just asked for.
- **No praise openers.** "Love this", "so true", "this really resonates", and
  every longer coat the same move wears. A comment that opens by rating their
  post is a comment with nothing in it.
- **Do not add value.** No lessons, no frameworks, no explaining their post back
  to them. You are trying to be a person in their comments, not an expert in
  their comments.
- **Statements, not questions.** A curious question at the end is what every AI
  drafting tool produces. Roughly one comment in twenty should have one.
- **Skipping is normal.** Around a third of posts get no comment, and the tool
  says why in the Skipped list. A job ad, a pure promo or a bare congratulations
  gets nothing.

The comment goes through a rewrite loop when it breaks a rule, and anything that
survives the loop is flagged `⚠ read this one before posting` so you know which
drafts to look at hardest.

Changed `voice.md` and want yesterday's backlog rewritten in the new voice
instead of waiting for tomorrow? `npm run redraft` (Google Sheet only, and it
only touches rows still marked To do).

---

## Run it every morning without touching a terminal

The repo includes a GitHub Action that does the whole run on GitHub's machines.
On a public repo this is free.

1. Click **Use this template → Create a new repository** at the top of this page,
   or push your clone to a repo of your own. **If your prospect list is sensitive,
   make it private** — the CSV gets committed.
2. In your repo: **Settings → Secrets and variables → Actions → New repository
   secret**, and add `APIFY_API_KEY` plus one of `ANTHROPIC_API_KEY` or
   `OPENAI_API_KEY`. Add `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`,
   `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` too if you use them.
3. On the **Variables** tab of the same page, add `YOUR_NAME`.
4. Commit your filled-in `config/` files.
5. Open the **Actions** tab and enable workflows if GitHub asks. Then
   **LinkedIn Prospect Engager → Run workflow** to try it once. It runs daily at
   14:00 UTC after that. Change the `cron` line in
   [`.github/workflows/daily.yml`](.github/workflows/daily.yml) to move it.

The schedule is switched off on this template repo, so your copy is the only one
that will ever run.

With no Google Sheet configured, the Action opens a GitHub issue per day with the
whole digest in it. GitHub emails you the issue, which turns out to be a fine way
to read it on a phone.

---

## Put the drafts in a Google Sheet

Optional, and worth it if you work the list daily: the sheet has a Status column
you tick off, and a second tab showing every post that was skipped and why.

1. Create a new Google Sheet. Copy the long ID out of its URL:
   `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
2. Go to [console.cloud.google.com](https://console.cloud.google.com), create a
   project, enable the **Google Sheets API**, then **Create credentials →
   Service account**. Give it any name.
3. Open the service account → **Keys → Add key → JSON**. A file downloads.
4. Open that file and copy the `client_email` address out of it. Share your sheet
   with that address as an **Editor**, exactly like sharing with a colleague. The
   service account is a separate identity and cannot see the sheet otherwise.
5. Put the sheet ID and the path to that JSON file in `.env` (or re-run
   `npm run setup`). In GitHub Actions, paste the file's entire contents into a
   secret called `GOOGLE_SERVICE_ACCOUNT_JSON`.

The tabs and their formatting are created on the first run. Column widths and
anything you type into Status survive every run after that.

---

## What it costs

Per run, for a list of 100 people:

- **Apify:** roughly $0.05 to $0.15 to read 100 profiles. The free $5/month
  covers a daily run of that size with room left over.
- **Model:** on a normal day maybe 10 of those 100 people posted, so 10 drafts.
  With Claude Sonnet that is a few cents. With `gpt-4o-mini` it is a fraction of
  one. The shared instructions are cached, so the second draft in a run is
  cheaper than the first.
- **GitHub Actions:** free on a public repo.

`MAX_DRAFTS` in `.env` is your hard ceiling on model calls per run. It defaults
to 60.

---

## How it works

```
config/prospects.csv
        |
        v
   Apify  ──  their posts from yesterday, reposts excluded
        |
        v
   dedupe  ──  anything already drafted is dropped (state/seen.json + the sheet)
        |
        v
   Claude / GPT  ──  comment? or skip?  ──  rewrite loop if it breaks a rule
        |
        v
   output/digest-<date>.md   +  Google Sheet  +  GitHub issue  +  Slack ping
```

A few decisions worth knowing about:

- **Reposts are excluded, quote posts are kept.** A repost has none of their own
  words in it, so there is nothing honest to react to.
- **Nothing is drafted twice.** Two independent dedupe layers, because
  `state/seen.json` can be lost to a fresh clone and a duplicate row means
  commenting on the same post twice.
- **A failed draft costs a retry, not the post.** An expired key or an empty
  credit balance leaves those posts unrecorded so tomorrow picks them up again.
- **The window is a calendar day, not a rolling 24 hours.** A rolling window read
  at 10am starts at 10am yesterday and silently loses everyone's morning.

---

## Configuration

Everything below goes in `.env`. Only the first three matter.

| Variable | Default | What it does |
| --- | --- | --- |
| `APIFY_API_KEY` | — | required, reads the posts |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | required, one of them, writes the drafts |
| `YOUR_NAME` | — | how the prompt addresses you |
| `SHEET_ID` | — | Google Sheet to append to |
| `GOOGLE_SERVICE_ACCOUNT_FILE` / `_JSON` | — | path to, or contents of, the service account key |
| `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` | — | one-line ping when the drafts are ready |
| `PUBLISH_ISSUE` | auto | `1` always opens a GitHub issue, `0` never does |
| `TIMEZONE` | `America/New_York` | which calendar day "yesterday" means |
| `MAX_POSTS_PER_PROFILE` | `3` | newest N posts per person per run |
| `MAX_DRAFTS` | `60` | cap on model calls per run |
| `MAX_COMMENT_CHARS` | `140` | hard length limit on a comment |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | try `claude-opus-5` for better drafts at more cost |
| `OPENAI_MODEL` | `gpt-4o-mini` | |
| `DRAFT_PROVIDER` | auto | `anthropic` or `openai` when both keys are set |
| `LOOKBACK_DAYS` | `1` | yesterday and today so far |
| `POSTED_LIMIT` | — | backfill only: `week`, `month` |
| `DRY_RUN` | — | `1` writes nothing anywhere |

Command-line flags override the file: `--dry-run`, `--limit=N`,
`--lookback-days=N`, `--posted-limit=week`.

---

## When something breaks

Run `npm run check` first. It tells you which key is missing or rejected, how
many people it can read out of your CSV, and whether the two voice files are
still templates.

| Symptom | Cause |
| --- | --- |
| `config/prospects.csv is missing` | copy `config/prospects.example.csv` over it, or run `npm run setup` |
| `Apify auth failed` | wrong token, or you copied the actor key instead of the personal API token |
| `Apify usage limit reached` | the monthly free credit ran out, raise the cap or wait for the reset |
| `No drafting key set` | neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is in `.env` |
| `nothing new today` | genuinely nobody on your list posted, or you already drafted everything they posted |
| Every comment reads generic | `config/about-me.md` is still the template |
| The comments do not sound like you | `config/voice-samples.md` is still the template |
| `Sheets ... -> 403` | the sheet is not shared with the service account's `client_email` |

---

## Before you use it on real people

- **Read every draft before you post it.** The tool is deliberately incapable of
  posting for you. A comment in your name is your reputation, not the model's.
- **It can be wrong about you.** If a comment claims something you have not done,
  the fix is in `config/about-me.md`, and it will keep being wrong until you make
  it.
- **Do not send a DM the same day as the comment.** The DM field is written for a
  few days later, deliberately.
- **Scraping has terms attached.** You are reading public posts through Apify.
  Read [Apify's terms](https://apify.com/terms-of-use) and LinkedIn's, and stay
  inside what you are comfortable defending.
- **If it feels like surveillance to the person receiving it, it is.** That is why the
  reason they are on your list never reaches the comment.

MIT licensed. Fork it, change the rules, make it yours.
