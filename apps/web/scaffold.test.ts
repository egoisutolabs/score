// Scaffold contract for #75: API-only, loopback-only, server stub gone.
// Script text and file globs are the contract — no runtime introspection.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(webRoot, "..", "..");
const SKIP = new Set(["node_modules", ".next", ".turbo", "dist", ".git"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("API-only", () => {
  const files = walk(webRoot).map((f) => relative(webRoot, f));

  it("has no page.tsx, CSS framework, static export, or custom server", () => {
    expect(files.filter((f) => /(^|\/)page\.tsx$/.test(f))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".css"))).toEqual([]);
    expect(files.filter((f) => /(^|\/)(tailwind|postcss)\.config\./.test(f))).toEqual([]);
    expect(files.filter((f) => /^server\.(ts|js|mjs)$/.test(f))).toEqual([]);
    expect(readFileSync(join(webRoot, "next.config.ts"), "utf8")).not.toMatch(
      /output:\s*["']export["']/,
    );
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
    expect(pkg.scripts.dev).toContain("--hostname 127.0.0.1");
    expect(pkg.scripts.start).toContain("--hostname 127.0.0.1");
  });
});

describe("stub gone", () => {
  const stub = new RegExp(`@score/${"server"}|apps/${"server"}`);
  // This file necessarily spells the pattern it hunts (test names, comments) —
  // exempt it, like rg exempting its own invocation.
  const self = fileURLToPath(import.meta.url);

  it("no live reference to the deleted apps/server stub", () => {
    const targets = [
      ...walk(join(repoRoot, "apps")),
      ...walk(join(repoRoot, "packages")),
      join(repoRoot, "package.json"),
      join(repoRoot, "turbo.json"),
      join(repoRoot, "README.md"),
    ].filter((f) => f !== self);
    const offenders = targets.filter((f) => stub.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
