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
  DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT,
  DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT,
  DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT,
  DATACREDITO_NO_INFORMATION_SCORE,
  DATACREDITO_RISK_METRIC_VERSION,
  DataCreditoPolicyValidationError,
  isDataCreditoNoInformationScore,
  normalizeDataCreditoPlatform,
  parseDataCreditoPolicyBands,
  parseDataCreditoPolicyPriorityRules,
  resolveDataCreditoDecision,
  resolveDataCreditoOfferFinancingTerms,
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

function finserCommercialBands() {
  const rules = [
    [-1, -1, 40, 85, 600_000],
    [0, 200, 30, 80, 850_000],
    [201, 400, 20, 75, 1_000_000],
    [401, 500, 15, 70, 1_200_000],
    [501, 700, 10, 60, 1_800_000],
    [701, 800, 5, 40, 2_200_000],
    [801, 950, 0, 25, 2_500_000],
  ];

  return ["ANDROID", "IPHONE"].flatMap((platform) =>
    rules.map(
      ([scoreMin, scoreMax, initialPaymentPercentage, suretyPercentage, maxFinancedAmount]) => ({
        id: platform.toLowerCase() + "-" + scoreMin + "-" + scoreMax,
        platform,
        scoreMin,
        scoreMax,
        decision: "APROBADO",
        initialPaymentPercentage,
        suretyPercentage,
        maxFinancedAmount,
      })
    )
  );
}

function strictFinancingBands() {
  return completeBands().map((band) => ({
    ...band,
    installmentCount:
      band.platform === "IPHONE"
        ? DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT
        : DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT,
    maxInstallmentAmount:
      band.platform === "IPHONE"
        ? DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT
        : null,
  }));
}

test("normaliza unicamente las plataformas soportadas", () => {
  assert.equal(normalizeDataCreditoPlatform(" android "), "ANDROID");
  assert.equal(normalizeDataCreditoPlatform("iPhone"), "IPHONE");
  assert.equal(normalizeDataCreditoPlatform("WEB"), null);
});

test("resuelve terminos historicos solo cuando los campos no existen", () => {
  assert.deepEqual(resolveDataCreditoOfferFinancingTerms("ANDROID", {}), {
    installmentCount: DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT,
    maxInstallmentAmount: null,
    usedLegacyFallback: true,
  });
  assert.deepEqual(resolveDataCreditoOfferFinancingTerms("IPHONE", {}), {
    installmentCount: DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT,
    maxInstallmentAmount: DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT,
    usedLegacyFallback: true,
  });
  assert.deepEqual(
    resolveDataCreditoOfferFinancingTerms("IPHONE", {
      installmentCount: 36,
      maxInstallmentAmount: 175_000,
    }),
    {
      installmentCount: 36,
      maxInstallmentAmount: 175_000,
      usedLegacyFallback: false,
    }
  );

  assert.equal(
    resolveDataCreditoOfferFinancingTerms("ANDROID", {
      installmentCount: null,
    }),
    null
  );
  assert.equal(
    resolveDataCreditoOfferFinancingTerms("IPHONE", {
      installmentCount: 24,
      maxInstallmentAmount: null,
    }),
    null
  );
  assert.equal(
    resolveDataCreditoOfferFinancingTerms("ANDROID", {
      installmentCount: 16,
      maxInstallmentAmount: 160_000,
    }),
    null
  );
});

