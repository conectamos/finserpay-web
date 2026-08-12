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
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  isIphoneEquipmentCatalogBrand,
  normalizeCreditDevicePlatform,
  resolveCreditEquipmentPlatform,
} = await jiti.import("../lib/credit-factory.ts");

const iphoneItem = {
  id: 41,
  marca: "IPHONE",
  modelo: "iPhone 15 Pro",
  precioBaseVenta: 3_200_000,
  activo: true,
};

const resolveSelectedIphone = (overrides = {}) =>
  resolveCreditEquipmentPlatform({
    requestedPlatform: "IPHONE",
    equipoMarca: " iphone ",
    equipoModelo: "IPHONE 15 PRO",
    catalogItemId: 41,
    catalogItem: iphoneItem,
    ...overrides,
  });

test("acepta unicamente el enum de plataforma ANDROID/IPHONE", () => {
  assert.equal(normalizeCreditDevicePlatform("android"), "ANDROID");
  assert.equal(normalizeCreditDevicePlatform(" IPHONE "), "IPHONE");

  for (const invalid of [undefined, null, "", "IOS", "APPLE", "WEB", 1]) {
    assert.equal(normalizeCreditDevicePlatform(invalid), null);
  }
});
test("clasifica IPHONE, APPLE y APPLE IPHONE como plataforma iPhone", () => {
  for (const brand of ["iPhone", "APPLE", "Apple iPhone", "apple-iphone"]) {
    assert.equal(isIphoneEquipmentCatalogBrand(brand), true);
  }
  assert.equal(isIphoneEquipmentCatalogBrand("Samsung"), false);

  const appleItem = {
    id: 52,
    marca: "Apple",
    modelo: "iPhone 16",
    activo: true,
  };
  assert.deepEqual(
    resolveCreditEquipmentPlatform({
      requestedPlatform: "IPHONE",
      equipoMarca: "APPLE",
      equipoModelo: "iPhone 16",
      catalogItemId: 52,
      catalogItem: appleItem,
    }),
    { ok: true, platform: "IPHONE" }
  );
  assert.equal(
    resolveCreditEquipmentPlatform({
      requestedPlatform: "ANDROID",
      equipoMarca: "Apple",
      equipoModelo: "iPhone 16",
      catalogItemId: 52,
      catalogItem: appleItem,
    }).code,
    "EQUIPMENT_PLATFORM_MISMATCH"
  );
});

test("valida existencia, estado e identidad cuando llega equipoCatalogoId", () => {
  assert.deepEqual(resolveSelectedIphone(), { ok: true, platform: "IPHONE" });

  assert.equal(
    resolveSelectedIphone({ catalogItem: null }).code,
    "EQUIPMENT_CATALOG_NOT_FOUND"
  );
  assert.equal(
    resolveSelectedIphone({
      catalogItem: { ...iphoneItem, activo: false },
    }).code,
    "EQUIPMENT_CATALOG_INACTIVE"
  );
  assert.equal(
    resolveSelectedIphone({ equipoModelo: "iPhone 14" }).code,
    "EQUIPMENT_CATALOG_IDENTITY_MISMATCH"
  );
});

test("deriva la plataforma del item valido y rechaza el mismatch", () => {
  assert.equal(
    resolveSelectedIphone({ requestedPlatform: "ANDROID" }).code,
    "EQUIPMENT_PLATFORM_MISMATCH"
  );

  const androidItem = {
    id: 9,
    marca: "Samsung",
    modelo: "Galaxy A55",
    activo: true,
  };
  assert.deepEqual(
    resolveCreditEquipmentPlatform({
      requestedPlatform: "ANDROID",
      equipoMarca: "SAMSUNG",
      equipoModelo: "Galaxy A55",
      catalogItemId: 9,
      catalogItem: androidItem,
    }),
    { ok: true, platform: "ANDROID" }
  );
  assert.equal(
    resolveCreditEquipmentPlatform({
      requestedPlatform: "IPHONE",
      equipoMarca: "Samsung",
      equipoModelo: "Galaxy A55",
      catalogItemId: 9,
      catalogItem: androidItem,
    }).code,
    "EQUIPMENT_PLATFORM_MISMATCH"
  );
});

test("mantiene fallback manual pero una marca IPHONE no puede eludir su flujo", () => {
  assert.deepEqual(
    resolveCreditEquipmentPlatform({
      requestedPlatform: "ANDROID",
      equipoMarca: "Samsung",
      equipoModelo: "Modelo manual",
    }),
    { ok: true, platform: "ANDROID" }
  );
  assert.deepEqual(
    resolveCreditEquipmentPlatform({
      requestedPlatform: "IPHONE",
      equipoMarca: "Marca manual",
      equipoModelo: "Modelo manual",
    }),
    { ok: true, platform: "IPHONE" }
  );
  for (const brand of ["iPhone", "Apple", "Apple iPhone"]) {
    assert.equal(
      resolveCreditEquipmentPlatform({
        requestedPlatform: "ANDROID",
        equipoMarca: brand,
        equipoModelo: "15",
      }).code,
      "EQUIPMENT_PLATFORM_MISMATCH"
    );
  }
});

test("las dos rutas resuelven equipoCatalogoId por ID con el mismo helper", async () => {
  const [catalogSource, creditRoute, firmaSeguroRoute] = await Promise.all([
    readProjectFile("lib/equipment-catalog.ts"),
    readProjectFile("app/api/creditos/route.ts"),
    readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
  ]);

  assert.match(catalogSource, /export async function findEquipmentCatalogItemById/);
  assert.match(catalogSource, /WHERE id = \$1/);

  for (const source of [creditRoute, firmaSeguroRoute]) {
    assert.match(source, /equipoCatalogoId/);
    assert.match(source, /findEquipmentCatalogItemById/);
    assert.match(source, /resolveCreditEquipmentPlatform/);
  }
});
