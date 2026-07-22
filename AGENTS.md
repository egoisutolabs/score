# Score guidance

- Use Bun and TypeScript.
- Keep models as interfaces and types; do not add Zod.
- Keep code feature-first under `src/features/`.
- Preserve the three separate legacy boundaries: autopilot, repair, and landing.
- Do not add policy that is absent from `legacy/` when working on parity.
- Run `bun run check`, `bun run test`, and `bun run build` from this directory.
