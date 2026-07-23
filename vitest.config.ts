import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// OpenTUI's test renderer needs native FFI, which Node gained in 26.4 behind
// --experimental-ffi. Older Nodes reject the flag at worker spawn (killing
// every test file), so only pass it where it exists; the renderer-dependent
// TUI tests skip themselves when it's absent.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const nodeHasFfi = major > 26 || (major === 26 && minor >= 4);

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    execArgv: nodeHasFfi ? ["--experimental-ffi"] : [],
  },
});
