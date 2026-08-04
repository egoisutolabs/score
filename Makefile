# Score's own implementation of the fleet contract: every target project
# exposes `make verify` (see packages/core/src/verify.ts).
.PHONY: verify
verify:
	bun run check && bun run test && bun run build
