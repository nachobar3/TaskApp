import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundle so it loads
  // from node_modules at runtime in route handlers.
  serverExternalPackages: ["better-sqlite3"],
  // The dev server blocks its own assets (/_next/*) for unknown hosts, which
  // breaks hydration behind a Tailscale proxy (page renders, buttons dead).
  // Allow any tailnet hostname — dev-only; `next start` doesn't need this.
  allowedDevOrigins: ["*.ts.net"],
};

export default nextConfig;
