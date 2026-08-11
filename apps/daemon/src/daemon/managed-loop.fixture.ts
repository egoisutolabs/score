// Spawned-child fixture for the managed shutdown contract: an interruptible
// polling loop over fake phases, with the same status wiring as runDaemon.
// Usage: bun managed-loop.fixture.ts <sleep|midpass|opencode-sleep|opencode-midpass> <statusPath>
//
// The opencode-* modes fire a fake unexpected-exit through the same
// requestStop() seam runDaemonLoop wires up for a real OpencodeServerHandle,
// so the wake-immediately / settle-then-skip / fatal-exit contract is proven
// without spawning a real opencode binary.
import type { DaemonPhase } from "@score/core/daemon/daemon.service";
import { DaemonService } from "@score/core/daemon/daemon.service";
import { StatusWriter } from "@score/core/daemon/status.service";
import { runPollingLoop } from "@score/shared/legacy-runtime";

const MODES = ["sleep", "midpass", "opencode-sleep", "opencode-midpass"] as const;
type Mode = (typeof MODES)[number];

const [mode, statusFile] = process.argv.slice(2);
if (!MODES.includes(mode as Mode) || statusFile === undefined) {
  throw new Error(`usage: managed-loop.fixture.ts <${MODES.join("|")}> <statusPath>`);
}
const midpass = mode === "midpass" || mode === "opencode-midpass";
const opencode = mode === "opencode-sleep" || mode === "opencode-midpass";

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
  [phase("one", midpass ? 700 : 0), phase("two", 0), phase("three", 0)],
  () => {},
  () => stopping,
);

// Fires well inside the 700ms mid-phase window or the idle sleep, whichever
// this mode exercises — a fake stand-in for OpencodeServerHandle.
const handle = opencode
  ? {
      unexpectedExit: new Promise<void>((resolve) => {
        setTimeout(resolve, mode === "opencode-midpass" ? 150 : 200);
      }),
      stop: async () => {
        console.log("handle stop called");
      },
    }
  : undefined;

let childError: Error | undefined;
try {
  await status.write({ state: "starting" });
  try {
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
        ...(handle !== undefined && {
          onReady: (requestStop: () => void) => {
            handle.unexpectedExit.then(() => {
              childError = new Error("fixture child exited unexpectedly");
              requestStop();
            });
          },
        }),
      },
    );
  } finally {
    await handle?.stop();
  }
  if (childError) throw childError;
  console.log("clean exit");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`fatal: ${message}`);
  await status.write({ last_error: message }).catch(() => {});
  process.exitCode = 1;
} finally {
  await status.settle();
}
