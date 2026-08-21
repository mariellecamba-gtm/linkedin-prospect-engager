// Optional. A one-line ping so the digest gets read on the day it is useful.
// Silently does nothing unless both SLACK_BOT_TOKEN and SLACK_CHANNEL are set.

export async function ping(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  if (!token || !channel) return "slack: not configured";
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    return d.ok ? "slack: sent" : `slack: ${d.error}`;
  } catch (e) {
    return `slack: ${e.message}`;
  }
}
