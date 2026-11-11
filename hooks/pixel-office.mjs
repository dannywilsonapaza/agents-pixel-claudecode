#!/usr/bin/env node
// Claude Code hook client: stdin JSON → local daemon → optional JSON answer on stdout.
// Starts the daemon on demand. Must never break a session: every failure exits 0 silently.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIBLING = join(HERE, "pixel-office.js");
const DAEMON =
  process.env.CLAUDE_PIXEL_OFFICE_DAEMON_PATH ||
  (existsSync(SIBLING) ? SIBLING : join(HERE, "..", "dist", "pixel-office.js"));

function readConfig() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return JSON.parse(readFileSync(join(dir, "pixel-office.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

const CONFIG = readConfig();
const PORT = Number(
  process.env.CLAUDE_PIXEL_OFFICE_PORT || process.env.PIXEL_OFFICE_PORT || CONFIG.port || 4777,
);
const TOKEN = process.env.CLAUDE_PIXEL_OFFICE_TOKEN || process.env.PIXEL_OFFICE_TOKEN || CONFIG.token;
// the daemon gives up after `hookTimeout` seconds; leave a margin so it can answer first
const HOOK_TIMEOUT = (Number(CONFIG.hookTimeout) || 120) * 1000 + 10_000;
const HOST = "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (err) => err?.cause?.code ?? err?.code;

async function readStdin() {
  let out = "";
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function post(payload, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pixel-office": "hook",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

function startDaemon() {
  try {
    const child = spawn(process.execPath, [DAEMON], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CLAUDE_PIXEL_OFFICE_DAEMON: "1" },
    });
    child.unref();
  } catch {
    // no daemon: the session continues without the office
  }
}

async function send(payload, timeoutMs, waitMs) {
  const deadline = Date.now() + waitMs;
  let started = false;
  for (;;) {
    try {
      return await post(payload, timeoutMs);
    } catch (err) {
      const code = codeOf(err);
      const refused = code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EADDRNOTAVAIL";
      if (!refused) return null; // timeout, abort, bad json: let Claude Code handle it
      if (!started) {
        startDaemon();
        started = true;
      }
      if (Date.now() > deadline) return null;
      await sleep(150);
    }
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== "object") return;

  // only permission prompts block Claude Code; everything else is fire-and-forget
  const blocking = input.hook_event_name === "PermissionRequest";
  const out = await send({ input }, blocking ? HOOK_TIMEOUT : 5_000, blocking ? 8_000 : 2_500);
  const decision = out?.hookSpecificOutput;
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }));
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
