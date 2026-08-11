import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": projectRoot },
});
const {
  DataCreditoPolicyValidationError,
  normalizeDataCreditoPlatform,
  parseDataCreditoPolicyBands,
  resolveDataCreditoDecision,
} = await jiti.import("../lib/datacredito/policy.ts");

function completeBands() {
  return [
    {
      id: "android-bajo",
      platform: "ANDROID",
      scoreMin: 0,
      scoreMax: 499,
      decision: "RECHAZADO",
      initialPaymentPercentage: 40,
      suretyPercentage: 20,
    },
    {
      id: "android-alto",
      platform: "ANDROID",
      scoreMin: 500,
      scoreMax: 950,
      decision: "APROBADO",
      initialPaymentPercentage: 15.5,
      suretyPercentage: 7.25,
    },
    {
      id: "iphone-bajo",
      platform: "IPHONE",
      scoreMin: 0,
      scoreMax: 699,
      decision: "RECHAZADO",
      initialPaymentPercentage: 50,
      suretyPercentage: 25,
    },
    {
      id: "iphone-alto",
      platform: "IPHONE",
      scoreMin: 700,
      scoreMax: 950,
      decision: "APROBADO",
      initialPaymentPercentage: 30,
      suretyPercentage: 12,
    },
  ];
}

test("normaliza unicamente las plataformas soportadas", () => {
  assert.equal(normalizeDataCreditoPlatform(" android "), "ANDROID");
  assert.equal(normalizeDataCreditoPlatform("iPhone"), "IPHONE");
  assert.equal(normalizeDataCreditoPlatform("WEB"), null);
});

test("acepta una politica con cobertura completa 0 a 950 por plataforma", () => {
  const parsed = parseDataCreditoPolicyBands(completeBands());
  assert.equal(parsed.length, 4);
  assert.deepEqual(
    parsed.map((band) => `${band.platform}:${band.scoreMin}-${band.scoreMax}`),
    ["ANDROID:0-499", "ANDROID:500-950", "IPHONE:0-699", "IPHONE:700-950"]
  );
});

test("rechaza huecos que producirian decisiones implicitas", () => {
  const bands = completeBands();
  bands[1] = { ...bands[1], scoreMin: 501 };

  assert.throws(
    () => parseDataCreditoPolicyBands(bands),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("sin configurar"))
  );
});

test("rechaza solapes y rangos fuera del score documentado", () => {
  const bands = completeBands();
  bands[1] = { ...bands[1], scoreMin: 499, scoreMax: 951 };

  assert.throws(
    () => parseDataCreditoPolicyBands(bands),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("superponen")) &&
      error.issues.some((issue) => issue.includes("entre 0 y 950"))
  );
});

test("rechaza una politica que omite una plataforma", () => {
  const androidOnly = completeBands().filter((band) => band.platform === "ANDROID");
  assert.throws(
    () => parseDataCreditoPolicyBands(androidOnly),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.includes("Faltan las bandas de IPHONE")
  );
});

test("resuelve decision y oferta desde la version exacta de politica", () => {
  const policy = { version: 7, bands: parseDataCreditoPolicyBands(completeBands()) };

  assert.deepEqual(resolveDataCreditoDecision(policy, "ANDROID", 500), {
    decision: "APROBADO",
    offer: {
      initialPaymentPercentage: 15.5,
      suretyPercentage: 7.25,
      policyVersion: 7,
    },
  });
  assert.deepEqual(resolveDataCreditoDecision(policy, "IPHONE", 699), {
    decision: "RECHAZADO",
    offer: {
      initialPaymentPercentage: 50,
      suretyPercentage: 25,
      policyVersion: 7,
    },
  });
  assert.equal(resolveDataCreditoDecision(policy, "ANDROID", 951), null);
});

test("valida identificadores unicos y porcentajes financieros", () => {
  const bands = completeBands();
  bands[1] = {
    ...bands[1],
    id: bands[0].id,
    initialPaymentPercentage: 101,
    suretyPercentage: -1,
  };

  assert.throws(
    () => parseDataCreditoPolicyBands(bands),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("repetido")) &&
      error.issues.some((issue) => issue.includes("cuota inicial")) &&
      error.issues.some((issue) => issue.includes("fianza"))
  );
});
