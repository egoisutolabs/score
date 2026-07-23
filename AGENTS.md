# Score guidance

- Use Bun and TypeScript.
- Keep models as interfaces and types; do not add Zod or any schema-builder
  DSL — interfaces read as the shape directly, schema objects are indirection.
- Keep code feature-first under `src/features/`.
- Preserve the three separate legacy boundaries: autopilot, repair, and landing.
- Do not add policy that is absent from `legacy/` when working on parity.
- Run `bun run check`, `bun run test`, and `bun run build` from this directory.

## Code Review Rules

- Flag only real defects: wrong behavior, unhandled failure paths, races,
  state corruption, tests that would pass even if the behavior were wrong,
  and violations of the rules above (Node instead of Bun, Zod, policy not
  present in legacy/ for parity work, merged legacy boundaries).
- Do not comment on style, formatting, naming taste, or hypothetical
  future-proofing. If it works and is tested, it passes.
- Treat scope creep as a defect: changes unrelated to the PR's stated issue.
