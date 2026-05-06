import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

function resolveAllowedDevOrigins() {
  const allowed = new Set<string>([
    "localhost",
    "127.0.0.1",
  ]);

  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        allowed.add(item.address);
      }
    }
  }

  return [...allowed];
}

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: resolveAllowedDevOrigins(),
  experimental: {
    proxyClientMaxBodySize: "80mb",
  },
};

export default nextConfig;
