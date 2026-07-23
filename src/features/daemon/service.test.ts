import { expect, test } from "vitest";
import { DaemonService, duePhases } from "@/features/daemon/service";

function phase(name: string, everyTicks: number, run = async () => {}) {
  return { name, everyTicks, run };
}

test("every-tick phases run each pass, every-2-ticks phases run on even ticks", () => {
  const phases = [phase("dispatch", 1), phase("landing", 2)];
  expect(duePhases(phases, 0).map((p) => p.name)).toEqual(["dispatch", "landing"]);
  expect(duePhases(phases, 1).map((p) => p.name)).toEqual(["dispatch"]);
  expect(duePhases(phases, 2).map((p) => p.name)).toEqual(["dispatch", "landing"]);
});

test("phases run in declared order and a throwing phase does not skip the rest", async () => {
  const ran: string[] = [];
  const failures: string[] = [];
  const daemon = new DaemonService(
    [
      phase("cleanup", 1, async () => {
        ran.push("cleanup");
      }),
      phase("landing", 2, async () => {
        ran.push("landing");
        throw new Error("build gate exploded");
      }),
      phase("repair", 1, async () => {
        ran.push("repair");
      }),
    ],
    (name, error) => failures.push(`${name}: ${(error as Error).message}`),
  );

  await daemon.runPass();
  await daemon.runPass();

  expect(ran).toEqual(["cleanup", "landing", "repair", "cleanup", "repair"]);
  expect(failures).toEqual(["landing: build gate exploded"]);
  expect(daemon.tick).toBe(2);
});

test("shouldStop skips remaining phases between them, never mid-phase", async () => {
  let stopping = false;
  const ran: string[] = [];
  const daemon = new DaemonService(
    [
      phase("one", 1, async () => {
        ran.push("one");
        // The stop lands while phase one runs; it must still finish.
        stopping = true;
        ran.push("one finished");
      }),
      phase("two", 1, async () => {
        ran.push("two");
      }),
    ],
    () => {},
    () => stopping,
  );

  await daemon.runPass();
  expect(ran).toEqual(["one", "one finished"]);
  expect(daemon.tick).toBe(1);

  // Stop already requested when the next pass starts: nothing runs at all.
  await daemon.runPass();
  expect(ran).toEqual(["one", "one finished"]);
});
