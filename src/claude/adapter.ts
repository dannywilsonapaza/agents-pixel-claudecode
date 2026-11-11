// Claude Code hook payloads → the bus events the office reducer understands.
// Pure: no I/O, no state, so it is easy to test against captured hook samples.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { BusEvent } from "../store.ts";

export interface PermissionAsk {
  id: string;
  sessionID: string;
  title: string;
  detail?: string;
  tool: string;
}

export interface Mapped {
  events: BusEvent[];
  /** set when the hook must block until the UI answers */
  permission?: PermissionAsk;
  /** non-blocking: shown in the queue but answered in the terminal */
  question?: PermissionAsk;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const head = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** stable ids, namespaced so they can never collide with session ids from another source */
export const rootKey = (sessionID: string) => `claude:${sessionID}`;
export const childKey = (sessionID: string, agentID: string) => `claude:${sessionID}:${agentID}`;

/** short description of a Claude tool call, using Claude's snake_case input fields first */
export function describeTool(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const v = rec[k];
    if (typeof v === "string" && v) return /path|file/i.test(k) ? basename(v) : head(oneLine(v), 70);
  }
  const target = rec.subagent_type ?? rec.agent;
  if (typeof target === "string" && target) return `@${target}`;
  return "";
}

const isQuestion = (tool: string) => /^(askuserquestion|ask_user_question)$/i.test(tool);

export function mapHook(h: Record<string, unknown>): Mapped {
  const hook = str(h.hook_event_name) ?? "";
  const sid = str(h.session_id) ?? "unknown";
  const cwd = str(h.cwd) ?? "";
  const agentID = str(h.agent_id);
  const agentType = str(h.agent_type);
  const root = rootKey(sid);
  const sessionID = agentID ? childKey(sid, agentID) : root;
  const now = Date.now();
  const title = str(h.session_title) ?? (cwd ? basename(cwd) : "Claude Code");
  const events: BusEvent[] = [];
  const emit = (type: string, properties: unknown) => events.push({ type, properties });
  const busy = () => emit("session.status", { sessionID, status: { type: "busy" } });
  const idle = () => emit("session.idle", { sessionID });

  const assistantText = (text: string, id: string) => {
    const mid = `cc-mid:${sessionID}:${id}`;
    emit("message.updated", { info: { id: mid, sessionID, role: "assistant", agent: agentType ?? "claude" } });
    emit("message.part.updated", {
      part: { id: `${mid}:text`, sessionID, messageID: mid, type: "text", text, time: { start: now, end: now } },
    });
  };

  switch (hook) {
    case "SessionStart": {
      emit("session.updated", {
        info: {
          id: sessionID,
          title,
          directory: cwd,
          agent: agentType ?? "claude",
          time: { created: now, updated: now },
        },
      });
      break;
    }

    case "UserPromptSubmit": {
      const prompt = str(h.prompt) ?? "";
      if (!prompt) break;
      const mid = `cc-mid:${sessionID}:u:${hash(prompt + now)}`;
      emit("message.updated", { info: { id: mid, sessionID, role: "user", agent: agentType ?? "claude" } });
      emit("message.part.updated", {
        part: { id: `${mid}:text`, sessionID, messageID: mid, type: "text", text: prompt, time: { start: now, end: now } },
      });
      busy();
      break;
    }

    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = str(h.tool_name) ?? "tool";
      const input = h.tool_input;
      const callID = str(h.tool_use_id) ?? `cc-call:${hash(tool + JSON.stringify(input ?? null))}`;
      const status = hook === "PreToolUse" ? "running" : hook === "PostToolUse" ? "completed" : "error";
      const state: Record<string, unknown> = { status, input, title: describeTool(tool, input) };
      if (hook === "PostToolUseFailure") state.error = str(h.error) ?? "tool failed";
      emit("message.part.updated", {
        part: {
          id: callID,
          sessionID,
          messageID: `cc-mid:${sessionID}:a`,
          type: "tool",
          tool,
          callID,
          state,
        },
      });
      if (hook === "PreToolUse") busy();
      break;
    }

    case "PermissionRequest": {
      const tool = str(h.tool_name) ?? "tool";
      const input = h.tool_input;
      const id = `cc-perm:${sid}:${str(h.tool_use_id) ?? hash(tool + JSON.stringify(input ?? null))}`;
      const detail = describeTool(tool, input);
      const ask: PermissionAsk = { id, sessionID, title: `Use ${tool}`, detail: detail || undefined, tool };
      if (isQuestion(tool)) {
        const rec = (input ?? {}) as Record<string, unknown>;
        const q = Array.isArray(rec.questions) ? (rec.questions[0] as Record<string, unknown>) : undefined;
        ask.title = str(q?.question) ?? "Claude has a question";
        emit("question.asked", { sessionID, id, title: ask.title, questions: rec.questions });
        return { events, question: ask };
      }
      emit("permission.asked", {
        sessionID,
        id,
        title: ask.title,
        patterns: detail ? [detail] : [],
      });
      busy();
      return { events, permission: ask };
    }

    case "PermissionDenied": {
      const tool = str(h.tool_name) ?? "tool";
      emit("permission.replied", {
        sessionID,
        requestID: `cc-perm:${sid}:${str(h.tool_use_id) ?? hash(tool + JSON.stringify(h.tool_input ?? null))}`,
      });
      break;
    }

    case "SubagentStart": {
      const id = agentID ?? hash(`${sid}:${agentType ?? "subagent"}`);
      const child = childKey(sid, id);
      const name = agentType ?? "subagent";
      emit("session.updated", {
        info: { id: child, parentID: root, title: name, directory: cwd, agent: name, time: { created: now, updated: now } },
      });
      emit("session.status", { sessionID: child, status: { type: "busy" } });
      // a spawn line in the parent's feed, mirroring a subagent task part
      emit("message.part.updated", {
        part: {
          id: `cc-spawn:${child}`,
          sessionID: root,
          messageID: `cc-mid:${root}:a`,
          type: "subtask",
          agent: name,
          description: str(h.description) ?? "",
        },
      });
      break;
    }

    case "SubagentStop": {
      const id = agentID ?? hash(`${sid}:${agentType ?? "subagent"}`);
      const child = childKey(sid, id);
      const last = str(h.last_assistant_message);
      if (last) assistantText(last, `sub:${id}:${now}`);
      emit("session.idle", { sessionID: child });
      break;
    }

    case "Stop": {
      const last = str(h.last_assistant_message);
      if (last) assistantText(last, `stop:${now}`);
      idle();
      break;
    }

    case "StopFailure": {
      emit("session.error", {
        sessionID,
        error: { name: str(h.error_type) ?? "StopFailure", message: str(h.error) ?? "turn failed" },
      });
      break;
    }

    case "SessionEnd": {
      idle();
      break;
    }

    case "PreCompact": {
      emit("session.compacted", { sessionID });
      break;
    }

    case "PostCompact":
      break;

    case "Notification": {
      const message = str(h.message);
      if (message) emit("message.part.updated", {
        part: {
          id: `cc-note:${sessionID}:${hash(message + now)}`,
          sessionID,
          messageID: `cc-mid:${sessionID}:a`,
          type: "text",
          text: message,
          time: { start: now, end: now },
        },
      });
      break;
    }

    case "Elicitation": {
      const message = str(h.message) ?? "Claude needs input";
      const id = `cc-elicit:${sid}:${hash(message + now)}`;
      emit("question.asked", { sessionID, id, title: message });
      return { events, question: { id, sessionID, title: message, tool: "Elicitation" } };
    }
  }

  return { events };
}
