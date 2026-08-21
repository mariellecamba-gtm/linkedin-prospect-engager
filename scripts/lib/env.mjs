// Loads .env into process.env. Imported first by every entry point.
//
// A dependency-free dotenv: Node does have --env-file, but it hard-errors when
// the file is missing, and in GitHub Actions there is no .env at all because the
// secrets arrive as real environment variables. This just skips quietly.
//
// Anything already set in the real environment wins, so Actions secrets are
// never overwritten by a stray committed file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

let text = "";
try { text = readFileSync(ENV_PATH, "utf8"); } catch { /* no .env, fine */ }

for (const raw of text.split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  if (process.env[key] !== undefined) continue;

  let value = line.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  process.env[key] = value;
}
