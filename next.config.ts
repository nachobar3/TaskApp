import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundle so it loads
  // from node_modules at runtime in route handlers.
  serverExternalPackages: ["better-sqlite3"],
  // El dev server bloquea sus recursos (/_next/*) para hosts que no conoce.
  // Permitimos el acceso vía Tailscale (la URL https://<maquina>.<tailnet>.ts.net).
  // Solo aplica a desarrollo; en producción (next start) no hace falta.
  allowedDevOrigins: ["ignacio-vostro-3405.taila3caa9.ts.net"],
};

export default nextConfig;
