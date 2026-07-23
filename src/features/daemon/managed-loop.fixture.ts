// Spawned-child fixture for the managed shutdown contract: an interruptible
// polling loop over fake phases, with the same status wiring as runDaemon.
// Usage: bun managed-loop.fixture.ts <sleep|midpass> <statusPath>
import type { DaemonPhase } from "@/features/daemon/service";
import { DaemonService } from "@/features/daemon/service";
import { StatusWriter } from "@/features/daemon/status";
import { runPollingLoop } from "@/shared/legacy-runtime";

const [mode, statusFile] = process.argv.slice(2);
if ((mode !== "sleep" && mode !== "midpass") || statusFile === undefined) {
  throw new Error("usage: managed-loop.fixture.ts <sleep|midpass> <statusPath>");
}

const status = new StatusWriter(statusFile);
let stopping = false;

const phase = (name: string, delayMs: number): DaemonPhase => ({
  name,
  everyTicks: 1,
  run: async () => {
    console.log(`phase ${name} start`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    console.log(`phase ${name} done`);
  },
});

// midpass: the first phase is slow enough for the test to signal mid-flight.
const daemon = new DaemonService(
  [phase("one", mode === "midpass" ? 700 : 0), phase("two", 0), phase("three", 0)],
  () => {},
  () => stopping,
);

await status.write({ state: "starting" });
await runPollingLoop(
  async () => {
    await status.write({ state: "running", tick: daemon.tick });
    await daemon.runPass();
    console.log(`pass ${daemon.tick - 1} end`);
  },
  false,
  60_000,
  {
    interruptible: true,
    onStopRequested: () => {
      stopping = true;
      void status.write({ state: "stopping" }).catch(() => {});
    },
  },
);
await status.settle();
console.log("clean exit");
