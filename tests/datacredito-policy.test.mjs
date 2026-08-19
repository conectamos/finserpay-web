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
  DATACREDITO_NO_INFORMATION_SCORE,
  DataCreditoPolicyValidationError,
  isDataCreditoNoInformationScore,
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
      maxFinancedAmount: 600_000,
    },
    {
      id: "android-alto",
      platform: "ANDROID",
      scoreMin: 500,
      scoreMax: 950,
      decision: "APROBADO",
      initialPaymentPercentage: 15.5,
      suretyPercentage: 7.25,
      maxFinancedAmount: 1_800_000,
    },
    {
      id: "iphone-bajo",
      platform: "IPHONE",
      scoreMin: 0,
      scoreMax: 699,
      decision: "RECHAZADO",
      initialPaymentPercentage: 50,
      suretyPercentage: 25,
      maxFinancedAmount: 850_000,
    },
    {
      id: "iphone-alto",
      platform: "IPHONE",
      scoreMin: 700,
      scoreMax: 950,
      decision: "APROBADO",
      initialPaymentPercentage: 30,
      suretyPercentage: 12,
      maxFinancedAmount: 2_500_000,
    },
    {
      id: "android-sin-informacion",
      platform: "ANDROID",
      scoreMin: DATACREDITO_NO_INFORMATION_SCORE,
      scoreMax: DATACREDITO_NO_INFORMATION_SCORE,
      decision: "APROBADO",
      initialPaymentPercentage: 40,
      suretyPercentage: 85,
      maxFinancedAmount: 600_000,
    },
    {
      id: "iphone-sin-informacion",
      platform: "IPHONE",
      scoreMin: DATACREDITO_NO_INFORMATION_SCORE,
      scoreMax: DATACREDITO_NO_INFORMATION_SCORE,
      decision: "RECHAZADO",
      initialPaymentPercentage: 45,
      suretyPercentage: 90,
      maxFinancedAmount: 600_000,
    },
  ];
}

test("normaliza unicamente las plataformas soportadas", () => {
  assert.equal(normalizeDataCreditoPlatform(" android "), "ANDROID");
  assert.equal(normalizeDataCreditoPlatform("iPhone"), "IPHONE");
  assert.equal(normalizeDataCreditoPlatform("WEB"), null);
});

test("acepta una regla sin informacion y cobertura completa por plataforma", () => {
  const parsed = parseDataCreditoPolicyBands(completeBands());
  assert.equal(parsed.length, 6);
  assert.deepEqual(
    parsed.map((band) => `${band.platform}:${band.scoreMin}-${band.scoreMax}`),
    [
      "ANDROID:-1--1",
      "ANDROID:0-499",
      "ANDROID:500-950",
      "IPHONE:-1--1",
      "IPHONE:0-699",
      "IPHONE:700-950",
    ]
  );
  assert.equal(isDataCreditoNoInformationScore(-1), true);
  assert.equal(isDataCreditoNoInformationScore("-1"), true);
  assert.equal(isDataCreditoNoInformationScore(-2), false);
});

test("exige exactamente una regla sin informacion por plataforma", () => {
  const missing = completeBands().filter(
    (band) => band.id !== "android-sin-informacion"
  );
  assert.throws(
    () => parseDataCreditoPolicyBands(missing),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.includes(
        "Debe existir exactamente una regla sin informacion para ANDROID"
      )
  );

  const bands = completeBands();
  const duplicate = {
    ...bands.find((band) => band.id === "iphone-sin-informacion"),
    id: "iphone-sin-informacion-2",
  };
  assert.throws(
    () => parseDataCreditoPolicyBands([...bands, duplicate]),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.includes(
        "Debe existir exactamente una regla sin informacion para IPHONE"
      )
  );
});

test("rechaza negativos del proveedor y rangos mixtos como reglas", () => {
  for (const replacement of [
    { scoreMin: -2, scoreMax: -2 },
    { scoreMin: -1, scoreMax: 0 },
  ]) {
    const bands = completeBands();
    const index = bands.findIndex(
      (band) => band.id === "android-sin-informacion"
    );
    bands[index] = { ...bands[index], ...replacement };

    assert.throws(
      () => parseDataCreditoPolicyBands(bands),
      (error) =>
        error instanceof DataCreditoPolicyValidationError &&
        error.issues.some(
          (issue) =>
            issue.includes("debe ser -1") || issue.includes("exactamente -1")
        )
    );
  }
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

  assert.deepEqual(
    resolveDataCreditoDecision(
      policy,
      "ANDROID",
      DATACREDITO_NO_INFORMATION_SCORE
    ),
    {
      decision: "APROBADO",
      offer: {
        initialPaymentPercentage: 40,
        suretyPercentage: 85,
        maxFinancedAmount: 600_000,
        policyVersion: 7,
      },
    }
  );
  assert.deepEqual(resolveDataCreditoDecision(policy, "ANDROID", 500), {
    decision: "APROBADO",
    offer: {
      initialPaymentPercentage: 15.5,
      suretyPercentage: 7.25,
      maxFinancedAmount: 1_800_000,
      policyVersion: 7,
    },
  });
  assert.deepEqual(resolveDataCreditoDecision(policy, "IPHONE", 699), {
    decision: "RECHAZADO",
    offer: {
      initialPaymentPercentage: 50,
      suretyPercentage: 25,
      maxFinancedAmount: 850_000,
      policyVersion: 7,
    },
  });
  assert.equal(resolveDataCreditoDecision(policy, "ANDROID", -2), null);
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

test("exige un tope de credito entero, positivo y acotado por banda", () => {
  for (const maxFinancedAmount of [undefined, 0, -1, 850_000.5, 100_000_001]) {
    const bands = completeBands();
    bands[0] = { ...bands[0], maxFinancedAmount };

    assert.throws(
      () => parseDataCreditoPolicyBands(bands),
      (error) =>
        error instanceof DataCreditoPolicyValidationError &&
        error.issues.some((issue) => issue.includes("credito maximo"))
    );
  }

  const bands = completeBands();
  bands[0] = { ...bands[0], maxFinancedAmount: 100_000_000 };
  assert.equal(
    parseDataCreditoPolicyBands(bands)[1].maxFinancedAmount,
    100_000_000
  );
});
