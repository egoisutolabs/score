#!/usr/bin/env bun
// Prints its URL, serves /doc, then runs until killed. Default SIGTERM
// handling (process exits) covers the bounded-clean-stop case.
import { docHandler, startStubServer } from "@score/agents/fixtures/opencode-stub-server";

startStubServer(docHandler);
