import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { expect, test } from "vitest";
import type { StreamOutcome } from "../telemetry/stream/stream.service";
import { StreamResponseService } from "./stream.service";

class FakeRequest extends EventEmitter {
  aborted = false;
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly writes: string[] = [];
  readonly headers = new Map<string, string>();
  statusCode = 0;
  backpressure = true;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  flushHeaders(): void {}

  write(value: string): boolean {
    this.writes.push(value);
    if (this.backpressure) {
      this.backpressure = false;
      return false;
    }
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }
}

interface Harness {
  readonly request: FakeRequest;
  readonly response: FakeResponse;
  readonly service: StreamResponseService;
  readonly outcome: Extract<StreamOutcome, { readonly kind: "stream" }>;
  readonly state: { advanced: number; closed: number; finalized: number };
}

function harness(): Harness {
  const request = new FakeRequest();
  const response = new FakeResponse();
  const service = new StreamResponseService();
  const state = { advanced: 0, closed: 0, finalized: 0 };
  return {
    request,
    response,
    service,
    state,
    outcome: {
      kind: "stream",
      frames: async function* () {
        try {
          state.advanced += 1;
          yield "one";
          state.advanced += 1;
          yield "two";
        } finally {
          state.finalized += 1;
        }
      },
      close: () => {
        state.closed += 1;
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

test("a false write pauses generator advancement until drain", async () => {
  const test = harness();
  const sending = test.service.send(
    test.request as unknown as Request,
    test.response as unknown as Response,
    test.outcome,
  );
  await waitFor(() => test.response.writes.length === 1);
  expect(test.state.advanced).toBe(1);
  test.response.emit("drain");
  await sending;

  expect(test.response.writes).toEqual(["one", "two"]);
  expect(test.state.closed).toBe(1);
  expect(test.state.finalized).toBe(1);
  expect(test.response.writableEnded).toBe(true);
});

test("a close racing backpressure stops writes and finalizes exactly once", async () => {
  const test = harness();
  const sending = test.service.send(
    test.request as unknown as Request,
    test.response as unknown as Response,
    test.outcome,
  );
  await waitFor(() => test.response.writes.length === 1);
  test.response.destroyed = true;
  test.response.emit("close");
  await sending;

  expect(test.response.writes).toEqual(["one"]);
  expect(test.state.closed).toBe(1);
  expect(test.state.finalized).toBe(1);
});

test("request abort and response close share one cleanup path", async () => {
  const test = harness();
  const sending = test.service.send(
    test.request as unknown as Request,
    test.response as unknown as Response,
    test.outcome,
  );
  await waitFor(() => test.response.writes.length === 1);
  test.request.aborted = true;
  test.request.emit("aborted");
  test.response.destroyed = true;
  test.response.emit("close");
  await sending;

  expect(test.state.closed).toBe(1);
  expect(test.state.finalized).toBe(1);
});

test("a client gone before header setup still finalizes without writing", async () => {
  const test = harness();
  test.request.aborted = true;
  test.response.destroyed = true;

  await test.service.send(
    test.request as unknown as Request,
    test.response as unknown as Response,
    test.outcome,
  );

  expect(test.response.statusCode).toBe(0);
  expect(test.response.writes).toEqual([]);
  expect(test.state.closed).toBe(1);
  expect(test.state.finalized).toBe(0);
});

test("a stream handed off after shutdown starts is closed before headers", async () => {
  const test = harness();
  test.service.closeAll();

  await test.service.send(
    test.request as unknown as Request,
    test.response as unknown as Response,
    test.outcome,
  );

  expect(test.response.statusCode).toBe(0);
  expect(test.response.writes).toEqual([]);
  expect(test.response.writableEnded).toBe(true);
  expect(test.state.closed).toBe(1);
  expect(test.state.advanced).toBe(0);
});
