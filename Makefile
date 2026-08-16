# Score's own implementation of the fleet contract: every target project
# exposes `make verify` (see packages/core/src/verify.ts).
# Install first: landing runs this on a staged merge tree whose dependency
# set may differ from whatever the primary checkout last installed (#98).
# Frozen: lockfile drift is a gate failure, never repaired silently.
.PHONY: verify
verify:
	bun install --frozen-lockfile && bun run check && bun run test && bun run build
