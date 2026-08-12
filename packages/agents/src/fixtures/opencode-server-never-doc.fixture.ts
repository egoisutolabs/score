#!/usr/bin/env bun
// Prints its URL immediately but every request hangs forever — /doc never
// answers, exercising the poll's per-request abort timeout (not just a fast
// failure), and covers "delays readiness past the deadline".
import { startStubServer } from "@score/agents/fixtures/opencode-stub-server";

startStubServer(() => new Promise<Response>(() => {}));
