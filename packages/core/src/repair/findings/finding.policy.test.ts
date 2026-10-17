import { expect, test } from "vitest";
import type { FindingRecord, ReviewThreadObservation } from "./finding.interface";
import {
  classifyFinding,
  enclosingSymbol,
  findingKey,
  isReviewerBot,
  resolutionOf,
} from "./finding.policy";

test("a finding is a thread a bot reviewer opened; a human's or an unnamed author's is not", () => {
  expect(isReviewerBot("chatgpt-codex-connector[bot]")).toBe(true);
  expect(isReviewerBot("claude")).toBe(true);
  expect(isReviewerBot("coderabbitai")).toBe(true);
  expect(isReviewerBot("gendev1")).toBe(false);
  expect(isReviewerBot(undefined)).toBe(false);
});

const TS_SOURCE = `import x from "y";

export class LaunchdService implements Supervisor {
  readonly #runner: Runner;

  async install(definition: Definition): Promise<void> {
    const path = plistPath(definition);
    if (existsSync(path)) {
      await rm(path);
    }
  }

  #render(): string {
    return "";
  }
}

export function plistPath(definition: Definition): string {
  return join(definition.dir, "job.plist");
}

const handler = async (event: Event) => {
  await handle(event);
};
`;

test("enclosingSymbol picks the innermost declaration above the line, method before class", () => {
  expect(enclosingSymbol(TS_SOURCE, 9)).toBe("install");
  expect(enclosingSymbol(TS_SOURCE, 14)).toBe("render");
  expect(enclosingSymbol(TS_SOURCE, 19)).toBe("plistPath");
  expect(enclosingSymbol(TS_SOURCE, 23)).toBe("handler");
  // Inside the class but above any method: the class itself.
  expect(enclosingSymbol(TS_SOURCE, 4)).toBe("LaunchdService");
  // Above every declaration: nothing to name.
  expect(enclosingSymbol(TS_SOURCE, 1)).toBeUndefined();
});

test("enclosingSymbol understands Python, Go, and Rust declarations and skips control flow", () => {
  expect(enclosingSymbol("def load(path):\n    if path:\n        return 1\n", 3)).toBe("load");
  expect(
    enclosingSymbol('func (s *Store) Save(k string) error {\n\tif k == "" {\n\t\treturn nil\n', 3),
  ).toBe("Save");
  expect(
    enclosingSymbol("pub fn parse(input: &str) -> Result<()> {\n    for c in input {\n    }\n", 2),
  ).toBe("parse");
  // A bare `if (` line must not be mistaken for a method.
  expect(enclosingSymbol("  if (ready) {\n    go();\n  }\n", 2)).toBeUndefined();
  // A call taking a callback is not a method declaration; a multi-line
  // parameter list still names the method.
  expect(enclosingSymbol("  useEffect(() => {\n    go();\n  });\n", 2)).toBeUndefined();
  expect(enclosingSymbol("  save(\n    k: string,\n  ): void {\n    go();\n", 4)).toBe("save");
});

test("findingKey prefers the blame origin and falls back to the reviewed commit and line", () => {
  const thread = { originalCommit: "rev1", path: "a/b.ts", originalLine: 12 };
  expect(findingKey("orig", thread, "fn")).toBe("orig:a/b.ts:fn");
  expect(findingKey(undefined, thread, undefined)).toBe("rev1:a/b.ts:L12");
  expect(
    findingKey(undefined, { ...thread, originalCommit: undefined, originalLine: null }, undefined),
  ).toBe("unknown:a/b.ts:L0");
});

function thread(overrides: Partial<ReviewThreadObservation> = {}): ReviewThreadObservation {
  return {
    id: "T",
    path: "a.ts",
    originalLine: 1,
    originalCommit: "c1",
    author: "chatgpt-codex-connector",
    createdAt: "2026-10-16T00:00:00Z",
    isResolved: false,
    resolvedBy: undefined,
    ...overrides,
  };
}

test("resolutionOf: a reviewer or bot close counts, the operator token's close is a self-resolve", () => {
  expect(resolutionOf(thread())).toBe("open");
  expect(resolutionOf(thread({ isResolved: true, resolvedBy: "chatgpt-codex-connector" }))).toBe(
    "reviewer-resolved",
  );
  expect(resolutionOf(thread({ isResolved: true, resolvedBy: "claude[bot]" }))).toBe(
    "reviewer-resolved",
  );
  expect(resolutionOf(thread({ isResolved: true, resolvedBy: "gendev1" }))).toBe("self-resolved");
  // Resolved by nobody GitHub can name: still not a reviewer's close.
  expect(resolutionOf(thread({ isResolved: true, resolvedBy: undefined }))).toBe("self-resolved");
});

function record(overrides: Partial<FindingRecord>): FindingRecord {
  return {
    threadId: "P",
    key: "orig:a.ts:fn",
    path: "a.ts",
    symbol: "fn",
    origin: "orig",
    author: "chatgpt-codex-connector",
    createdAt: "",
    class: "first-round",
    wave: 0,
    fromLastFix: false,
    resolution: "open",
    resolvedBy: undefined,
    ...overrides,
  };
}

test("classifyFinding follows the §2.4 table top to bottom", () => {
  const input = { key: "orig:a.ts:fn", author: "claude[bot]", wave: 2, originAfterFirstHead: true };
  expect(classifyFinding({ ...input, wave: 0 }, [])).toBe("first-round");
  expect(classifyFinding(input, [record({ resolution: "self-resolved" })])).toBe("fix-failed");
  expect(classifyFinding(input, [record({ resolution: "open" })])).toBe("duplicate");
  // Same reviewer re-raising its own still-open thread is not a duplicate of itself.
  expect(
    classifyFinding({ ...input, author: "chatgpt-codex-connector" }, [
      record({ resolution: "open" }),
    ]),
  ).toBe("regression-from-fix");
  expect(classifyFinding(input, [record({ resolution: "reviewer-resolved" })])).toBe(
    "regression-from-fix",
  );
  expect(classifyFinding({ ...input, originAfterFirstHead: false }, [])).toBe("missed-earlier");
  // Blame could not place it: the doubt goes to the agent.
  expect(classifyFinding({ ...input, originAfterFirstHead: undefined }, [])).toBe("missed-earlier");
  // A different key never matches, whatever its state.
  expect(classifyFinding(input, [record({ key: "other", resolution: "self-resolved" })])).toBe(
    "regression-from-fix",
  );
});

test("enclosingSymbol skips local bindings but names arrow and function-expression bindings", () => {
  const source =
    "export function outer() {\n  const path = compute(1);\n  return path;\n}\nconst run = (a: number): void => {\n  go(a);\n};\nconst legacy = function () {\n  go();\n};\n";
  expect(enclosingSymbol(source, 3)).toBe("outer");
  expect(enclosingSymbol(source, 6)).toBe("run");
  expect(enclosingSymbol(source, 9)).toBe("legacy");
});
