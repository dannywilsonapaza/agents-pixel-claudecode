import assert from "node:assert/strict";
import { test } from "node:test";
import { mapHook, describeTool, rootKey, childKey } from "../src/claude/adapter.ts";
import type { BusEvent } from "../src/store.ts";

const base = {
  session_id: "abc123",
  transcript_path: "C:/Users/me/.claude/projects/x/abc123.jsonl",
  cwd: "C:\\Users\\me\\repo",
};

const find = (events: BusEvent[], type: string) => events.find((e) => e.type === type);
const part = (events: BusEvent[]) => find(events, "message.part.updated")?.properties.part;

test("SessionStart creates the root session with the folder name", () => {
  const { events } = mapHook({ ...base, hook_event_name: "SessionStart", source: "startup" });
  const info = find(events, "session.updated")?.properties.info;
  assert.equal(info.id, rootKey("abc123"));
  assert.equal(info.title, "repo");
  assert.equal(info.agent, "claude");
});

test("SessionStart keeps a custom session title and agent type", () => {
  const { events } = mapHook({
    ...base,
    hook_event_name: "SessionStart",
    session_title: "Fix the login bug",
    agent_type: "reviewer",
  });
  const info = find(events, "session.updated")?.properties.info;
  assert.equal(info.title, "Fix the login bug");
  assert.equal(info.agent, "reviewer");
});

test("UserPromptSubmit logs the prompt and marks the agent busy", () => {
  const { events } = mapHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "arregla el bug" });
  const p = part(events);
  assert.equal(p.type, "text");
  assert.equal(p.text, "arregla el bug");
  assert.equal(find(events, "session.status")?.properties.status.type, "busy");
});

test("PreToolUse / PostToolUse share a call id and the tool title", () => {
  const input = { command: "npm test" };
  const pre = mapHook({
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: input,
    tool_use_id: "toolu_1",
  });
  const post = mapHook({
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: input,
    tool_use_id: "toolu_1",
  });
  const a = part(pre.events);
  const b = part(post.events);
  assert.equal(a.callID, "toolu_1");
  assert.equal(a.state.status, "running");
  assert.equal(b.state.status, "completed");
  assert.equal(a.state.title, "npm test");
  assert.equal(b.callID, a.callID);
});

test("tool failures are reported as errors", () => {
  const { events } = mapHook({
    ...base,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "false" },
    tool_use_id: "toolu_2",
    error: "exit 1",
  });
  const p = part(events);
  assert.equal(p.state.status, "error");
  assert.equal(p.state.error, "exit 1");
});

test("writes expose the file name", () => {
  assert.equal(describeTool("Write", { file_path: "C:\\repo\\src\\app.ts" }), "app.ts");
  assert.equal(describeTool("Grep", { pattern: "useState" }), "useState");
});

test("PermissionRequest blocks and carries an id", () => {
  const { events, permission } = mapHook({
    ...base,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build" },
    tool_use_id: "toolu_3",
  });
  const asked = find(events, "permission.asked")?.properties;
  assert.equal(asked.sessionID, rootKey("abc123"));
  assert.equal(asked.title, "Use Bash");
  assert.deepEqual(asked.patterns, ["rm -rf build"]);
  assert.ok(permission);
  assert.equal(permission.id, asked.id);
});

test("AskUserQuestion is shown as a question, not a permission", () => {
  const { events, permission, question } = mapHook({
    ...base,
    hook_event_name: "PermissionRequest",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "¿Seguimos?", options: [{ label: "Sí" }, { label: "No" }] }] },
  });
  assert.equal(permission, undefined);
  assert.ok(question);
  assert.equal(find(events, "question.asked")?.properties.title, "¿Seguimos?");
});

test("subagents get their own session under the parent", () => {
  const start = mapHook({
    ...base,
    hook_event_name: "SubagentStart",
    agent_id: "agent-1",
    agent_type: "Explore",
  });
  const info = find(start.events, "session.updated")?.properties.info;
  assert.equal(info.id, childKey("abc123", "agent-1"));
  assert.equal(info.parentID, rootKey("abc123"));
  assert.equal(info.agent, "Explore");

  const stop = mapHook({
    ...base,
    hook_event_name: "SubagentStop",
    agent_id: "agent-1",
    agent_type: "Explore",
    last_assistant_message: "encontré el problema",
  });
  const idle = stop.events.find((e) => e.type === "session.idle");
  assert.equal(idle?.properties.sessionID, childKey("abc123", "agent-1"));
  const text = stop.events.find((e) => e.type === "message.part.updated");
  assert.equal(text?.properties.part.text, "encontré el problema");
});

test("Stop shows the final message and idles the session", () => {
  const { events } = mapHook({
    ...base,
    hook_event_name: "Stop",
    last_assistant_message: "listo, todo verde",
  });
  const text = events.find((e) => e.type === "message.part.updated")?.properties.part;
  assert.equal(text.text, "listo, todo verde");
  assert.ok(text.time.end);
  assert.equal(events.at(-1)?.type, "session.idle");
});

test("SessionEnd and compactions clear the busy state", () => {
  assert.equal(mapHook({ ...base, hook_event_name: "SessionEnd" }).events[0].type, "session.idle");
  assert.equal(mapHook({ ...base, hook_event_name: "PreCompact" }).events[0].type, "session.compacted");
});
