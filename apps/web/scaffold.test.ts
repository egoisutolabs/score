// Scaffold contract for #75: API-only, loopback-only, server stub gone.
// Script text and file globs are the contract — no runtime introspection.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(webRoot, "..", "..");
// Never legitimate source at any depth. "dist" is NOT here: a route segment
// like src/app/dist/ must stay visible to the API-only globs, so build-output
// dist dirs are skipped only where a walk opts in.
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

describe("API-only", () => {
  const files = walk(webRoot).map((f) => relative(webRoot, f));

  it("has no page.tsx, CSS framework, static export, or custom server", () => {
    expect(files.filter((f) => /(^|\/)page\.[cm]?[jt]sx?$/.test(f))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".css"))).toEqual([]);
    expect(files.filter((f) => /(^|\/)(tailwind|postcss)\.config\./.test(f))).toEqual([]);
    expect(files.filter((f) => /(^|\/)server\.[cm]?[jt]s$/.test(f))).toEqual([]);
    // The scripts must invoke the Next CLI itself — a custom entrypoint under
    // any filename would otherwise slip past the basename glob above.
    const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));
    expect(pkg.scripts.dev).toMatch(/^next dev\b/);
    expect(pkg.scripts.start).toMatch(/^next start\b/);
    expect(pkg.scripts.build).toMatch(/^next build\b/);
    // Resolved config value, not source text — any spelling of a static
    // export would break `next start` serving /healthz dynamically.
    expect(nextConfig.output).not.toBe("export");
  });

  it("has no client components", () => {
    const offenders = files
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
      .filter((f) => /^\s*["']use client["']/m.test(readFileSync(join(webRoot, f), "utf8")));
    expect(offenders).toEqual([]);
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

describe("healthz route location", () => {
  // Independent of route.test.ts (which co-moves with the module): Next maps
  // GET /healthz only from this exact path, so a rename can't stay green.
  it("src/app/healthz/route.ts exists where Next routes it", () => {
    expect(existsSync(join(webRoot, "src", "app", "healthz", "route.ts"))).toBe(true);
  });
});

describe("stub gone", () => {
  const stub = new RegExp(`@score/${"server"}|apps/${"server"}`);
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
