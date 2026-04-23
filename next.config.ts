import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

function resolveAllowedDevOrigins() {
  const allowed = new Set<string>([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);

  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        allowed.add(`http://${item.address}:3000`);
      }
    }
  }

  return [...allowed];
}

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: resolveAllowedDevOrigins(),
};

export default nextConfig;
