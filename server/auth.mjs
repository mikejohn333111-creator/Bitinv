// Password, sessions and login rate limiting for the control page.
//
// auth.json  {v, algo: "scrypt", N, r, p, keylen, salt, hash, id, changedAt}, mode 0600. "id" changes with
//            every new password, and a session only counts if it was made under the current id, so
//            changing the password (on the page or with the set-password command) logs out every other device.
// sessions.json  [{h: sha256(session id), pw, created, seen}], at most 20. The cookie holds the session id;
//            the file holds only its hash.
// devices.json   [{h: sha256(device id), created, seen}], at most 20. A device that logged in once gets a
//            long-lived random "known device" cookie. Its logins skip the shared limit on wrong passwords,
//            so strangers guessing passwords can't lock the owner out (the OWASP device-cookie pattern).
import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store.mjs";

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86400e3;
const MAX_SESSIONS = 20;
export const DEVICE_DAYS = 365;
const DEVICE_MS = DEVICE_DAYS * 86400e3;
const MAX_DEVICES = 20;

const scryptAsync = (pw, salt, { N, r, p, keylen }) => new Promise((resolve, reject) =>
  scrypt(pw, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (e, key) => (e ? reject(e) : resolve(key))));

export function checkNewPassword(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) return `The password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `The password can be at most ${MAX_PASSWORD} characters.`;
  return "";
}

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, SCRYPT);
  return { v: 1, algo: "scrypt", ...SCRYPT, salt: salt.toString("base64"), hash: hash.toString("base64"),
           id: randomBytes(9).toString("base64url"), changedAt: new Date().toISOString() };
}

export async function verifyPassword(rec, pw) {
  if (!rec || typeof pw !== "string" || pw.length > MAX_PASSWORD * 4) return false;
  const expected = Buffer.from(rec.hash, "base64");
  const key = await scryptAsync(pw, Buffer.from(rec.salt, "base64"), { N: rec.N, r: rec.r, p: rec.p, keylen: expected.length });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function writeAuthFile(dir, rec) { atomicWrite(join(dir, "auth.json"), JSON.stringify(rec) + "\n", 0o600); }

const validRecord = (r) => r && r.algo === "scrypt" && typeof r.salt === "string" && typeof r.hash === "string" &&
  typeof r.id === "string" && [r.N, r.r, r.p].every(Number.isInteger) && r.N >= 1024 && r.N <= 2 ** 20 &&
  r.r >= 1 && r.r <= 32 && r.p >= 1 && r.p <= 16 && Buffer.from(r.hash, "base64").length >= 16;

/** The password record, re-read from disk whenever the file changes. */
export class PasswordFile {
  constructor(dir) { this.path = join(dir, "auth.json"); this.sig = null; this.rec = null; }

  current() {
    let st;
    try { st = statSync(this.path); } catch { this.sig = null; this.rec = null; return null; }
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (sig !== this.sig) {
      this.sig = sig;
      try { const r = JSON.parse(readFileSync(this.path, "utf8")); this.rec = validRecord(r) ? r : null; } catch { this.rec = null; }
    }
    return this.rec;
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export class Sessions {
  constructor(store) {
    this.store = store;
    const list = store.readJSON("sessions.json", []);
    this.list = Array.isArray(list) ? list.filter((s) => s && typeof s.h === "string") : [];
    this.dirtyAt = 0;
  }

  #save() { this.store.writeJSON("sessions.json", this.list); this.dirtyAt = 0; }

  #prune(now = Date.now()) { this.list = this.list.filter((s) => now - s.created < SESSION_MS); }

  /** Makes a new session; returns the id for the cookie. */
  create(pwId, now = Date.now()) {
    const sid = randomBytes(32).toString("base64url");
    this.#prune(now);
    this.list.push({ h: sha256(sid), pw: pwId, created: now, seen: now });
    this.list.sort((a, b) => a.seen - b.seen);
    if (this.list.length > MAX_SESSIONS) this.list.splice(0, this.list.length - MAX_SESSIONS);
    this.#save();
    return sid;
  }

  /** The session for this cookie value if it is valid under the current password, else null. */
  find(sid, pwId, now = Date.now()) {
    if (!sid || typeof sid !== "string" || sid.length > 100 || !pwId) return null;
    const h = sha256(sid);
    const s = this.list.find((x) => x.h === h);
    if (!s || s.pw !== pwId || now - s.created >= SESSION_MS) return null;
    s.seen = now;
    if (!this.dirtyAt) this.dirtyAt = now;
    if (now - this.dirtyAt > 3600e3) this.#save();   // "last seen" is saved at most hourly
    return s;
  }

  remove(sid) {
    if (!sid) return;
    const h = sha256(String(sid));
    const n = this.list.length;
    this.list = this.list.filter((x) => x.h !== h);
    if (this.list.length !== n) this.#save();
  }

  /** After a password change: keeps only the given session, moved to the new password. */
  keepOnly(session, pwId) {
    this.list = session ? [{ ...session, pw: pwId }] : [];
    this.#save();
  }

  flush() { if (this.dirtyAt) this.#save(); }
}

/** Devices that logged in before (see devices.json above). */
export class Devices {
  constructor(store) {
    this.store = store;
    const list = store.readJSON("devices.json", []);
    this.list = Array.isArray(list) ? list.filter((d) => d && typeof d.h === "string") : [];
  }

  #save() { this.store.writeJSON("devices.json", this.list); }

  /** Makes a new device id for the cookie. */
  create(now = Date.now()) {
    const id = randomBytes(32).toString("base64url");
    this.list = this.list.filter((d) => now - d.created < DEVICE_MS);
    this.list.push({ h: sha256(id), created: now, seen: now });
    this.list.sort((a, b) => a.seen - b.seen);
    if (this.list.length > MAX_DEVICES) this.list.splice(0, this.list.length - MAX_DEVICES);
    this.#save();
    return id;
  }

  /** The hash of a known device id (used as its rate-limit key), or "". */
  find(id, now = Date.now()) {
    if (!id || typeof id !== "string" || id.length > 100) return "";
    const h = sha256(id);
    const d = this.list.find((x) => x.h === h);
    return d && now - d.created < DEVICE_MS ? h : "";
  }

  touch(h, now = Date.now()) {
    const d = this.list.find((x) => x.h === h);
    if (d && now - d.seen > 86400e3) { d.seen = now; this.#save(); }
  }

  /** Too many wrong passwords from this device: it is a stranger now. */
  drop(h) {
    const n = this.list.length;
    this.list = this.list.filter((x) => x.h !== h);
    if (this.list.length !== n) this.#save();
  }
}

/**
 * The rate-limit key for an address. IPv6 users usually get a whole /64, so one person
 * could otherwise use a new address for every guess.
 */
export function ipBucket(ip) {
  ip = String(ip || "").replace(/%.*$/, "").toLowerCase();
  if (!ip.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/^::ffff:/, "");
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = ip.includes("::") && tail ? tail.split(":") : [];
  const parts = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (parts.length < 4 || parts.slice(0, 4).some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return ip;
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Failed logins: at most `perIp` per key and `global` in total per window.
 * A known device (pass its hash as `device`) is limited on its own and skips the IP and
 * shared limits, so the owner can always log in from a phone that logged in before.
 */
export class LoginLimiter {
  constructor({ perIp = 5, global = 30, windowMs = 15 * 60e3 } = {}) {
    this.perIp = perIp; this.global = global; this.windowMs = windowMs;
    this.ips = new Map();   // ip -> [times]
    this.all = [];
  }

  #prune(now) {
    const cut = now - this.windowMs;
    this.all = this.all.filter((t) => t > cut);
    for (const [ip, list] of this.ips) {
      const kept = list.filter((t) => t > cut);
      if (kept.length) this.ips.set(ip, kept); else this.ips.delete(ip);
    }
  }

  #key(ip, device) { return device ? `dev:${device}` : `ip:${ip}`; }

  /** 0 when a login attempt is allowed, otherwise seconds to wait. */
  retryAfter(ip, now = Date.now(), device = "") {
    this.#prune(now);
    const mine = this.ips.get(this.#key(ip, device)) || [];
    let until = 0;
    if (mine.length >= this.perIp) until = Math.max(until, mine[mine.length - this.perIp] + this.windowMs);
    if (!device && this.all.length >= this.global) until = Math.max(until, this.all[this.all.length - this.global] + this.windowMs);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  /** True when this device has used up its wrong passwords for the window. */
  deviceSpent(device, now = Date.now()) { return !!device && this.retryAfter("", now, device) > 0; }

  /**
   * Counts a login attempt before the password is checked, so many attempts sent at once
   * can't slip past the limit. Returns a mark to pass to succeed() when the password is right.
   */
  attempt(ip, now = Date.now(), device = "") {
    const key = this.#key(ip, device);
    const list = this.ips.get(key) || [];
    list.push(now);
    this.ips.set(key, list.slice(-this.perIp));
    const mark = { t: now, key, shared: !device };
    if (!device) this.all.push(now);
    if (this.all.length > this.global * 2) this.all = this.all.slice(-this.global);
    if (this.ips.size > 10000) this.#prune(now);
    return mark;
  }

  /** The password was right: that attempt doesn't count, and this IP (or device) starts afresh. */
  succeed(ip, mark) {
    this.ips.delete(mark?.key ?? this.#key(ip, ""));
    if (mark?.shared) { const i = this.all.lastIndexOf(mark.t); if (i !== -1) this.all.splice(i, 1); }
  }
}
