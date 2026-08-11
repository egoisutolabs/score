#!/usr/bin/env bun
// Becomes ready, then exits on its own — the unexpected-exit case.
import { docHandler, startStubServer } from "@score/agents/opencode-stub-server";

startStubServer(docHandler);
setTimeout(() => process.exit(0), 150);
