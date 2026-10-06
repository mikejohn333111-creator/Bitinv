// File-backed storage for the server bot, all under one data directory (mode 0700):
//   settings.json  the user's settings            state.json   running flag, chosen account, open-trade notes
//   secret.json    Deriv App ID + token (0600)    guard.json   daily risk-limit state (RiskGuard storage)
//   log.jsonl      activity log, one JSON entry per line, trimmed to the last 2000 lines
// Every JSON file is written atomically (temp file, fsync, rename) and with mode 0600.
import { mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync,
         appendFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const LOG_MAX_LINES = 2000;

/** Writes a file so that readers see either the old or the new content, never half of it. */
export function atomicWrite(path, data, mode = 0o600) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  closeSync(fd);
  chmodSync(tmp, mode);   // the umask may have narrowed or widened it
  renameSync(tmp, path);
}

/** Creates the data directory (0700). An existing one is tightened to 0700 when we own it. */
export function ensureDataDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const st = statSync(dir);
    if ((st.mode & 0o077) && (process.getuid?.() === st.uid)) chmodSync(dir, 0o700);
  } catch { /* not ours to change */ }
  return dir;
}

export class FileStore {
  constructor(dir) {
    this.dir = ensureDataDir(dir);
    this.guardData = this.readJSON("guard.json", {});
    if (!this.guardData || typeof this.guardData !== "object") this.guardData = {};
    this.logLines = this.#countLogLines();
    // RiskGuard expects a localStorage-like object.
    this.guardStorage = {
      getItem: (k) => (Object.hasOwn(this.guardData, k) ? this.guardData[k] : null),
      setItem: (k, v) => { this.guardData[k] = String(v); this.writeJSON("guard.json", this.guardData); },
    };
  }

  path(name) { return join(this.dir, name); }

  readJSON(name, fallback) {
    try { return JSON.parse(readFileSync(this.path(name), "utf8")); } catch { return fallback; }
  }

  writeJSON(name, value) { atomicWrite(this.path(name), JSON.stringify(value, null, 2) + "\n", 0o600); }

  remove(name) { try { unlinkSync(this.path(name)); } catch { /* not there */ } }

  getSettings() { const s = this.readJSON("settings.json", {}); return s && typeof s === "object" ? s : {}; }
  saveSettings(s) { this.writeJSON("settings.json", s); }
  getState() { const s = this.readJSON("state.json", {}); return s && typeof s === "object" ? s : {}; }
  saveState(s) { this.writeJSON("state.json", s); }

  /** {appId, token} or null. */
  getSecret() {
    const s = this.readJSON("secret.json", null);
    return s && typeof s.token === "string" && s.token ? { appId: String(s.appId || ""), token: s.token } : null;
  }
  saveSecret({ appId, token }) { this.writeJSON("secret.json", { appId, token }); }
  clearSecret() { this.remove("secret.json"); }

  // ------------------------------------------------------------------ log
  #countLogLines() {
    try {
      const text = readFileSync(this.path("log.jsonl"), "utf8");
      let n = 0;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
      return n;
    } catch { return 0; }
  }

  appendLog(entry) {
    appendFileSync(this.path("log.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
    if (++this.logLines > LOG_MAX_LINES + 200) this.trimLog();
  }

  trimLog() {
    const keep = this.#readLogLines().slice(-LOG_MAX_LINES);
    atomicWrite(this.path("log.jsonl"), keep.length ? keep.join("\n") + "\n" : "", 0o600);
    this.logLines = keep.length;
  }

  #readLogLines() {
    try { return readFileSync(this.path("log.jsonl"), "utf8").split("\n").filter(Boolean); } catch { return []; }
  }

  /** The last `limit` log entries, oldest first. */
  readLog(limit = 500) {
    const out = [];
    for (const line of this.#readLogLines().slice(-limit)) {
      try { out.push(JSON.parse(line)); } catch { /* a torn line from a crash */ }
    }
    return out;
  }
}
