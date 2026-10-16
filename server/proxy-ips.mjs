// Extra trusted proxy addresses (TBOT_PROXY_IPS): a comma-separated list of IPv4
// addresses or CIDR ranges, such as "172.18.0.0/16" for a web server in a Docker container.

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The address as a 32-bit unsigned number, or null when it isn't a plain IPv4 address. */
export function ipv4ToInt(ip) {
  const m = V4.exec(String(ip ?? "").trim().replace(/^::ffff:/i, ""));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** One "a.b.c.d" or "a.b.c.d/n" entry as { base, mask }, or null when it isn't valid. */
export function parseCidr(entry) {
  const [addr, bits, extra] = String(entry ?? "").trim().split("/");
  if (extra !== undefined) return null;
  const ip = ipv4ToInt(addr);
  if (ip === null || /^::ffff:/i.test(addr)) return null;
  let n = 32;
  if (bits !== undefined) {
    if (!/^\d{1,2}$/.test(bits)) return null;
    n = Number(bits);
    if (n > 32) return null;
  }
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

/**
 * Parses TBOT_PROXY_IPS. Returns { ranges, bad, has(ip) }: `bad` lists the entries that
 * were ignored, and `has` is true for an address (also "::ffff:a.b.c.d") inside any range.
 */
export function parseProxyList(text) {
  const ranges = [], bad = [];
  for (const raw of String(text ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const r = parseCidr(entry);
    if (r) ranges.push(r); else bad.push(entry);
  }
  const has = (ip) => {
    if (!ranges.length) return false;
    const n = ipv4ToInt(ip);
    return n !== null && ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
  };
  return { ranges, bad, has };
}
