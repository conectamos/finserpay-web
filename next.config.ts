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
  serverExternalPackages: ["ssh2-sftp-client", "ssh2", "pdfkit"],
  async headers() {
    const noStoreHeaders = [
      {
        key: "Cache-Control",
        value: "no-cache, no-store, must-revalidate",
      },
    ];

    return [
      {
        source: "/sw.js",
        headers: noStoreHeaders,
      },
      {
        source: "/clientes/:path*",
        headers: noStoreHeaders,
      },
    ];
  },
  experimental: {
    proxyClientMaxBodySize: "80mb",
  },
};

export default nextConfig;