test("exige terminos financieros explicitos al publicar una politica", () => {
  assert.throws(
    () =>
      parseDataCreditoPolicyBands(completeBands(), {
        requireFinancingTerms: true,
      }),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("plazo")) &&
      error.issues.some((issue) => issue.includes("tope de cuota"))
  );

  const strict = parseDataCreditoPolicyBands(strictFinancingBands(), {
    requireFinancingTerms: true,
  });
  assert.equal(
    strict.find((band) => band.platform === "ANDROID").installmentCount,
    16
  );
  assert.equal(
    strict.find((band) => band.platform === "ANDROID").maxInstallmentAmount,
    null
  );
  assert.equal(
    strict.find((band) => band.platform === "IPHONE").installmentCount,
    24
  );
  assert.equal(
    strict.find((band) => band.platform === "IPHONE").maxInstallmentAmount,
    160_000
  );

  for (const replacement of [
    { id: "android-bajo", installmentCount: 61 },
    { id: "android-bajo", maxInstallmentAmount: 160_000 },
    { id: "iphone-bajo", maxInstallmentAmount: null },
    { id: "iphone-bajo", maxInstallmentAmount: 100_000_001 },
  ]) {
    const bands = strictFinancingBands();
    const index = bands.findIndex((band) => band.id === replacement.id);
    bands[index] = { ...bands[index], ...replacement };
    assert.throws(
      () =>
        parseDataCreditoPolicyBands(bands, {
          requireFinancingTerms: true,
        }),
      DataCreditoPolicyValidationError
    );
  }
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

test("valida umbrales Telcos por plataforma y normaliza revisiones historicas", () => {
  assert.equal(
    parseDataCreditoPolicyPriorityRules(undefined, { optional: true }),
    null
  );

  const legacy = parseDataCreditoPolicyPriorityRules({
    telcoDelinquency: {
      enabled: true,
      rejectAboveCop: "2000000",
    },
  });
  assert.deepEqual(legacy, {
    telcoDelinquency: {
      enabled: true,
      rejectAboveCopByPlatform: {
        ANDROID: 2_000_000,
        IPHONE: 2_000_000,
      },
    },
  });

  const platformSpecific = parseDataCreditoPolicyPriorityRules({
    telcoDelinquency: {
      enabled: true,
      rejectAboveCopByPlatform: {
        ANDROID: 2_000_000,
        IPHONE: "750000",
      },
    },
  });
  assert.deepEqual(platformSpecific, {
    telcoDelinquency: {
      enabled: true,
      rejectAboveCopByPlatform: {
        ANDROID: 2_000_000,
        IPHONE: 750_000,
      },
    },
  });

  assert.throws(
    () => parseDataCreditoPolicyPriorityRules(undefined),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("regla prioritaria"))
  );
  assert.throws(
    () =>
      parseDataCreditoPolicyPriorityRules({
        telcoDelinquency: {
          enabled: true,
          rejectAboveCop: 2_000_000,
          rejectAboveCopByPlatform: {
            ANDROID: 2_000_000,
            IPHONE: 750_000,
          },
        },
      }),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("exactamente una"))
  );
  assert.throws(
    () =>
      parseDataCreditoPolicyPriorityRules({
        telcoDelinquency: {
          enabled: true,
          rejectAboveCopByPlatform: {
            ANDROID: 2_000_000,
          },
        },
      }),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some(
        (issue) => issue.includes("para iPhone") &&
          issue.includes("entre 1 y 100000000")
      )
  );
  assert.throws(
    () =>
      parseDataCreditoPolicyPriorityRules({
        telcoDelinquency: {
          enabled: "si",
          rejectAboveCopByPlatform: {
            ANDROID: 2_000_000.5,
            IPHONE: 750_000,
          },
        },
      }),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some((issue) => issue.includes("habilitada")) &&
      error.issues.some((issue) => issue.includes("para Android"))
  );
  assert.throws(
    () =>
      parseDataCreditoPolicyPriorityRules({
        telcoDelinquency: {
          enabled: true,
          rejectAboveCopByPlatform: {
            ANDROID: 2_000_000,
            IPHONE: 100_000_001,
          },
        },
      }),
    (error) =>
      error instanceof DataCreditoPolicyValidationError &&
      error.issues.some(
        (issue) => issue.includes("para iPhone") &&
          issue.includes("entre 1 y 100000000")
      )
  );
});

test("la mora vigente Telcos usa el umbral estricto de cada plataforma", () => {
  const priorityRules = parseDataCreditoPolicyPriorityRules({
    telcoDelinquency: {
      enabled: true,
      rejectAboveCopByPlatform: {
        ANDROID: 2_000_000,
        IPHONE: 750_000,
      },
    },
  });
  const policy = {
    version: 22,
    bands: parseDataCreditoPolicyBands(completeBands()),
    priorityRules,
  };
  const thresholdsByPlatform =
    priorityRules.telcoDelinquency.rejectAboveCopByPlatform;

  for (const platform of ["ANDROID", "IPHONE"]) {
    const threshold = thresholdsByPlatform[platform];
    const lowTelcos = resolveDataCreditoDecision(policy, platform, 900, {
      telcoDelinquentBalanceCop: 100_000,
      telcoDelinquencyInformationAvailable: true,
    });
    assert.ok(lowTelcos);
    assert.equal(lowTelcos.decision, "APROBADO");

    const zeroTelcoDelinquency = resolveDataCreditoDecision(
      policy,
      platform,
      900,
      {
        telcoDelinquentBalanceCop: 0,
        telcoDelinquencyInformationAvailable: true,
      }
    );
    assert.equal(zeroTelcoDelinquency?.decisionRule, "SCORE_BAND");

    const atBoundary = resolveDataCreditoDecision(policy, platform, 900, {
      telcoDelinquentBalanceCop: threshold,
      telcoDelinquencyInformationAvailable: true,
    });
    assert.ok(atBoundary);
    assert.equal(atBoundary.decision, "APROBADO");
    assert.equal(atBoundary.decisionRule, "SCORE_BAND");
    assert.equal(atBoundary.offer.decisionRule, "SCORE_BAND");
    assert.equal(atBoundary.telcoRejectionThresholdCop, threshold);
    assert.equal(
      atBoundary.riskMetricVersion,
      DATACREDITO_RISK_METRIC_VERSION
    );

    const aboveBoundary = resolveDataCreditoDecision(policy, platform, 900, {
      telcoDelinquentBalanceCop: threshold + 1,
      telcoDelinquencyInformationAvailable: true,
    });
    assert.ok(aboveBoundary);
    assert.equal(aboveBoundary.decision, "RECHAZADO");
    assert.equal(
      aboveBoundary.decisionRule,
      "TELCO_DELINQUENCY_THRESHOLD"
    );
    assert.equal(
      aboveBoundary.offer.decisionRule,
      "TELCO_DELINQUENCY_THRESHOLD"
    );
    assert.equal(
      aboveBoundary.offer.telcoRejectionThresholdCop,
      threshold
    );
    assert.equal(
      aboveBoundary.offer.riskMetricVersion,
      "MIDECISOR_PN_MILES_COP_V1"
    );
    assert.equal("telcoDelinquentBalanceCop" in aboveBoundary, false);
    assert.equal("telcoDelinquentBalanceCop" in aboveBoundary.offer, false);

    const telcosNotReported = resolveDataCreditoDecision(
      policy,
      platform,
      900,
      {
        telcoDelinquentBalanceCop: null,
        telcoDelinquencyInformationAvailable: false,
      }
    );
    assert.ok(telcosNotReported);
    assert.equal(telcosNotReported.decision, "APROBADO");
    assert.equal(telcosNotReported.decisionRule, "SCORE_BAND");
  }

  const sameObservedDelinquency = {
    telcoDelinquentBalanceCop: 1_000_000,
    telcoDelinquencyInformationAvailable: true,
  };
  const android = resolveDataCreditoDecision(
    policy,
    "ANDROID",
    900,
    sameObservedDelinquency
  );
  const iphone = resolveDataCreditoDecision(
    policy,
    "IPHONE",
    900,
    sameObservedDelinquency
  );
  assert.equal(android?.decision, "APROBADO");
  assert.equal(android?.telcoRejectionThresholdCop, 2_000_000);
  assert.equal(iphone?.decision, "RECHAZADO");
  assert.equal(iphone?.telcoRejectionThresholdCop, 750_000);
});

