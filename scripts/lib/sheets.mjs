// Google Sheets writer. Zero dependencies: a service-account JWT signed with
// node:crypto, exchanged for an access token, then the Sheets REST API.
//
// Auth comes from GOOGLE_SERVICE_ACCOUNT_JSON (the whole key file as a string,
// which is how it goes into a GitHub secret) or GOOGLE_SERVICE_ACCOUNT_FILE.
// The service account must have edit access to the target spreadsheet: it is a
// separate identity, so the sheet has to be shared with its client_email like
// any other collaborator.

import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function credentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) return JSON.parse(inline);
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (path) return JSON.parse(await readFile(path, "utf8"));
  throw new Error("no Google credentials: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE");
}

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiry > Date.now() + 60_000) return cachedToken.value;
  const creds = await credentials();
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claim))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(creds.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(`Google token exchange failed: ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  cachedToken = { value: d.access_token, expiry: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function api(path, init = {}, base = SHEETS) {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Sheets ${init.method ?? "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Deliberately lean: this tab is for copying a comment, not for analysis. The
// engagement numbers, tag, confidence and post excerpt live in the run log and
// the Skipped tab. Post URL must stay in column I, which is what dedupe reads.
export const FEED_HEADERS = [
  "Date added", "Status", "Prospect", "Their title", "Company", "Post URL",
  "Comment draft", "Why bother", "DM draft (send days later)",
  "Why they're on your list", "Profile URL",
];
/** Column holding the post URL on the Feed tab. Dedupe reads it; keep in sync. */
export const FEED_URL_COLUMN = "F";

export const SKIPPED_HEADERS = [
  "Date added", "Prospect", "Company", "Post URL", "Tag", "Why it was skipped", "Post excerpt",
];

export async function getSpreadsheet(spreadsheetId) {
  return api(`/${spreadsheetId}?fields=spreadsheetUrl,sheets.properties`);
}

export async function appendRows(spreadsheetId, sheetName, rows) {
  if (!rows.length) return 0;
  const range = encodeURIComponent(`${sheetName}!A1`);
  const res = await api(
    `/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) },
  );
  return res?.updates?.updatedRows ?? rows.length;
}

/**
 * Creates the tab if it is missing, writes the header row, and formats it on
 * first creation only. Safe to call every run: an existing tab is left alone so
 * column widths and anything typed into Status survive.
 */
export async function ensureTab(spreadsheetId, sheetName, headers, { wrapColumns = [], statusColumn = null } = {}) {
  const meta = await getSpreadsheet(spreadsheetId);
  let tab = meta.sheets?.find((s) => s.properties?.title === sheetName)?.properties;
  let created = false;

  if (!tab) {
    const res = await api(`/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { frozenRowCount: 1, columnCount: Math.max(headers.length, 20) } } } }] }),
    });
    tab = res.replies[0].addSheet.properties;
    created = true;
  }

  const first = await api(`/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A1:A1`)}`);
  if (!first.values?.length) {
    await api(`/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A1`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [headers] }),
    });
  }

  if (created) await formatTab(spreadsheetId, tab.sheetId, headers.length, { wrapColumns, statusColumn });
  return { url: meta.spreadsheetUrl, sheetId: tab.sheetId, created };
}

async function formatTab(spreadsheetId, sheetId, columnCount, { wrapColumns, statusColumn }) {
  const requests = [
    { repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.94, green: 0.91, blue: 0.85 }, verticalAlignment: "MIDDLE" } },
        fields: "userEnteredFormat(textFormat,backgroundColor,verticalAlignment)",
    } },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
    // Every row is one post. Top-aligned so a long comment does not push the
    // rest of the row into the middle of a tall cell.
    { repeatCell: {
        range: { sheetId, startRowIndex: 1 },
        cell: { userEnteredFormat: { verticalAlignment: "TOP" } },
        fields: "userEnteredFormat.verticalAlignment",
    } },
  ];

  for (const { index, width } of wrapColumns) {
    requests.push({ repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: index, endColumnIndex: index + 1 },
      cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
      fields: "userEnteredFormat.wrapStrategy",
    } });
    if (width) requests.push({ updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
      properties: { pixelSize: width }, fields: "pixelSize",
    } });
  }

  if (statusColumn !== null) {
    requests.push({ setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: statusColumn, endColumnIndex: statusColumn + 1 },
      rule: {
        condition: { type: "ONE_OF_LIST", values: ["To do", "Commented", "DM sent", "Replied", "Skip"].map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true, strict: false,
      },
    } });
  }

  await api(`/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
}

/** Post URLs already in the sheet. A second dedupe layer, independent of state/seen.json. */
export async function existingPostUrls(spreadsheetId, sheetName, column) {
  try {
    const res = await api(`/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!${column}2:${column}`)}`);
    return new Set((res.values ?? []).map((r) => String(r[0] ?? "").trim()).filter(Boolean));
  } catch { return new Set(); }
}

/** Raw values from a range, rows only. */
export async function readValues(spreadsheetId, range) {
  const res = await api(`/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return res.values ?? [];
}

/**
 * Writes a set of individually addressed cell ranges and nothing else. Used by
 * redraft.mjs, where touching a neighbouring column would overwrite work.
 */
export async function writeCells(spreadsheetId, updates) {
  if (!updates.length) return 0;
  const res = await api(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
  });
  return res?.totalUpdatedCells ?? updates.length;
}

export async function createSpreadsheet(title) {
  return api("", { method: "POST", body: JSON.stringify({ properties: { title } }) });
}
