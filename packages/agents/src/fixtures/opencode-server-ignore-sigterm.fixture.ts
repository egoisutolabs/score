#!/usr/bin/env bun
// Becomes ready, then swallows SIGTERM — forces stop()'s SIGKILL escalation.
import { docHandler, startStubServer } from "@score/agents/fixtures/opencode-stub-server";

process.on("SIGTERM", () => {});
startStubServer(docHandler);
