# Score guidance

- Use Bun and TypeScript. The repo is a Bun-workspaces + Turborepo monorepo:
  `apps/{daemon,tui,server}` are entry points; `packages/{shared,core,agents,tracker}`
  are libraries. The `score` CLI is `apps/daemon`.
- Keep models as interfaces and types; do not add Zod or any schema-builder
  DSL — interfaces read as the shape directly, schema objects are indirection.
- Name files `<noun>.<role>.ts` — roles: `.service` (stateful class), `.policy`
  (pure decisions), `.render` (output shaping), `.interface` (types/ports),
  `.run` (CLI composition). Types live in the feature that owns them; never
  create a central types/ dump. Pure utility modules (`color.ts`, `log.ts`,
  `verify.ts`) and unique entries (`index.ts`, `doctor.ts`) keep bare names.
- Keep code feature-first: domain phases live in `packages/core/src/<feature>/`;
  ports (`agent-runtime`, `workspace-driver`, `landing/port`, `dispatch/work-source`)
  are owned by core, implementations by `packages/{agents,tracker}`. Known
  exception: `GitService` lives in `packages/core/src/adapters/` beside the
  workspace ports it implements (`WorktreeProvisioner`, `LandingWorkspace`)
  — none of the current packages is a
  sensible home for a local-VCS adapter, and a package for one file isn't either.
- Preserve the three separate legacy boundaries: autopilot, repair, and landing.
- Do not add policy that is absent from `legacy/` when working on parity.
- Structure is part of the work, not an afterthought: new behavior starts in
  a feature folder (`packages/<pkg>/src/<feature>/`) — never accrete
  unrelated modules into one directory. Two or more test fixtures go in
  `<feature>/fixtures/` beside the test that uses them. A folder
  approaching ~10 modules gets split by sub-feature.
- Every feature folder and each package's `src/` keeps an `index.ts` front
  door: a short header comment stating what the feature owns (and refuses
  to do), plus `export *` of its public modules — a table of contents for
  readers. Deep imports stay valid; the front door exists for
  comprehension, not import ceremony. Creating a folder without one, or
  adding a module without re-exporting it, leaves the door stale — update
  it in the same change.
- Comments state constraints and the why — never what the next line does.
  Non-obvious behavior carries its reason at the decision site. If you
  change code that is non-obvious and uncommented, leave it commented as
  part of the change; sweeping unrelated files for comments is scope creep.
- Run `bun run check`, `bun run test`, and `bun run build` from this directory.
- Triage of implementer-found `triage` issues is not daemon code: the procedure
  lives in `.claude/skills/triage/SKILL.md`, run by `.github/workflows/triage.yml`.
  Change the promotion rules there, never in `packages/`.

## Code Review Rules

- Flag only real defects: wrong behavior, unhandled failure paths, races,
  state corruption, tests that would pass even if the behavior were wrong,
  and violations of the rules above (Node instead of Bun, Zod, policy not
  present in legacy/ for parity work, merged legacy boundaries).
- Structure and readability violations are real defects: fixtures outside
  `fixtures/`, new modules dumped outside a feature folder, a new folder
  without an `index.ts` front door, a front door left stale by the diff,
  and changed non-obvious logic left uncommented.
- Violations of `INVARIANTS.md` are real defects: a new multi-step
  external mutation without a rollback/reconcile path proven by a
  next-tick test, an identity shape (session name, branch prefix)
  derived outside `dispatch.identity.ts`, or a push to origin outside
  landing's tick.
- Do not comment on style, formatting, naming taste, or hypothetical
  future-proofing. If it works and is tested, it passes.
- Treat scope creep as a defect: changes unrelated to the PR's stated issue.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
