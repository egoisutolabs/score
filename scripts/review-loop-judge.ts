#!/usr/bin/env bun
/**
 * Offline LLM judge over exported findings (evals/review-loop/rubric.md):
 *
 *   bun scripts/review-loop-judge.ts [--limit N] [--model claude-sonnet-5-5] [--negatives-only]
 *
 * Reads evals/review-loop/corpus.jsonl, known-negatives.jsonl, and
 * calibration.jsonl; runs `claude -p --output-format json` once per item
 * (cached under evals/review-loop/cache by item + rubric + briefing hash);
 * prints the briefing prevention rate, the class mix, the false-positive
 * rate on known negatives, and judge-human agreement on the calibration set.
 * Uses the operator's Claude login; --limit N judges at most N corpus items
 * and N known negatives.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRIEFING_VERSION, renderBriefing } from "../packages/core/src/prompts/briefing.render";
import { createWorkIdentity } from "../packages/core/src/dispatch/dispatch.identity";

const ROOT = join(import.meta.dirname, "..");
const EVALS = join(ROOT, "evals", "review-loop");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const limit = Number(flag("--limit") ?? Number.POSITIVE_INFINITY);
const model = flag("--model") ?? "claude-sonnet-5-5";
const negativesOnly = args.includes("--negatives-only");

interface Item {
  id: string;
  path: string;
  line: number | null;
  hunk: string;
  body: string;
}
interface Verdict {
  real: boolean;
  class: string;
  prevented: boolean;
  confidence: "high" | "low";
  because: string;
}
interface Label {
  id: string;
  real: boolean | null;
  class: string | null;
  prevented: boolean | null;
}

async function jsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

// The briefing sections the rubric grades against, from the live template so
// the rubric tracks BRIEFING_VERSION rather than a stale copy.
const briefing = renderBriefing(
  {
    number: 0,
    title: "",
    body: "",
    labels: [],
    state: "OPEN",
    stateReason: null,
    url: "https://github.com/owner/repo/issues/0",
    comments: [],
  },
  createWorkIdentity("/", {
    number: 0,
    title: "",
    body: "",
    labels: [],
    state: "OPEN",
    stateReason: null,
    url: "https://github.com/owner/repo/issues/0",
    comments: [],
  }, undefined),
  { harness: "claude" },
);
const section = (heading: string) => {
  const start = briefing.indexOf(`## ${heading}`);
  const next = briefing.indexOf("\n## ", start + 1);
  return briefing.slice(start, next === -1 ? undefined : next).trim();
};
const briefingExcerpt = `${section("Defect Prevention")}\n\n${section("Test Integrity")}`;
const rubric = await readFile(join(EVALS, "rubric.md"), "utf8");
const rubricHash = createHash("sha256").update(rubric).update(briefingExcerpt).digest("hex").slice(0, 12);

function prompt(item: Item): string {
  return `${rubric}

---
BRIEFING EXCERPT (version ${BRIEFING_VERSION}):

${briefingExcerpt}

---
FINDING
path: ${item.path}
line: ${item.line ?? "file-level"}
hunk:
${item.hunk}

reviewer text:
${item.body}

Answer with the JSON object only.`;
}

async function judge(item: Item): Promise<Verdict> {
  const cacheDir = join(EVALS, "cache");
  await mkdir(cacheDir, { recursive: true });
  // Keyed by what the judge actually reads, so a re-exported item whose hunk
  // or text changed under the same id is judged again, not served stale.
  const key = createHash("sha256").update(prompt(item)).update(model).digest("hex").slice(0, 16);
  const cached = join(cacheDir, `${key}.json`);
  // A cache written before the validator existed is as untrusted as fresh output.
  if (existsSync(cached)) return parseVerdict(JSON.parse(await readFile(cached, "utf8")), item.id);
  const proc = Bun.spawn(
    ["claude", "-p", prompt(item), "--output-format", "json", "--model", model, "--max-turns", "1"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`claude failed for ${item.id}: ${err.trim() || out.trim()}`);
  const envelope = JSON.parse(out) as { result?: string };
  const text = envelope.result ?? out;
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`no JSON in judge output for ${item.id}: ${text.slice(0, 200)}`);
  const verdict = parseVerdict(JSON.parse(match[0]), item.id);
  await writeFile(cached, JSON.stringify(verdict));
  return verdict;
}

const CLASSES = new Set(["error-paths", "validation", "boundaries", "numeric-logic", "concurrency", "test-integrity", "scope", "structure", "other"]);
const PREVENTABLE = new Set(["error-paths", "validation", "boundaries", "numeric-logic", "concurrency", "test-integrity"]);

/** Model output is untrusted: a verdict off the rubric's shape is a judge error to surface, not a tally to cache. */
function parseVerdict(value: unknown, id: string): Verdict {
  const fail = (why: string): never => {
    throw new Error(`judge verdict for ${id} ${why}: ${JSON.stringify(value)}`);
  };
  if (typeof value !== "object" || value === null) return fail("is not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.real !== "boolean") return fail("has a non-boolean real");
  if (typeof v.class !== "string" || !CLASSES.has(v.class)) return fail("names a class outside the rubric");
  if (typeof v.prevented !== "boolean") return fail("has a non-boolean prevented");
  if (v.confidence !== "high" && v.confidence !== "low") return fail("has a confidence other than high/low");
  if (typeof v.because !== "string") return fail("has a non-string because");
  // Rubric §3: prevented requires a real defect in a class the briefing names.
  if (v.prevented && (!v.real || !PREVENTABLE.has(v.class))) return fail("marks prevented without a real, briefing-named defect");
  return { real: v.real, class: v.class, prevented: v.prevented, confidence: v.confidence, because: v.because };
}

// --limit caps each set, so a bounded run still measures both rates.
const corpus = negativesOnly ? [] : (await jsonl<Item>(join(EVALS, "corpus.jsonl"))).slice(0, limit);
const negatives = (await jsonl<Item>(join(EVALS, "known-negatives.jsonl"))).slice(0, limit);
const labels = new Map((await jsonl<Label>(join(EVALS, "calibration.jsonl"))).map((l) => [l.id, l]));

const verdicts = new Map<string, Verdict>();
for (const item of [...corpus, ...negatives]) {
  verdicts.set(item.id, await judge(item));
  process.stderr.write(`judged ${verdicts.size}/${corpus.length + negatives.length}\r`);
}
process.stderr.write("\n");

const pct = (a: number, b: number) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
console.log(`model ${model}  briefing ${BRIEFING_VERSION}  rubric+briefing ${rubricHash}`);
if (corpus.length > 0) {
  const real = corpus.filter((i) => verdicts.get(i.id)?.real).length;
  const prevented = corpus.filter((i) => verdicts.get(i.id)?.prevented).length;
  const classes: Record<string, number> = {};
  for (const i of corpus) {
    const c = verdicts.get(i.id)?.class ?? "?";
    classes[c] = (classes[c] ?? 0) + 1;
  }
  console.log(`corpus: ${corpus.length} findings  judged real: ${pct(real, corpus.length)}  prevented by briefing: ${pct(prevented, corpus.length)} (${pct(prevented, real)} of real)`);
  console.log("classes:", JSON.stringify(classes));
}
const fp = negatives.filter((i) => verdicts.get(i.id)?.real).length;
console.log(`known negatives: ${negatives.length}  judged real (false positives): ${fp} (${pct(fp, negatives.length)})`);
for (const i of negatives) {
  const v = verdicts.get(i.id);
  if (v?.real) console.log(`  FP ${i.id}: ${v.because}`);
}

// Agreement with human labels on the calibration subset, per field.
function kappa(pairs: readonly (readonly [string, string])[]): number {
  const n = pairs.length;
  if (n === 0) return Number.NaN;
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const cats = new Set(pairs.flat());
  let expected = 0;
  for (const c of cats) {
    const pa = pairs.filter(([a]) => a === c).length / n;
    const pb = pairs.filter(([, b]) => b === c).length / n;
    expected += pa * pb;
  }
  return expected === 1 ? 1 : (agree - expected) / (1 - expected);
}
const labeled = [...labels.values()].filter((l) => verdicts.has(l.id));
for (const field of ["real", "prevented", "class"] as const) {
  const pairs = labeled
    .filter((l) => l[field] !== null)
    .map((l) => [String(l[field]), String(verdicts.get(l.id)?.[field])] as const);
  if (pairs.length === 0) {
    console.log(`agreement on ${field}: no human labels yet — fill evals/review-loop/calibration.jsonl`);
    continue;
  }
  const agree = pairs.filter(([a, b]) => a === b).length;
  console.log(`agreement on ${field}: ${pct(agree, pairs.length)} over ${pairs.length}  kappa ${kappa(pairs).toFixed(2)}`);
}
