import { color } from "@score/shared/color";
import { runConfigInit } from "@score/shared/config/template";
import { runDaemon } from "./daemon/daemon.run";
import { runRepair } from "./repair/repair.run";
import { runDoctor } from "./supervisor/doctor";
import { runDown, runRestart, runUp } from "./supervisor/supervisor.run";

const [command, ...args] = process.argv.slice(2);

try {
  // No subcommand = the daemon. `repair` stays as the "go fix PR 12 now" escape
  // hatch; autopilot and landing are phases of the daemon now.
  if (command === "repair") await runRepair(args);
  else if (command === "up") await runUp(args);
  else if (command === "down") await runDown(args);
  else if (command === "restart") await runRestart(args);
  else if (command === "doctor") await runDoctor();
  // Dynamic import keeps OpenTUI out of the daemon/supervisor code paths.
  else if (command === "tui") await (await import("@score/tui/app")).runTui(args);
  else if (command === "config") {
    if (args[0] !== "init" || args.length > 1) throw new Error("usage: score config init");
    await runConfigInit();
  } else if (command === "daemon") await runDaemon(args);
  else await runDaemon(command === undefined ? args : [command, ...args]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(color.red(`[${new Date().toISOString()}] [error] ${message}`));
  process.exitCode = message.startsWith("unknown flag:") ? 2 : 1;
}
