import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolveRedescuentoPercentageByPlatform,
} from "../lib/aliados.ts";

const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8"
);
const aliadosLib = readFileSync(
  new URL("../lib/aliados.ts", import.meta.url),
  "utf8"
);
const aliadosApi = readFileSync(
  new URL("../app/api/aliados/admin/route.ts", import.meta.url),
  "utf8"
);
const aliadosUi = readFileSync(
  new URL("../app/dashboard/aliados/aliados-client.tsx", import.meta.url),
  "utf8"
);
const cartera = readFileSync(
  new URL("../app/dashboard/cartera/page.tsx", import.meta.url),
  "utf8"
);
const predeploy = readFileSync(
  new URL("../scripts/railway-predeploy.mjs", import.meta.url),
  "utf8"
);
const rediscountMigration = readFileSync(
  new URL("../scripts/ensure-aliado-redescuento-schema.mjs", import.meta.url),
  "utf8"
);
const dockerfile = readFileSync(
  new URL("../Dockerfile", import.meta.url),
  "utf8"
);

test("resuelve porcentajes distintos para Android y iPhone", () => {
  const settings = {
    redescuentoAndroidPorcentaje: 12.5,
    redescuentoIphonePorcentaje: 27.25,
    redescuentoPorcentaje: 10,
  };

  assert.equal(
    resolveRedescuentoPercentageByPlatform(settings, "ANDROID"),
    12.5
  );
  assert.equal(
    resolveRedescuentoPercentageByPlatform(settings, "IPHONE"),
    27.25
  );
});

test("la migracion conserva el porcentaje anterior en ambas plataformas", () => {
  const legacy = { redescuentoPorcentaje: 18.75 };

  assert.equal(
    resolveRedescuentoPercentageByPlatform(legacy, "ANDROID"),
    18.75
  );
  assert.equal(
    resolveRedescuentoPercentageByPlatform(legacy, "IPHONE"),
    18.75
  );
  assert.match(
    aliadosLib,
    /"redescuentoAndroidPorcentaje"\s*=\s*COALESCE\([\s\S]{0,180}"redescuentoPorcentaje"/
  );
  assert.match(
    aliadosLib,
    /"redescuentoIphonePorcentaje"\s*=\s*COALESCE\([\s\S]{0,180}"redescuentoPorcentaje"/
  );
  assert.match(
    rediscountMigration,
    /"redescuentoAndroidPorcentaje"\s*=\s*COALESCE\([\s\S]{0,180}"redescuentoPorcentaje"/
  );
  assert.match(
    rediscountMigration,
    /"redescuentoIphonePorcentaje"\s*=\s*COALESCE\([\s\S]{0,180}"redescuentoPorcentaje"/
  );
});

test("Railway migra el redescuento antes de iniciar la aplicacion", () => {
  assert.match(predeploy, /ensure-aliado-redescuento-schema\.mjs/);
  assert.match(dockerfile, /ensure-aliado-redescuento-schema\.mjs/);
  assert.match(
    rediscountMigration,
    /ALTER COLUMN "redescuentoAndroidPorcentaje" SET NOT NULL/
  );
  assert.match(
    rediscountMigration,
    /ALTER COLUMN "redescuentoIphonePorcentaje" SET NOT NULL/
  );
});

test("un credito historico sin plataforma conserva el porcentaje legado", () => {
  assert.equal(
    resolveRedescuentoPercentageByPlatform(
      {
        redescuentoAndroidPorcentaje: 8,
        redescuentoIphonePorcentaje: 22,
        redescuentoPorcentaje: 15,
      },
      null
    ),
    15
  );
});

test("modelo, API y formulario exponen los dos porcentajes", () => {
  for (const source of [schema, aliadosApi, aliadosUi]) {
    assert.match(source, /redescuentoAndroidPorcentaje/);
    assert.match(source, /redescuentoIphonePorcentaje/);
  }

  assert.match(aliadosUi, /Android \(%\)/);
  assert.match(aliadosUi, /iPhone \(%\)/);
});

test("cartera escoge el porcentaje segun la plataforma congelada del credito", () => {
  assert.match(cartera, /equipment\?\.plataforma/);
  assert.match(cartera, /isIphoneEquipmentCatalogBrand\(equipmentBrand\)/);
  assert.match(cartera, /String\(equipmentBrand \|\| ""\)\.trim\(\)/);
  assert.match(cartera, /resolveRedescuentoPercentageByPlatform\(/);
  assert.match(cartera, /credito\.contratoSnapshot/);
});
