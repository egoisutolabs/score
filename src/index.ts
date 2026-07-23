import { runConfigInit } from "@/features/config/template";
import { runDaemon } from "@/features/daemon/run";
import { runRepair } from "@/features/repair/run";
import { runDoctor } from "@/features/supervisor/doctor";
import { runDown, runUp } from "@/features/supervisor/run";
import { color } from "@/shared/color";

const [command, ...args] = process.argv.slice(2);

try {
  // No subcommand = the daemon. `repair` stays as the "go fix PR 12 now" escape
  // hatch; autopilot and landing are phases of the daemon now.
  if (command === "repair") await runRepair(args);
  else if (command === "up") await runUp(args);
  else if (command === "down") await runDown(args);
  else if (command === "doctor") await runDoctor();
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
