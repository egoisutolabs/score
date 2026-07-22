import { expect, test } from "vitest";

import { color } from "@/shared/color";

// Under vitest stdout is not a TTY, so colors must be inert — no escape codes
// leaking into piped or redirected log output.
test("colors are passthrough when stdout is not a TTY", () => {
  expect(color.red("boom")).toBe("boom");
  expect(color.blue("info")).toBe("info");
  expect(color.gray("[ts]")).toBe("[ts]");
});
