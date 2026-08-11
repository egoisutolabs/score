#!/usr/bin/env bun
// Prints its URL immediately but /doc never answers — exercises the readiness
// timeout (also covers "delays readiness past the deadline").
import { startStubServer } from "@score/agents/opencode-stub-server";

startStubServer(() => new Response("not found", { status: 404 }));
