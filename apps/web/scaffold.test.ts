// Scaffold contract: the web console. #75's API-only rule is retired — the
// app now owns UI (App Router pages, Tailwind, client components) — but the
// rest of that contract still holds: loopback-only, Next CLI as the sole
// command, no custom server, no static export, no Pages Router. Script text
// and file globs are the contract — no runtime introspection.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(webRoot, "..", "..");
// Never legitimate source at any depth. "dist" is NOT here: a route segment
// like src/app/dist/ must stay visible to source globs, so build-output dist
// dirs are skipped only where a walk opts in.
const SKIP = new Set(["node_modules", ".next", ".turbo", ".git"]);
const SKIP_WITH_BUILD_OUT = new Set([...SKIP, "dist"]);

function walk(dir: string, skip: ReadonlySet<string> = SKIP): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, skip));
    else out.push(full);
  }
  return out;
}

describe("Next CLI only", () => {
  it("has no Pages Router, custom server, or static export", () => {
    // Pages Router serves UI from any module under pages/ — the console is
    // App Router only, so reject the directories themselves.
    expect(existsSync(join(webRoot, "pages"))).toBe(false);
    expect(existsSync(join(webRoot, "src", "pages"))).toBe(false);
    expect(existsSync(join(webRoot, "server.ts"))).toBe(false);
    expect(existsSync(join(webRoot, "server.js"))).toBe(false);
    // public/ files are served verbatim by URL, outside the router and this
    // contract's globs — adding one is a conscious contract change.
    expect(existsSync(join(webRoot, "public"))).toBe(false);
    // Exact script text: the Next CLI is the sole command — no custom
    // entrypoint, no smuggled second command behind & or &&. Changing a
    // script means consciously updating this contract.
    const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));
    expect(pkg.scripts.dev).toBe("next dev --hostname 127.0.0.1");
    expect(pkg.scripts.start).toBe("next start --hostname 127.0.0.1");
    expect(pkg.scripts.build).toBe("next build");
    // Resolved config value, not source text — any spelling of a static
    // export would break `next start` serving /healthz dynamically.
    expect(nextConfig.output).not.toBe("export");
  });
});

describe("loopback-only", () => {
  it("dev and start scripts bind 127.0.0.1", () => {
    const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));
    for (const script of [pkg.scripts.dev, pkg.scripts.start]) {
      // Boundary after the address so 127.0.0.1.example.com can't pass.
      expect(script).toMatch(/--hostname[ =]127\.0\.0\.1(?=\s|$)/);
      // Ceiling: script text is the contract — but every --hostname in it
      // must be loopback, so a stray public bind can't hide behind one.
      expect(script).not.toMatch(/--hostname(?![ =]127\.0\.0\.1(?:\s|$))/);
    }
  });
});

describe("route locations", () => {
  // Independent of each route's own tests (which co-move with the module):
  // Next maps these URLs only from these exact paths, so a rename can't
  // stay green.
  it("src/app/healthz/route.ts exists where Next routes it", () => {
    expect(existsSync(join(webRoot, "src", "app", "healthz", "route.ts"))).toBe(true);
  });
  it("the console page and layout exist where Next routes them", () => {
    expect(existsSync(join(webRoot, "src", "app", "page.tsx"))).toBe(true);
    expect(existsSync(join(webRoot, "src", "app", "layout.tsx"))).toBe(true);
  });
});

describe("stub gone", () => {
  // Third alternative catches brace-form workspace notation like
  // apps/{daemon,tui,server} — the exact stale spelling this PR scrubbed.
  const stub = new RegExp(`@score/${"server"}|apps/${"server"}|apps/\\{[^}]*${"server"}[^}]*\\}`);
  // This file necessarily spells the pattern it hunts (test names, comments) —
  // exempt it, like rg exempting its own invocation.
  const self = fileURLToPath(import.meta.url);

  it("no live reference to the deleted apps/server stub", () => {
    const targets = [
      ...walk(join(repoRoot, "apps"), SKIP_WITH_BUILD_OUT),
      ...walk(join(repoRoot, "packages"), SKIP_WITH_BUILD_OUT),
      join(repoRoot, "package.json"),
      join(repoRoot, "turbo.json"),
      join(repoRoot, "README.md"),
      join(repoRoot, "AGENTS.md"),
    ].filter((f) => f !== self);
    const offenders = targets.filter((f) => stub.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
