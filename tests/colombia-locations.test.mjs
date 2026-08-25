import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const {
  COLOMBIA_DEPARTMENT_CITY_OPTIONS,
  COLOMBIA_DEPARTMENT_OPTIONS,
  getColombiaCityOptions,
  getColombiaDepartmentLabel,
} = await createJiti(import.meta.url).import("../lib/colombia-locations.ts");

const expectedDepartmentCodes = [
  "AMAZONAS",
  "ANTIOQUIA",
  "ARAUCA",
  "ATLANTICO",
  "BOGOTA_DC",
  "BOLIVAR",
  "BOYACA",
  "CALDAS",
  "CAQUETA",
  "CASANARE",
  "CAUCA",
  "CESAR",
  "CHOCO",
  "CORDOBA",
  "CUNDINAMARCA",
  "GUAINIA",
  "GUAVIARE",
  "HUILA",
  "LA_GUAJIRA",
  "MAGDALENA",
  "META",
  "NARINO",
  "NORTE_DE_SANTANDER",
  "PUTUMAYO",
  "QUINDIO",
  "RISARALDA",
  "SAN_ANDRES_PROVIDENCIA_Y_SANTA_CATALINA",
  "SANTANDER",
  "SUCRE",
  "TOLIMA",
  "VALLE_DEL_CAUCA",
  "VAUPES",
  "VICHADA",
];

const expectedDepartmentLabels = {
  AMAZONAS: "AMAZONAS",
  ANTIOQUIA: "ANTIOQUIA",
  ARAUCA: "ARAUCA",
  ATLANTICO: "ATLÁNTICO",
  BOGOTA_DC: "BOGOTÁ, D. C.",
  BOLIVAR: "BOLÍVAR",
  BOYACA: "BOYACÁ",
  CALDAS: "CALDAS",
  CAQUETA: "CAQUETÁ",
  CASANARE: "CASANARE",
  CAUCA: "CAUCA",
  CESAR: "CESAR",
  CHOCO: "CHOCÓ",
  CORDOBA: "CÓRDOBA",
  CUNDINAMARCA: "CUNDINAMARCA",
  GUAINIA: "GUAINÍA",
  GUAVIARE: "GUAVIARE",
  HUILA: "HUILA",
  LA_GUAJIRA: "LA GUAJIRA",
  MAGDALENA: "MAGDALENA",
  META: "META",
  NARINO: "NARIÑO",
  NORTE_DE_SANTANDER: "NORTE DE SANTANDER",
  PUTUMAYO: "PUTUMAYO",
  QUINDIO: "QUINDÍO",
  RISARALDA: "RISARALDA",
  SAN_ANDRES_PROVIDENCIA_Y_SANTA_CATALINA:
    "ARCHIPIÉLAGO DE SAN ANDRÉS, PROVIDENCIA Y SANTA CATALINA",
  SANTANDER: "SANTANDER",
  SUCRE: "SUCRE",
  TOLIMA: "TOLIMA",
  VALLE_DEL_CAUCA: "VALLE DEL CAUCA",
  VAUPES: "VAUPÉS",
  VICHADA: "VICHADA",
};

const normalize = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

test("el catalogo incluye los 32 departamentos y Bogota D. C.", () => {
  const optionCodes = COLOMBIA_DEPARTMENT_OPTIONS.map(({ value }) => value);
  const labels = COLOMBIA_DEPARTMENT_OPTIONS.map(({ label }) => normalize(label));

  assert.equal(optionCodes.length, 33);
  assert.deepEqual(optionCodes, expectedDepartmentCodes);
  assert.equal(new Set(optionCodes).size, 33);
  assert.equal(new Set(labels).size, 33);
  assert.ok(optionCodes.every((value) => /^[A-Z]+(?:_[A-Z]+)*$/.test(value)));
  assert.deepEqual(
    Object.fromEntries(
      COLOMBIA_DEPARTMENT_OPTIONS.map(({ value, label }) => [value, label])
    ),
    expectedDepartmentLabels
  );
});

test("cada departamento ofrece ciudades sin duplicados", () => {
  const mapCodes = Object.keys(COLOMBIA_DEPARTMENT_CITY_OPTIONS);

  assert.deepEqual(mapCodes, expectedDepartmentCodes);
  for (const [department, cities] of Object.entries(
    COLOMBIA_DEPARTMENT_CITY_OPTIONS
  )) {
    assert.ok(cities.length > 0, `${department} debe tener ciudades disponibles`);
    assert.ok(cities.every((city) => city === city.trim() && city.length > 0));
    assert.equal(
      new Set(cities.map(normalize)).size,
      cities.length,
      `${department} no debe repetir ciudades`
    );
  }
});

test("Bogota D. C. queda separada de Cundinamarca sin romper datos historicos", () => {
  assert.ok(
    COLOMBIA_DEPARTMENT_CITY_OPTIONS.BOGOTA_DC.some(
      (city) => normalize(city) === "BOGOTA"
    )
  );
  assert.ok(
    COLOMBIA_DEPARTMENT_CITY_OPTIONS.CUNDINAMARCA.every(
      (city) => normalize(city) !== "BOGOTA"
    )
  );
  assert.ok(getColombiaCityOptions("CUNDINAMARCA", "Bogota").includes("Bogota"));
  assert.equal(getColombiaDepartmentLabel("BOGOTA_DC"), "BOGOTÁ, D. C.");
  assert.equal(getColombiaDepartmentLabel("VALLE_DEL_CAUCA"), "VALLE DEL CAUCA");
});

test("la fabrica usa el catalogo compartido y admite cualquier municipio", () => {
  const consoleSource = readFileSync(
    new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
    "utf8"
  );

  assert.match(consoleSource, /COLOMBIA_DEPARTMENT_OPTIONS\.map/);
  assert.match(consoleSource, /getColombiaCityOptions\(clienteDepartamento, clienteCiudad\)/);
  assert.match(
    consoleSource,
    /setClienteDepartamento\(event\.target\.value\);\s*setClienteCiudad\(""\);/
  );
  assert.match(consoleSource, /list="cliente-ciudad-options"/);
  assert.match(consoleSource, /<datalist id="cliente-ciudad-options">/);
  assert.match(consoleSource, /escribir cualquier municipio/);
  assert.doesNotMatch(
    consoleSource,
    /clienteCiudad && !cityOptions\.includes\(clienteCiudad\)/
  );
  assert.doesNotMatch(consoleSource, /const DEPARTMENT_CITY_OPTIONS/);
});

test("los documentos y resumenes convierten los codigos a nombres oficiales", () => {
  const creditRouteSource = readFileSync(
    new URL("../app/api/creditos/route.ts", import.meta.url),
    "utf8"
  );
  const documentsRouteSource = readFileSync(
    new URL("../app/api/creditos/[id]/documentos/route.ts", import.meta.url),
    "utf8"
  );
  const consoleSource = readFileSync(
    new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
    "utf8"
  );

  assert.match(
    creditRouteSource,
    /departamento: getColombiaDepartmentLabel\(clienteDepartamento\)/
  );
  assert.match(
    documentsRouteSource,
    /getColombiaDepartmentLabel\(credito\.clienteDepartamento\)/
  );
  assert.ok(
    (
      consoleSource.match(
        /getColombiaDepartmentLabel\(\s*selectedCredit\.clienteDepartamento\s*\)/g
      ) || []
    ).length >= 3
  );
});
