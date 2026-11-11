// Daemon configuration. Precedence: env vars > CLI flags > ~/.claude/pixel-office.json > defaults.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  token?: string;
  /** extra host names accepted without a token (e.g. a Tailscale MagicDNS name) */
  allowedHosts: string[];
  /** append hook samples to <claude dir>/pixel-office.log (contains prompts and commands) */
  debug: boolean;
  /** how long a PermissionRequest hook waits for an answer from the UI */
  hookTimeoutMs: number;
  /** exit after this many minutes without a hook if > 0 (the next hook restarts the daemon) */
  idleExitMinutes: number;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const list = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  const s = str(v);
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
};

const flag = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  const s = str(v)?.toLowerCase();
  return s === undefined ? undefined : ["1", "true", "yes", "on"].includes(s);
};

const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return str(env.CLAUDE_CONFIG_DIR) ?? join(homedir(), ".claude");
}

export const CONFIG_FILE = "pixel-office.json";

/** `<claude dir>/pixel-office.json`; missing or broken files are ignored */
export function readConfigFile(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(claudeConfigDir(env), CONFIG_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function loadConfig(
  opts: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
  file: Record<string, unknown> = readConfigFile(env),
): Config {
  const port = num(env.CLAUDE_PIXEL_OFFICE_PORT ?? opts.port ?? file.port, 1, 65535) ?? 4777;
  return {
    port,
    host: str(env.CLAUDE_PIXEL_OFFICE_HOST) ?? str(opts.host) ?? str(file.host) ?? "127.0.0.1",
    token: str(env.CLAUDE_PIXEL_OFFICE_TOKEN) ?? str(opts.token) ?? str(file.token),
    allowedHosts:
      list(env.CLAUDE_PIXEL_OFFICE_ALLOWED_HOSTS) ?? list(opts.allowedHosts) ?? list(file.allowedHosts) ?? [],
    debug: flag(env.CLAUDE_PIXEL_OFFICE_DEBUG) ?? flag(opts.debug) ?? flag(file.debug) ?? false,
    // the setting is in seconds; hooks.json must use a slightly larger timeout
    hookTimeoutMs:
      (num(env.CLAUDE_PIXEL_OFFICE_HOOK_TIMEOUT, 5, 3600) ?? num(opts.hookTimeout, 5, 3600) ??
        num(file.hookTimeout, 5, 3600) ?? 120) * 1000,
    idleExitMinutes: num(env.CLAUDE_PIXEL_OFFICE_IDLE_EXIT, 0, 10080) ?? num(opts.idleExit, 0, 10080) ??
      num(file.idleExit, 0, 10080) ?? 0,
  };
}
