# Review-loop judge rubric

The judge grades one reviewer finding at a time. It sees the finding's path,
the diff hunk GitHub attached, the reviewer's text, and the briefing's
Defect Prevention and Test Integrity sections (rendered from
`packages/core/src/prompts/briefing.render.ts`, so the rubric tracks the
prompt version). It answers three questions as JSON and nothing else.

## 1. `real` — is this a real defect?

`true` when the finding describes wrong behavior, an unhandled failure path,
a race, state corruption, or a test that would pass if the behavior were
wrong, in the code the hunk shows. `false` for style, naming, formatting,
speculative future-proofing, questions, praise, or a claim the hunk
contradicts. When the hunk is too small to tell, answer from the reviewer's
text alone and set `confidence` to `low`.

## 2. `class` — which Defect Prevention class, if any?

One of: `error-paths`, `validation`, `boundaries`, `numeric-logic`,
`concurrency`, `test-integrity`, `scope`, `structure`, `other`. The first five
are the briefing's checklist verbatim; `test-integrity` is its Test
Integrity section; `scope` is work outside the issue; `structure` is the
AGENTS.md layout rules; `other` is anything else, including a non-defect.

## 3. `prevented` — would an implementer who followed the briefing have avoided it?

`true` only when all three hold: `real` is true; the class is one the
briefing names (the first six above); and the defect is in code the PR
added or changed, which the hunk's `+` lines show. A defect in untouched
code, or in a class the briefing does not name, is `false`: the briefing
cannot prevent what it does not instruct.

## Output

```json
{"real": true, "class": "error-paths", "prevented": true, "confidence": "high", "because": "<= 20 words"}
```

## Known negatives

`known-negatives.jsonl` holds synthetic findings that are not defects
(style, questions, praise, a claim the hunk refutes). The judge must answer
`real: false` for each; the false-positive rate on them is reported with
every run.

## Calibration

`calibration.jsonl` holds a sample of corpus items with human labels for the
same three fields. The run reports percent agreement and Cohen's kappa
between judge and human per field. A kappa under 0.6 on `prevented` means
the prevention rate is not yet trustworthy; fix the rubric before reading
the rate. Claude grades Claude here: the human labels are the only check on
that.
