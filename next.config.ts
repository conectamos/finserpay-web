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
      {
        source: "/enrolamiento-iphone",
        headers: [
          ...noStoreHeaders,
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
          },
        ],
      },
    ];
  },
  experimental: {
    proxyClientMaxBodySize: "80mb",
  },
};

export default nextConfig;
