import type { CleanupResult } from "@score/core/cleanup/cleanup-result.interface";
import type {
  DispatchCapacity,
  DispatchResult,
} from "@score/core/dispatch/dispatch-result.interface";
import { renderMaintenanceTick } from "@score/core/maintenance/maintenance.render";
import type { MaintenanceTickResult } from "@score/core/maintenance/maintenance.service";
import { expect, test } from "vitest";

function capacity(overrides: Partial<DispatchCapacity> = {}): DispatchCapacity {
  return { active: 0, max: 2, heldBy: [], starved: false, ...overrides };
}

function dispatch(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    started: [],
    planned: [],
    blocked: [],
    failed: [],
    capacity: capacity(),
    ...overrides,
  };
}

function tick(
  dispatchResult: DispatchResult,
  cleanup: readonly CleanupResult[] = [],
): MaintenanceTickResult {
  return { cleanup, dispatch: dispatchResult };
}

test("a starved zero-capacity tick logs which worktrees hold the slots (#65)", () => {
  const lines = renderMaintenanceTick(
    tick(
      dispatch({
        capacity: capacity({
          active: 3,
          max: 3,
          heldBy: ["issue-21-stale-holder", "issue-34-live-holder", "issue-60-waiting-on-review"],
          starved: true,
        }),
      }),
    ),
  );

  expect(lines).toEqual([
    {
      level: "warn",
      text: "⚠ dispatch at capacity (3/3): no slot free for eligible issues — held by issue-21-stale-holder, issue-34-live-holder, issue-60-waiting-on-review",
    },
  ]);
});

test("a normal tick with a start renders exactly its usual lines — no capacity line (#65)", () => {
  const lines = renderMaintenanceTick(
    tick(
      dispatch({
        started: [2],
        capacity: capacity({ active: 1, max: 2, heldBy: ["issue-5-already-running"] }),
      }),
    ),
  );

  expect(lines).toEqual([
    { level: "info", text: "✓ started issue #2" },
    { level: "info", text: "tick: cleaned=0 started=1 failed=0" },
  ]);
});

test("a quiet non-starved tick still renders nothing at all", () => {
  expect(renderMaintenanceTick(tick(dispatch()))).toEqual([]);
});

test("a starved tick renders its cleanup lines and the capacity line", () => {
  const lines = renderMaintenanceTick(
    tick(
      dispatch({
        capacity: capacity({ active: 1, max: 1, heldBy: ["issue-21-stale-holder"], starved: true }),
      }),
      [
        {
          pullRequestNumber: 9,
          action: "CLEANED",
        },
      ],
    ),
  );

  expect(lines).toEqual([
    { level: "info", text: "✓ cleaned merged PR #9" },
    {
      level: "warn",
      text: "⚠ dispatch at capacity (1/1): no slot free for eligible issues — held by issue-21-stale-holder",
    },
    { level: "info", text: "tick: cleaned=1 started=0 failed=0" },
  ]);
});

test("an auto-pull refusal renders as a loud warn every tick (#91)", () => {
  const lines = renderMaintenanceTick(
    tick(dispatch(), [
      {
        action: "AUTO_PULL_REFUSED",
        message: "primary checkout is not clean: apps/web/.next/cache/a",
      },
    ]),
  );

  expect(lines).toEqual([
    {
      level: "warn",
      text: "⚠ auto-pull of main refused: primary checkout is not clean: apps/web/.next/cache/a",
    },
  ]);
});
