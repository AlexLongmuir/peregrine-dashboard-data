import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

export function intEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid int env ${name}: ${raw}`);
  return n;
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content);
}

export function appendFile(p, content) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, content);
}

export function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function safeSlug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
}

export function newRunId(title = "") {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  const slug = safeSlug(title) || "work";
  return `${y}${m}${day}-${slug}-${rand}`;
}

export function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...opts,
  });
  if (res.status !== 0) {
    const err = new Error(`Command failed: ${cmd} ${args.join(" ")}\n${(res.stdout || "").slice(0, 5000)}\n${(res.stderr || "").slice(0, 5000)}`);
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.code = res.status;
    throw err;
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function redactIfNeeded(text, redact) {
  if (!redact) return text;
  // Minimal safety: hide long blocks. Keep only first ~400 chars.
  const t = String(text ?? "");
  if (t.length <= 500) return t;
  return t.slice(0, 400) + "\n\n[REDACTED]\n";
}
