# 🏢 Claude Code Pixel Office

**Watch your Claude Code sessions and subagents work live — in a top-down pixel-art office.**

Hooks report every session, prompt, tool call and subagent to a small local daemon, which serves a
self-contained web UI on `http://127.0.0.1:4777/`. No terminal changes, no API keys, no cloud.

```
Claude Code ──hooks (stdin JSON)──▶ pixel-office.mjs ──HTTP──▶ daemon :4777 ──SSE──▶ browser
                    ▲                                              │
                    └──────── PermissionRequest decision ◀─────────┘
```

## ✨ What you get

| | |
|---|---|
| 👥 **Rooms per session** | One office per `session_id`, with the working directory as its title. |
| 🧵 **Subagents with names** | `SubagentStart` / `SubagentStop` place `Explore`, `general-purpose`, `Plan` or your custom agents at their own desks. |
| 🔧 **Live tool calls** | Every `PreToolUse` / `PostToolUse` shows the tool, its target and a page added to the desk stack for writes. |
| ✋ **Approvals in the browser** | Answer `PermissionRequest` prompts with **Allow once / Always allow / Reject** while the tab is open. |
| 💬 **Speech bubbles** | Prompts, the final answer of each turn and notifications. |
| 📊 **Timeline & attention queue** | Waiting, failures and agents silent for 10 minutes, plus a per-agent activity timeline. |
| 🌙 **Day & night** | Follows your local clock. |
| 📱 **Phone friendly** | Works on a phone on the same machine or LAN (with a token). |

## 🚀 Install

### Requirements

| | |
|---|---|
| **Claude Code** | A version with hooks: `SessionStart`, `PreToolUse`, `SubagentStart`, `PermissionRequest` (v2.1.x or newer). |
| **Node.js ≥ 22.18** | To build. The hook client itself is plain JavaScript. |
| **Browser** | Any current browser. |

### Quick start

```powershell
cd claudecode-pixel-office
npm install
npm run build

# global: hooks go to %USERPROFILE%\.claude\settings.json
node scripts/install.ts
```

```bash
# macOS / Linux
npm install && npm run build
node scripts/install.ts
```

Then **restart Claude Code** (hooks are read at startup; review them with `/hooks`) and open:

```
http://127.0.0.1:4777/
```

The daemon starts on demand with the first hook — there is nothing to launch.

| Option | Effect |
|---|---|
| `--project <dir>` | install only for one project (`<dir>/.claude`) instead of `~/.claude` |
| `--port 4800` | write the port to `~/.claude/pixel-office.json` |
| `--no-build` | reuse an existing `dist/pixel-office.js` |
| `--uninstall` | remove the hooks and the copied files (settings backup kept) |

The installer backs up `settings.json` to `settings.json.bak` before touching it.

### Plugin route (optional)

The repo also contains `.claude-plugin/plugin.json` and `hooks/hooks.json`, so it can be loaded as a
Claude Code plugin from a folder/marketplace. That route expects `dist/` to be present (build first)
and uses `${CLAUDE_PLUGIN_ROOT}` to find the hook client.

## 🔧 Configuration

Settings are read from env vars, then `~/.claude/pixel-office.json`, then defaults. The hook client
reads the same file, so the port never gets out of sync.

| Setting | Env variable | Default | |
|---|---|---|---|
| `port` | `CLAUDE_PIXEL_OFFICE_PORT` | `4777` | |
| `host` | `CLAUDE_PIXEL_OFFICE_HOST` | `127.0.0.1` | `0.0.0.0` for LAN / Tailscale |
| `token` | `CLAUDE_PIXEL_OFFICE_TOKEN` | – | open once with `?token=…`; the browser keeps a cookie |
| `allowedHosts` | `CLAUDE_PIXEL_OFFICE_ALLOWED_HOSTS` | `[]` | host names allowed without a token |
| `hookTimeout` | `CLAUDE_PIXEL_OFFICE_HOOK_TIMEOUT` | `120` | seconds a PermissionRequest waits for the UI |
| `idleExit` | `CLAUDE_PIXEL_OFFICE_IDLE_EXIT` | `0` | minutes without hooks before the daemon exits |
| `debug` | `CLAUDE_PIXEL_OFFICE_DEBUG` | `false` | sample the first payload of each hook in `pixel-office.log` |

```json
{ "port": 4777, "host": "0.0.0.0", "token": "your-secret-token" }
```

