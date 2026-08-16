import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript; Next must compile them itself.
  transpilePackages: ["@score/core", "@score/shared", "@score/tracker"],
};

export default nextConfig;
