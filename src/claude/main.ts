// Entry point. Started by the hooks on demand (`node dist/pixel-office.js`), or by hand.

import { loadConfig } from "../config.ts";
import { createDaemon } from "./daemon.ts";

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    const v = inline ?? argv[i + 1];
    if (inline === undefined && (v === undefined || v.startsWith("--"))) out[k] = "true";
    else {
      out[k] = v;
      if (inline === undefined) i++;
    }
  }
  return out;
}

const cli = args(process.argv.slice(2));
const cfg = loadConfig({
  port: cli.port,
  host: cli.host,
  token: cli.token,
  debug: cli.debug,
  hookTimeout: cli["hook-timeout"],
  idleExit: cli["idle-exit"],
});

const log = (line: string) => {
  const msg = `[pixel-office] ${line}`;
  if (process.env.CLAUDE_PIXEL_OFFICE_DAEMON === "1") return; // detached: nobody listens
  console.log(msg);
};

try {
  const daemon = await createDaemon(cfg, log);
  const url = `http://${cfg.host}:${cfg.port}/${cfg.token ? "?token=" + encodeURIComponent(cfg.token) : ""}`;
  console.log(`Claude Pixel Office: ${url}`);
  console.log(`hooks → ${cfg.hookTimeoutMs / 1000}s permission timeout`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await daemon.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} catch (err) {
  if ((err as { code?: string }).code === "EADDRINUSE") {
    log(`port ${cfg.port} already served by another daemon – reusing it`);
    process.exit(0);
  }
  console.error(`[pixel-office] could not start: ${String(err)}`);
  process.exit(1);
}
