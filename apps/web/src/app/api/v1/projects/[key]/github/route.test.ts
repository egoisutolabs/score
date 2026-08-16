import { afterEach, expect, test } from "vitest";
import { GithubUnconfiguredError, setGithubObserver } from "../../../../../../fleet/github.service";
import { DELETE, dynamic, GET, PATCH, POST, PUT, runtime } from "./route";

// The observer seam keeps gh out of tests entirely — a shelled-out gh call
// here would hang on auth or hit the network.
afterEach(() => setGithubObserver(null));

function get(key: string): Promise<Response> {
  return GET(new Request(`http://127.0.0.1/api/v1/projects/${key}/github`), {
    params: Promise.resolve({ key }),
  });
}

const OBSERVATION = {
  prs: [
    {
      number: 42,
      title: "landing: soak timer",
      isDraft: false,
      mergeable: "CONFLICTING",
      reviewDecision: "APPROVED",
      checksFailing: 1,
      checksPending: 0,
      checksTotal: 6,
    },
  ],
  openIssues: 12,
  fetchedAt: "2026-08-16T12:00:00.000Z",
};

test("GET returns the observation in the v1 envelope", async () => {
  setGithubObserver(async () => OBSERVATION);
  const res = await get("alpha");
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  expect(body.api_version).toBe("v1");
  expect(body.data).toEqual(OBSERVATION);
  expect(body.warnings).toEqual([]);
});

test("unconfigured project → 409 GITHUB_UNCONFIGURED, enum only", async () => {
  setGithubObserver(async (key) => {
    throw new GithubUnconfiguredError(`'${key}' has no resolved repo — /private/detail`);
  });
  const res = await get("alpha");
  expect(res.status).toBe(409);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "GITHUB_UNCONFIGURED" }]);
  // The service's message carries paths; the payload must not.
  expect(text).not.toContain("/private/detail");
});

test("gh failure → 503 GITHUB_UNREADABLE, no output leaks", async () => {
  setGithubObserver(async () => {
    throw new Error("gh: api rate limit exceeded for /Users/someone");
  });
  const res = await get("alpha");
  expect(res.status).toBe(503);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "GITHUB_UNREADABLE" }]);
  expect(text).not.toContain("/Users/someone");
});

test("malformed key → 400 before the observer runs", async () => {
  let observed = false;
  setGithubObserver(async () => {
    observed = true;
    return OBSERVATION;
  });
  const res = await get("Not_A_Key");
  expect(res.status).toBe(400);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "PROJECT_KEY_INVALID" }]);
  expect(observed).toBe(false);
});

test("non-GET verbs → 405, GET-only surface", () => {
  for (const handler of [POST, PUT, PATCH, DELETE]) {
    const res = handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  }
});

test("route is dynamic on the node runtime", () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});
