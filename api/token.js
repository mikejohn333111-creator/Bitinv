// POST /api/token  — swaps a Deriv OAuth code (or refresh token) for an access token.
// Deriv's docs ask for this exchange to happen on a server rather than in the
// browser, so the page sends its OAuth form here and this forwards it to Deriv.
// Only the standard OAuth fields are passed on, only to Deriv, and nothing is stored.
const AUTH_URL = (process.env.DERIV_AUTH_URL || "https://auth.deriv.com").replace(/\/+$/, "");
const NOT_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"]);
const FIELDS = {
  authorization_code: ["code", "redirect_uri", "code_verifier"],
  refresh_token: ["refresh_token"],
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Tbot-Proxy": "1" },
});

export async function POST(request) {
  const text = await request.text();
  if (text.length > 8192) return json({ error: "invalid_request", error_description: "body too large" }, 413);
  const form = new URLSearchParams(text);
  const grant = form.get("grant_type");
  const clientId = form.get("client_id") || "";
  if (!FIELDS[grant]) return json({ error: "unsupported_grant_type" }, 400);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) return json({ error: "invalid_client", error_description: "missing or malformed client_id" }, 400);

  const body = new URLSearchParams({ grant_type: grant, client_id: clientId });
  for (const name of FIELDS[grant]) {
    const value = form.get(name);
    if (!value || value.length > 4096) return json({ error: "invalid_request", error_description: `missing ${name}` }, 400);
    body.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetch(`${AUTH_URL}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(8000),   // stay inside the function's time limit, so it always answers
    });
  } catch (e) {
    // Only when the connection was never made has Deriv not seen the code, so the page
    // may try the exchange itself. After a timeout or a dropped answer it may have been used.
    const code = e?.cause?.code || "";
    if (NOT_SENT.has(code)) return json({ proxy_error: "upstream_unreachable", detail: code }, 502);
    return json({ error: "temporarily_unavailable", error_description: "Deriv's login server didn't answer in time" }, 504);
  }
  let raw = "";
  try { raw = await upstream.text(); } catch {
    return json({ error: "temporarily_unavailable", error_description: "Deriv's answer was cut off" }, 504);
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (!data || typeof data !== "object" || (!data.access_token && !data.error)) {
    // Not an OAuth answer (e.g. a firewall page), so the code was most likely not used.
    return json({ proxy_error: "upstream_not_oauth", status: upstream.status }, 502);
  }
  return json(data, upstream.status);
}
