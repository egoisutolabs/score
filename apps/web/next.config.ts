import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace libraries ship raw TypeScript through their exports map;
  // Next must transpile them or the bundled server rejects them.
  transpilePackages: ["@score/core", "@score/shared"],
};

export default nextConfig;
