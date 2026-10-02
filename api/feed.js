// GET /api/feed  — read by the dashboard. If TBOT_VIEW_KEY is set, the page must
// pass it as ?key=... (the dashboard remembers it after the first visit).
import { checkSecret } from "../lib/validate.js";
import { loadFeed, storageKind } from "../lib/store.js";

export async function GET(request) {
  const viewKey = process.env.TBOT_VIEW_KEY;
  const given = new URL(request.url).searchParams.get("key");
  if (viewKey && !checkSecret(given, viewKey))
    return new Response(JSON.stringify({ error: "view key required" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  try {
    const feed = await loadFeed(150);
    return new Response(JSON.stringify({ ...feed, storage: storageKind(), now: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "storage failed", detail: String(e.message || e) }), {
      status: 502, headers: { "Content-Type": "application/json" },
    });
  }
}
