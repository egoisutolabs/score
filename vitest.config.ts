import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // OpenTUI's test renderer needs native FFI (Node >= 26.4) for the TUI
    // frame-snapshot tests.
    execArgv: ["--experimental-ffi"],
  },
});
