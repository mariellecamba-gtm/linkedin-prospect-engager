// The list of people you are tracking, read from config/prospects.csv.
//
// One row per person. The only column that matters is the LinkedIn profile URL;
// everything else is context handed to the drafting model so the comment can be
// specific. A CSV is deliberate: you can paste one straight out of a Google
// Sheet, a CRM export or a Clay table without touching any code.

import { readFile } from "node:fs/promises";

const CSV_PATH = new URL("../../config/prospects.csv", import.meta.url);

/** Profile URLs vary by trailing slash, casing and tracking params. Key on the handle. */
export function profileKey(url) {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

/**
 * A small RFC-4180 CSV reader. Quoted fields, embedded commas, doubled quotes
 * and \r\n line endings all show up in real spreadsheet exports, so none of them
 * can be handled by a split(",").
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// Header names people actually type. Matched loosely so "Profile URL",
// "linkedin_url" and "LinkedIn" all land in the same place.
const ALIASES = {
  profileUrl: ["profileurl", "profile url", "linkedinurl", "linkedin url", "linkedin", "url", "profile"],
  name: ["name", "full name", "fullname", "prospect", "person"],
  title: ["title", "job title", "role", "position", "headline"],
  company: ["company", "organisation", "organization", "account"],
  note: ["note", "notes", "why", "why them", "context", "reason"],
};

function columnMap(headerRow) {
  const map = {};
  headerRow.forEach((raw, i) => {
    const h = String(raw).trim().toLowerCase().replace(/^﻿/, "");
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(h) && map[field] === undefined) map[field] = i;
    }
  });
  return map;
}

/**
 * @returns {Promise<{prospects: object[], skipped: number}>}
 */
export async function loadProspects() {
  let text;
  try {
    text = await readFile(CSV_PATH, "utf8");
  } catch {
    throw new Error(
      "config/prospects.csv is missing. Copy config/prospects.example.csv to config/prospects.csv and put your people in it (or run: npm run setup).",
    );
  }

  const rows = parseCsv(text);
  if (!rows.length) throw new Error("config/prospects.csv is empty. Add one row per person you want to track.");

  const map = columnMap(rows[0]);
  if (map.profileUrl === undefined) {
    throw new Error(
      `config/prospects.csv has no LinkedIn URL column. The header row needs one named "profileUrl" (found: ${rows[0].join(", ")}).`,
    );
  }

  const cell = (row, field) => String(row[map[field]] ?? "").trim();
  const byKey = new Map();
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const profileUrl = cell(row, "profileUrl");
    const key = profileKey(profileUrl);
    // A row without a usable /in/ URL cannot be scraped. Counted, not fatal:
    // one bad paste should not stop the other 400 people.
    if (!key || key === "example" || key === "example-person") { skipped++; continue; }
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      profileUrl,
      name: cell(row, "name"),
      title: cell(row, "title"),
      company: cell(row, "company"),
      note: cell(row, "note"),
    });
  }

  if (!byKey.size) {
    throw new Error("config/prospects.csv has a header but no usable rows. Each row needs a linkedin.com/in/... URL.");
  }

  return { prospects: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)), skipped };
}
