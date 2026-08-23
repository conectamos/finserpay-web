import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const [serviceWorker, pwaRegister, nextConfig] = await Promise.all([
  readFile(path.join(projectRoot, "public/sw.js"), "utf8"),
  readFile(path.join(projectRoot, "app/_components/pwa-register.tsx"), "utf8"),
  readFile(path.join(projectRoot, "next.config.ts"), "utf8"),
]);

test("el service worker no conserva HTML ni navegaciones del portal", () => {
  const staticAssets = serviceWorker.match(
    /const STATIC_ASSETS = \[([\s\S]*?)\];/
  )?.[1];

  assert.ok(staticAssets, "Debe existir la lista de recursos estaticos");
  assert.doesNotMatch(staticAssets, /["']\/clientes["']/);
  assert.doesNotMatch(serviceWorker, /cache\.put\(["']\/clientes["']/);
  assert.doesNotMatch(serviceWorker, /request\.mode\s*===\s*["']navigate["']/);
  assert.match(serviceWorker, /finserpay-client-/);
  assert.match(
    serviceWorker,
    /CACHE_NAME\s*=\s*`\$\{CACHE_PREFIX\}v4`/,
    "La version v4 fuerza a las sesiones abiertas a activar el worker nuevo"
  );
});

test("el registro busca actualizaciones y recarga al cambiar de version", () => {
  assert.match(pwaRegister, /updateViaCache:\s*["']none["']/);
  assert.match(pwaRegister, /\.update\(\)/);
  assert.match(pwaRegister, /["']controllerchange["']/);
  assert.match(pwaRegister, /window\.location\.reload\(\)/);
});

test("el worker y el portal se sirven sin cache de HTML", () => {
  assert.match(nextConfig, /source:\s*["']\/sw\.js["']/);
  assert.match(nextConfig, /source:\s*["']\/clientes\/:path\*["']/);
  assert.match(nextConfig, /no-cache, no-store, must-revalidate/);
});
