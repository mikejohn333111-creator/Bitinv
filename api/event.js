// POST /api/event  — called by the EA (WebRequest) for every signal, trade and heartbeat.
// Header X-Tbot-Secret must equal the TBOT_SECRET environment variable.
import { checkSecret, cleanEvent } from "../lib/validate.js";
import { saveEvent } from "../lib/store.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export async function POST(request) {
  if (!process.env.TBOT_SECRET) return json({ error: "TBOT_SECRET is not set on the server" }, 500);
  if (!checkSecret(request.headers.get("x-tbot-secret"), process.env.TBOT_SECRET))
    return json({ error: "unauthorized" }, 401);

  const text = await request.text();
  if (text.length > 4096) return json({ error: "body too large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const { event, error } = cleanEvent(body);
  if (error) return json({ error }, 400);

  try {
    await saveEvent(event);
  } catch (e) {
    return json({ error: "storage failed", detail: String(e.message || e) }, 502);
  }
  return json({ ok: true });
}
