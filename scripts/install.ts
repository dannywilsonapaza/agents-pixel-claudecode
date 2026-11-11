// Installs the daemon + hook client into ~/.claude (or <project>/.claude) and merges the
// hooks into settings.json. Idempotent; --uninstall removes only what it added.
//
//   node scripts/install.ts                 global (~/.claude)
//   node scripts/install.ts --project .     this project only (<dir>/.claude)
//   node scripts/install.ts --port 4800
//   node scripts/install.ts --no-build
//   node scripts/install.ts --uninstall

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "../src/config.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = "pixel-office.mjs";

const EVENTS: Record<string, number> = {
  SessionStart: 10,
  UserPromptSubmit: 10,
  PreToolUse: 10,
  PostToolUse: 10,
  PostToolUseFailure: 10,
  PermissionRequest: 300,
  PermissionDenied: 10,
  SubagentStart: 10,
  SubagentStop: 10,
  Stop: 10,
  StopFailure: 10,
  SessionEnd: 10,
  PreCompact: 10,
  PostCompact: 10,
  Notification: 10,
  Elicitation: 10,
};

function parse(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const args = parse(process.argv.slice(2));
const project = typeof args.project === "string" ? resolve(args.project) : undefined;
const cfgDir = project ? join(project, ".claude") : claudeConfigDir();
const settingsFile = join(cfgDir, "settings.json");
const target = join(cfgDir, "pixel-office");
const ok = (s: string) => console.log(`✔ ${s}`);
const step = (s: string) => console.log(`▸ ${s}`);

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

type HookGroup = { hooks?: { type?: string; command?: string; timeout?: number }[]; [k: string]: unknown };

function stripOurs(settings: Record<string, unknown>) {
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter(
      (g) => !JSON.stringify(g ?? {}).includes(MARKER),
    );
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  settings.hooks = hooks;
}

function uninstall() {
  if (existsSync(settingsFile)) {
    const settings = readJson(settingsFile);
    stripOurs(settings);
    writeJson(settingsFile, settings);
    ok(`hooks removed from ${settingsFile}`);
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    ok(`removed ${target}`);
  }
  if (existsSync(join(claudeConfigDir(), "pixel-office.json"))) {
    console.log(`  config kept: ${join(claudeConfigDir(), "pixel-office.json")} (delete it if you want defaults)`);
  }
}

function build() {
  step("building dist/pixel-office.js");
  const res = spawnSync(process.execPath, ["build.ts"], { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("✖ build failed");
    process.exit(1);
  }
}

function install() {
  const dist = join(ROOT, "dist", "pixel-office.js");
  if (!existsSync(dist)) {
    if (args["no-build"]) {
      console.error(`✖ ${dist} is missing – run "npm run build" or drop --no-build`);
      process.exit(1);
    }
    build();
  }
  step("copying daemon and hook client");
  mkdirSync(target, { recursive: true });
  copyFileSync(join(ROOT, "dist", "pixel-office.js"), join(target, "pixel-office.js"));
  copyFileSync(join(ROOT, "hooks", "pixel-office.mjs"), join(target, "pixel-office.mjs"));
  ok(`installed in ${target}`);

  step("merging hooks into settings.json");
  const settings = readJson(settingsFile);
  stripOurs(settings);
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  const command = `node "${join(target, "pixel-office.mjs")}"`;
  for (const [event, timeout] of Object.entries(EVENTS)) {
    const group: HookGroup = { hooks: [{ type: "command", command, timeout }] };
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
  }
  settings.hooks = hooks;
  writeJson(settingsFile, settings);
  ok(`hooks written to ${settingsFile}`);

  if (typeof args.port === "string") {
    const cfgFile = join(claudeConfigDir(), "pixel-office.json");
    const cfg = readJson(cfgFile);
    cfg.port = Number(args.port);
    writeJson(cfgFile, cfg);
    ok(`port ${args.port} written to ${cfgFile}`);
  }

  console.log("");
  console.log(`  ${project ? "Project" : "Global"} install ready.`);
  console.log(`  Open http://127.0.0.1:4777/ while Claude Code is running.`);
  console.log(`  Restart Claude Code (or review hooks with /hooks) so it reloads settings.json.`);
  if (existsSync(join(cfgDir, "settings.json.bak"))) console.log(`  Backup: ${settingsFile}.bak`);
}

if (args.uninstall) uninstall();
else install();
