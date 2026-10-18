# Review loop analysis

Notes from the brainstorming session of 2026-10-12 to 2026-10-16. Written in ASD-STE100.
No code was changed. The order of work is at the end.

## 1. Why the agent does not converge

We read two papers and the review threads of 25 pull requests:

- arXiv 2609.20804, "An Empirical Study of Harness Design for Coding Agents"
- arXiv 2609.35738, "Harness Learning Enables Generalizable Test-Time Adaptation"

The review threads contain 377 findings. The first round of each pull request
shows first-draft defects. The later rounds show a different pattern.
Approximately 90 percent of the findings in round two and later come from the
previous fix. The agent patches the example that the reviewer gives. It does
not find the class of the defect. Each patch adds a new mechanism, and each new
mechanism gets a new finding.

The root cause is not the model and not the reviewers. The root cause is the
repair loop in score:

- The repair prompt tells the agent to fix each unresolved thread and resolve
  it. It does not tell the agent to triage, to sweep the diff for the same
  class, or to decline a finding.
- The repair loop pings the agent again 60 seconds after the thread count
  changes. This happens before the reviewers complete.
- Fix commits land one to five minutes after a review. A full verification
  takes three to five minutes. The agent does not run verification before it
  pushes.
- The agent resolves its own threads. The landing gate counts the open threads
  only. The agent satisfies the gate itself.
- The landing tick merges when the Claude check is green. It does not wait for
  Codex. Approximately 30 findings merged while open.
- The briefing makes review follow-up a separate session with no context.

Pull request 99 is the example. The issue asks for one wait on the launchd
drain. The agent writes a file lock. Eight rounds later the pull request has
394 new lines, and a human closes it.

The paper on harness design agrees with this. The fixed part of its harness
stops a run after eight identical failing commands. It does not make the agent
smarter. The second paper trains a proposer to edit the harness. We do not need
that. The untrained proposer in that paper makes most harnesses worse.

## 2. What we change in the review loop

### 2.1 The repair protocol

Change the repair protocol first. The convergence gate is a safety net under
it. The protocol is one wave per review round:

1. Read all open findings. Mark each finding as fix or decline. Give a reason
   for each decline.
2. Name the class of each defect. Search the full diff for the same class.
3. For each changed mutation, list the failure paths.
4. Prefer to delete a mechanism over adding one.
5. Write a test that fails on the tree before the fix.
6. Run verification before the push.
7. Make one commit for the wave.

P2 findings in new code are fix or decline. They do not go to triage issues.
Triage issues are for pre-existing defects only, and the agent must search for
a duplicate before it files one. This keeps the issue list clean.
Approximately 8 percent of the findings were declines, and the Claude reviewer
accepted them.

### 2.2 The repair gate and the round budget

Do not ping while a check on the head commit is pending. Give each pull
request a round budget. When the budget is used, stop the pings, mark the pull
request, and post one comment with the wave history. A human then decides.

Do not close the pull request. A closed pull request loses the diff. Both
closed pull requests were redone from the start.

### 2.3 The convergence signal

Most of the convergence signal is in data that score already has. No model is
necessary for these four rules:

- The findings per wave do not decrease for two waves.
- The diff grows with each wave.
- Blame shows that a finding cites a line that the last fix commit added.
- The round count reaches the budget.

A classifier such as jev adds value where the rules stop:

- Is this finding real?
- Is it in the scope of the issue?
- Is the decline reason correct?
- Does this fix add a new mechanism?

These are typed questions with one probability each. Put jev behind a port
with a deterministic default. It is in early access and has no public
benchmarks.

An orchestrator that is an LLM does not remove this problem. The live session
had the full context and did eight rounds. The mandate caused the rounds, not
the lack of context. A deterministic tick with typed decisions at the policy
gaps is the better shape. It keeps the next-tick proofs and the replayable
decisions.

### 2.4 New findings and old findings

Distinguish new findings from old findings with a ledger. Blame the cited line
on the head commit to get its origin commit. Add the file and the enclosing
symbol. This makes a key for each finding. Keep the keys per pull request
across waves.

| Key match | Origin commit | Meaning |
|---|---|---|
| A thread that the agent resolved | Before the last fix | The fix failed. The self-resolve was wrong. |
| An open thread from the other reviewer | Any | Duplicate. Count it one time. |
| None | The last fix commit | Regression from the fix. |
| None | The first commits | The reviewer missed it before. Not the agent's fault. |

Blame fails when the agent rewrites a function. Move detection recovers some
cases. The rest is a pair question: is finding B the same defect as finding A?
This is a good question for a classifier.

The ledger works only if a self-resolve does not count. A thread is closed
when its author or a reviewer pass closes it.

### 2.5 Codex is a black box

Codex has no prompt that we control, no check run, and no API. It leaves
review comments with a path, a line, a badge, and a commit id. It leaves one
review per run. It reads AGENTS.md.

- The ledger uses the comments only. It does not need Codex to cooperate.
- The landing tick waits for a Codex review on the head commit, or for a
  settle timeout. Confirm that Codex posts a review on a clean run.
- A rule in AGENTS.md can ask Codex to reply in an existing thread. Do not
  depend on it.
- If the regurgitation stays high, run the Codex CLI in a workflow with our
  own prompt. Then both reviewers follow one protocol.

## 3. Prompts and evals

Move the prompts to one folder. There are five prompt sites in score, plus the
reviewer prompt and the AGENTS.md rules. Put one render module per prompt in a
prompts feature folder with a front door. Give each prompt a version from its
content hash. Keep the templates as TypeScript. Vitest cannot import text
files.

Set up evals in three tiers:

1. Deterministic contract tests. These exist for the briefing. Add them for
   each prompt.
2. An offline suite with an LLM judge. Use the 377 labeled findings. Measure
   the prevention rate of the briefing and the plan quality of the repair
   prompt on real review waves. Run the judge through the Claude CLI with JSON
   output. Use a concrete rubric, known negatives, and a calibration set with
   human labels.
3. Online metrics from the attempt records: rounds per pull request, the share
   of late-round regressions, and the findings that merged open.

The Weco run tuned the briefing only. The multiplier is the repair prompt.
Tune that one next.

## 4. Remote hosts with Tailscale

Keep one daemon as the brain. One daemon per device is not correct. It causes
double dispatch.

- Add a host field to each project.
- Add an SSH command runner that decorates the command runner.
- Add a host-files port for the direct file calls.
- All paths become host paths.
- Refuse opencode with a remote host at preflight.
- Keep the API on loopback. Use tailscale serve or an SSH tunnel.

Known risks:

- An SSH timeout kills the client but not the remote process.
- tmux, the claude login, and the gh auth must exist on the host.

## 5. Order of work

1. The repair protocol.
2. The ledger and the landing wait.
3. The convergence gate.
4. The prompts folder with evals.
5. Tailscale.