test("Telcos informado con mora invalida falla cerrado y una revision historica usa puntaje", () => {
  const enabledPolicy = {
    version: 23,
    bands: parseDataCreditoPolicyBands(completeBands()),
    priorityRules: parseDataCreditoPolicyPriorityRules({
      telcoDelinquency: { enabled: true, rejectAboveCop: 2_000_000 },
    }),
  };
  for (const riskContext of [
    undefined,
    {},
    {
      telcoDelinquentBalanceCop: null,
      telcoDelinquencyInformationAvailable: null,
    },
    {
      telcoDelinquentBalanceCop: null,
      telcoDelinquencyInformationAvailable: true,
    },
    {
      telcoDelinquentBalanceCop: -1,
      telcoDelinquencyInformationAvailable: true,
    },
    {
      telcoDelinquentBalanceCop: 2_000_000.5,
      telcoDelinquencyInformationAvailable: true,
    },
    {
      telcoDelinquentBalanceCop: Number.MAX_SAFE_INTEGER + 1,
      telcoDelinquencyInformationAvailable: true,
    },
  ]) {
    assert.equal(
      resolveDataCreditoDecision(
        enabledPolicy,
        "ANDROID",
        900,
        riskContext
      ),
      null
    );
  }

  const historicalPolicy = {
    version: 23,
    bands: enabledPolicy.bands,
  };
  const historical = resolveDataCreditoDecision(historicalPolicy, "ANDROID", 900, {
    telcoDelinquentBalanceCop: 9_000_000,
    telcoDelinquencyInformationAvailable: true,
  });
  assert.ok(historical);
  assert.equal(historical.decision, "APROBADO");
  assert.equal(historical.decisionRule, "SCORE_BAND");
  assert.equal(historical.telcoRejectionThresholdCop, null);
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
        installmentCount: 16,
        maxInstallmentAmount: null,
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
      installmentCount: 16,
      maxInstallmentAmount: null,
      policyVersion: 7,
    },
  });
  assert.deepEqual(resolveDataCreditoDecision(policy, "IPHONE", 699), {
    decision: "RECHAZADO",
    offer: {
      initialPaymentPercentage: 50,
      suretyPercentage: 25,
      maxFinancedAmount: 850_000,
      installmentCount: 24,
      maxInstallmentAmount: 160_000,
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

test("aplica la política comercial en 885 y todos sus bordes", () => {
  const policy = {
    version: 21,
    bands: parseDataCreditoPolicyBands(finserCommercialBands()),
  };
  const cases = [
    [[-1], 40, 85, 600_000],
    [[0, 200], 30, 80, 850_000],
    [[201, 400], 20, 75, 1_000_000],
    [[401, 500], 15, 70, 1_200_000],
    [[501, 700], 10, 60, 1_800_000],
    [[701, 800], 5, 40, 2_200_000],
    [[801, 885, 950], 0, 25, 2_500_000],
  ];

  for (const platform of ["ANDROID", "IPHONE"]) {
    for (const [scores, initial, surety, maximum] of cases) {
      for (const score of scores) {
        assert.deepEqual(resolveDataCreditoDecision(policy, platform, score), {
          decision: "APROBADO",
          offer: {
            initialPaymentPercentage: initial,
            suretyPercentage: surety,
            maxFinancedAmount: maximum,
            installmentCount:
              platform === "IPHONE"
                ? DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT
                : DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT,
            maxInstallmentAmount:
              platform === "IPHONE"
                ? DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT
                : null,
            policyVersion: 21,
          },
        });
      }
    }
  }
});