With `host: "0.0.0.0"` always set a token: the UI shows prompts, commands and file names.

## 🖱 Using the UI

| Control | What it does |
|---|---|
| **Room tabs** | One tab per Claude Code session. |
| **Needs attention** | Approvals and questions, failures and agents with no activity for 10 minutes. |
| **▤ Building** | One floor per project folder. |
| **Threads** | Lines from Claude to everyone working on its assignments. |
| **Timeline** | Working / waiting / retrying / failed intervals. |
| **Follow** | Stay on the busiest room. |
| **Panel** | Click a person or desk for the activity feed, todos, edited files and controls. |

URL parameters: `?time=day|night`, `?threads=1`, `?timeline=1`, `?follow=0`, `?view=building`.

## ✋ Approvals

A `PermissionRequest` hook blocks and waits for the browser. The answer goes back to Claude Code as
`{ behavior: "allow" | "deny", message, interrupt }`, so **Reject** and **Stop** work from the UI.

If no browser is connected, the hook returns immediately and Claude Code shows its normal terminal
dialog. If the tab closes while a prompt is waiting, the daemon stops blocking within a second.

**Questions** (`AskUserQuestion`) and MCP elicitations are shown in the queue but must be answered in
the terminal; the office clears them after a minute.

## ⚠️ Limitations

- **Text is per turn**, not streamed: hooks deliver the prompt and `last_assistant_message`, not the
  token stream. Tool-level activity is live.
- **History is in memory**: restarting the daemon (or a long idle exit) clears the timeline. Sessions
  that already existed reappear with their current state, not their past.
- **One process per hook**: every tool call spawns a short Node process (~50–100 ms). On very busy
  parallel sessions that overhead is noticeable.
- **First run**: Claude Code may ask you to review the new hooks before running them.
- **Windows / GUI launches** need `node` on `PATH`; the installer uses the absolute path of the hook
  client but still calls `node` to run it.
- The daemon only observes: it cannot see tool calls made before it started.

## 🩺 Troubleshooting

| Symptom | Fix |
|---|---|
| Page doesn't load | No session started yet. Run any Claude Code command, then check the port. |
| Page loads but stays empty | Hooks not firing: run `/hooks`, restart Claude Code, confirm `settings.json` lists `pixel-office.mjs`. |
| `421 Host not allowed` | Open `localhost`/`127.0.0.1`, add the name to `allowedHosts`, or set a token. |
| Port already in use | Another daemon owns it and receives the events. Use `--port` for a second one. |
| Approve buttons missing | Controls need a loopback bind or a token. The panel shows the reason. |
| Nothing makes sense | Run with `debug` and inspect `~/.claude/pixel-office.log`. |

Check the daemon by hand:

```bash
node dist/pixel-office.js --port 4799
curl http://127.0.0.1:4799/api/state
```

## 🛠 Development

```bash
npm install
npm run dev        # build + daemon on http://127.0.0.1:4777
npm test           # adapter unit tests
npm run typecheck
```

Send a fake hook:

```bash
curl -X POST http://127.0.0.1:4777/api/hook \
  -H "content-type: application/json" -H "x-pixel-office: hook" \
  -d '{"input":{"hook_event_name":"SessionStart","session_id":"demo","cwd":"C:/repo"}}'
```

### Layout

```
src/
  types.ts      shared UI/server types
  store.ts      pure reducer: bus events → UI diff ops
  server.ts     node:http – UI, SSE, /api/hook, /api/control, /api/caps
  config.ts     env / pixel-office.json
  claude/
    adapter.ts  hook payloads → bus events (pure, unit-tested)
    daemon.ts   server wiring, permission bridge, debug sampling
    main.ts     entry point
hooks/
  pixel-office.mjs   hook client: stdin → daemon → optional decision
  hooks.json         hook registration for the plugin route
scripts/install.ts   settings.json merge/uninstall
web/                 canvas office, characters, panel, timeline
test/                adapter tests
```

## 📜 Licenses

- Code: MIT.
- Font: [Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) under the SIL Open Font License 1.1
  (`web/fonts/OFL.txt`).
- Graphics are drawn procedurally in code.
- Not affiliated with Anthropic.

## Uninstall

```bash
node scripts/install.ts --uninstall
```

Removes the hook entries and `~/.claude/pixel-office/`. The config file is kept; delete
`~/.claude/pixel-office.json` to reset it.
