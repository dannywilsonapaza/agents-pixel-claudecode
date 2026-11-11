// The office daemon: serves the UI, turns hook payloads into office events and
// bridges PermissionRequest hooks to the buttons in the browser.

import { appendFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { HTML, JS } from "../assets.generated.ts";
import { claudeConfigDir, type Config } from "../config.ts";
import { Hub } from "../server.ts";
import { Store, type BusEvent } from "../store.ts";
import type { ControlRequest } from "../types.ts";
import { mapHook, rootKey, childKey, type PermissionAsk } from "./adapter.ts";

type Decision =
  | { behavior: "allow" }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

interface Pending {
  sessionID: string;
  resolve: (d: Decision | null) => void;
}

export interface Daemon {
  hub: Hub;
  stop: () => Promise<void>;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const QUESTION_TTL = 60_000;

export async function createDaemon(
  cfg: Config,
  log: (line: string) => void = () => {},
): Promise<Daemon> {
  const store = new Store();
  const pending = new Map<string, Pending>();
  const questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const seen = new Set<string>();
  let lastHook = Date.now();

  const hub: Hub = new Hub(store, {
    port: cfg.port,
    host: cfg.host,
    token: cfg.token,
    allowedHosts: cfg.allowedHosts,
    html: HTML,
    js: JS,
    onHook: async (payload, signal) => {
      lastHook = Date.now();
      const input = isRec(payload) && isRec(payload.input) ? payload.input : payload;
      if (!isRec(input)) return {};
      sample(cfg, input);
      ensureSession(hub, input, seen);
      const { events, permission, question } = mapHook(input);
      for (const ev of events) hub.ingest(ev);

      if (question) {
        // answered in the terminal; the hook returns immediately
        clearTimeout(questionTimers.get(question.id));
        questionTimers.set(
          question.id,
          setTimeout(() => {
            questionTimers.delete(question.id);
            hub.ingest({ type: "question.replied", properties: { sessionID: question.sessionID, requestID: question.id } });
          }, QUESTION_TTL),
        );
        return {};
      }
      if (!permission) return {};

      // nobody is watching: let Claude Code show its own dialog instead of blocking
      const decision = hub.hasClients() ? await wait(permission, signal) : null;
      hub.ingest({
        type: "permission.replied",
        properties: { sessionID: permission.sessionID, requestID: permission.id },
      });
      // no answer: print nothing, so Claude Code shows its own dialog
      return decision ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } } : {};
    },
  });

  function wait(ask: PermissionAsk, signal: AbortSignal): Promise<Decision | null> {
    return new Promise((resolve) => {
      const finish = (d: Decision | null) => {
        pending.delete(ask.id);
        clearTimeout(timer);
        clearInterval(watch);
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), cfg.hookTimeoutMs);
      // if the last browser closes, stop blocking and hand the prompt back to the terminal
      const watch = setInterval(() => {
        if (!hub.hasClients()) finish(null);
      }, 1000);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.set(ask.id, {
        sessionID: ask.sessionID,
        resolve: (d) => {
          if (!pending.has(ask.id)) return;
          finish(d);
        },
      });
    });
  }

  hub.setController(async (req: ControlRequest) => {
    if (req.action === "interrupt") {
      const target =
        [...pending.values()].find((p) => p.sessionID === req.sessionID) ?? [...pending.values()][0];
      if (!target) throw new Error("nothing to stop: no pending permission request");
      target.resolve({ behavior: "deny", interrupt: true, message: "Stopped from Pixel Office" });
      return;
    }
    const p = pending.get(req.requestID);
    if (!p) throw new Error("this request is no longer pending");
    p.resolve(
      req.decision === "reject"
        ? { behavior: "deny", message: "Rejected from Pixel Office" }
        : { behavior: "allow" },
    );
  });

  try {
    await hub.listen();
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      // another daemon already serves the port; hooks talk to it instead
      throw Object.assign(new Error(`port ${cfg.port} is already in use`), { code: "EADDRINUSE" });
    }
    throw err;
  }

  const timers: ReturnType<typeof setInterval>[] = [];
  if (cfg.idleExitMinutes > 0) {
    timers.push(
      setInterval(() => {
        if (Date.now() - lastHook < cfg.idleExitMinutes * 60_000) return;
        void stop();
      }, 60_000),
    );
    for (const t of timers) (t as { unref?: () => void }).unref?.();
  }

  async function stop() {
    for (const t of timers) clearInterval(t);
    for (const t of questionTimers.values()) clearTimeout(t);
    questionTimers.clear();
    for (const p of [...pending.values()]) p.resolve(null);
    await hub.close();
  }

  return { hub, stop };
}

/** Emits a session.updated the first time a session is seen, so a daemon restart still gets titles. */
function ensureSession(hub: Hub, input: Record<string, unknown>, seen: Set<string>) {
  const sid = str(input.session_id);
  if (!sid) return;
  const agentID = str(input.agent_id);
  const key = agentID ? childKey(sid, agentID) : rootKey(sid);
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
  const cwd = str(input.cwd) ?? "";
  const agent = str(input.agent_type) ?? (agentID ? "subagent" : "claude");
  const info: Record<string, unknown> = {
    id: key,
    title: str(input.session_title) ?? (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined) ?? "Claude Code",
    directory: cwd,
    agent,
    time: { created: Date.now(), updated: Date.now() },
  };
  if (agentID) info.parentID = rootKey(sid);
  hub.ingest({ type: "session.updated", properties: { info } });
}

/** Debug sampling: first samples of every event type, capped and never on by default. */
const sampled = new Set<string>();
function sample(cfg: Config, input: Record<string, unknown>) {
  if (!cfg.debug) return;
  const type = String(input.hook_event_name ?? "unknown");
  if (sampled.has(type) || sampled.size > 200) return;
  sampled.add(type);
  try {
    const file = join(claudeConfigDir(), "pixel-office.log");
    try {
      if (statSync(file).size > 256 * 1024) truncateSync(file, 0);
    } catch {
      // first write
    }
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), type, sample: truncate(input) }) + "\n");
  } catch {
    // logging must never take the daemon down
  }
}

function truncate(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v.length > 300 ? v.slice(0, 300) + "…" : v;
    else if (v && typeof v === "object") {
      const s = JSON.stringify(v);
      out[k] = s.length > 400 ? s.slice(0, 400) + "…" : v;
    } else out[k] = v;
  }
  return out;
}
