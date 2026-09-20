import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { resolveAllyPaymentPlatform } = await jiti.import(
  "../lib/ally-payments-core.ts"
);
const { normalizeCreditDevicePlatform } = await jiti.import(
  "../lib/credit-factory.ts"
);

test("normaliza exclusivamente las plataformas admitidas por cartera", () => {
  assert.equal(normalizeCreditDevicePlatform(" iphone "), "IPHONE");
  assert.equal(normalizeCreditDevicePlatform("android"), "ANDROID");
  assert.equal(normalizeCreditDevicePlatform("WINDOWS"), null);
  assert.equal(normalizeCreditDevicePlatform(null), null);
});

test("la plataforma contractual prevalece y los historicos usan la marca", () => {
  assert.equal(
    resolveAllyPaymentPlatform(
      { equipo: { plataforma: " android " } },
      "APPLE"
    ),
    "ANDROID"
  );
  assert.equal(
    resolveAllyPaymentPlatform(
      { equipo: { plataforma: "iphone" } },
      "Samsung"
    ),
    "IPHONE"
  );
  assert.equal(resolveAllyPaymentPlatform(null, "Apple iPhone"), "IPHONE");
  assert.equal(resolveAllyPaymentPlatform({}, "Motorola"), "ANDROID");
  assert.equal(resolveAllyPaymentPlatform("dato historico", ""), null);
});

test("la pantalla conserva aliado y plataforma en sus exportaciones", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/dashboard/cartera/page.tsx"),
    "utf8"
  );

  assert.match(source, /name="plataforma"/);
  assert.match(source, /Todos los productos/);
  assert.match(source, /<option value="IPHONE">iPhone<\/option>/);
  assert.match(source, /<option value="ANDROID">Android<\/option>/);
  assert.match(source, /params\.set\("aliadoId"/);
  assert.match(source, /params\.set\("plataforma"/);
  assert.match(source, /scope: "mora"/);
  assert.match(source, /selectedAliadoId \|\| selectedPlatform/);
});

test("el Excel usa el mismo filtro y conserva el alcance por aliado", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/api/dashboard/cartera/export/route.ts"),
    "utf8"
  );

  assert.match(source, /normalizeCreditDevicePlatform\(/);
  assert.match(source, /resolveAllyPaymentPlatform\(/);
  assert.match(source, /selectedAliadoId = adminCentral \? requestedAliadoId : ownAliadoId/);
  assert.match(source, /aliadoId: selectedAliadoId/);
  assert.match(source, /<th>Plataforma<\/th>/);
});
