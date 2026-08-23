import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildDataCreditoAdminRiskSummary,
  sanitizeDataCreditoProviderPayload,
} = await jiti.import("../lib/datacredito/admin-report.ts");
const { parseDataCreditoQueryResponse } = await jiti.import(
  "../lib/datacredito/response.ts"
);
const adminConsoleSource = await readFile(
  new URL(
    "../app/dashboard/datacredito/datacredito-admin-console.tsx",
    import.meta.url
  ),
  "utf8"
);

function providerPayload() {
  return {
    status: "ACCEPTED",
    access_token: "root-secret-token",
    content: {
      authorization: "Bearer nested-secret-token",
      infoTransaccion: {
        fechaConsulta: "2026-08-19",
        horaConsulta: "12:00:00",
        tipoIdDigitado: "CC",
        numeroIdDigitado: "900123456",
        apellidoDigitado: "APELLIDO",
        cookie: "secret-cookie",
        codigosRespuesta: [
          { clave: "CC", valor: "00", password: "secret-password" },
          { clave: "TX", valor: "05" },
        ],
      },
      respuesta: {
        validacion: {
          conInformacion: true,
          datosBasicos: {
            conInformacion: true,
            primerNombre: "NOMBRE",
            segundoNombre: "SEGUNDO",
            primerApellido: "APELLIDO",
            segundoApellido: "SEGUNDO APELLIDO",
            tipoDocumento: "CC",
            numeroDocumento: "900123456",
            estadoDocumento: "Vigente",
            rangoEdad: "36-45",
            client_secret: "nested-client-secret",
          },
        },
        comportamientoCrediticio: {
          conInformacion: true,
          evolucionSaldoCuotaPN: {
            conInformacion: true,
            trimestres: [
              {
                trimestre: "2026-06",
                saldoTotal: "1200000.0",
                cuotaTotal: "85000.0",
              },
            ],
          },
          evolucionRoPN: {
            conInformacion: true,
            trimestres: [
              {
                trimestre: "2026-06",
                saldoTotal: "600000.0",
                cupoTotal: "1000000.0",
                porcentajeDeuda: "60.0",
              },
            ],
          },
          comportamientoPago: {
            conInformacion: true,
            vectorComportamiento: [
              { anioMes: "2026-06", comportamiento: "N" },
              { anioMes: "2026-07", comportamiento: "1" },
            ],
          },
          indicadoresValores: {
            conInformacion: true,
            creditosVigentes: "7",
            creditosCerrados: "11",
            totalPrincipal: "17",
            totalCodeudorOtros: "1",
            valorInicial: "2500000",
            saldoActual: "1200000",
            valorCuota: "85000",
            saldoMora: "43000",
            porcentajeDeuda: "48.0",
            sectores: [
              {
                sector: "Sector Financiero",
                creditosVigentes: "5",
                creditosCerrados: "8",
                totalPrincipal: "13",
                totalCodeudorOtros: "0",
                valorInicial: "2000000",
                saldoActual: "1100000",
                valorCuota: "70000",
                saldoMora: "8000",
                porcentajeDeuda: "55.0",
              },
              {
                sector: "Sector Telcos",
                creditosVigentes: "2",
                creditosCerrados: "3",
                totalPrincipal: "4",
                totalCodeudorOtros: "1",
                valorInicial: "500000",
                saldoActual: "100000",
                valorCuota: "15000",
                saldoMora: "35000",
                porcentajeDeuda: "20.0",
                api_key: "nested-api-key",
              },
            ],
          },
        },
        informacionRiesgo: {
          conInformacion: true,
          score: "885",
          txtProbabilidad: "Probabilidad alta de pago.",
          viabilidad: "ALTA",
          ratingRecaudos: "A",
          txtRecaudos: "Cumplimiento esperado alto.",
          montoSugerido: "2500000",
          token: "nested-risk-token",
          alertas: [
            {
              alerta: "Sin coincidencias relevantes.",
              colocacion: "2026-08-18",
              modificacion: "2026-08-18",
            },
          ],
        },
        endeudamiento: {
          conInformacion: true,
          ingreso: "5000000.0",
          porcentajeCuotaVsIngreso: "31.5",
        },
        sugerencias: {
          conInformacion: true,
          vectorSugerencias: [
            {
              titulo: "Verificar ingresos",
              sugerencia: [
                {
                  icono: "ignored-provider-icon",
                  descripcion: "Solicitar soporte reciente de ingresos.",
                  password: "nested-suggestion-password",
                },
              ],
            },
          ],
        },
      },
    },
  };
}

test("conserva el score 885 y construye el resumen PN de mora y Telcos", () => {
  const payload = providerPayload();
  const parsed = parseDataCreditoQueryResponse(payload, 12.4);
  const summary = buildDataCreditoAdminRiskSummary(payload);

  assert.equal(parsed.outcome, "SCORE");
  assert.equal(parsed.score, 885);
  assert.ok(summary);
  assert.deepEqual(Object.keys(summary), [
    "transaction",
    "validation",
    "identity",
    "risk",
    "indicatorValuesHaveInformation",
    "totals",
    "sectors",
    "telcos",
    "balanceEvolution",
    "revolvingEvolution",
    "paymentHistory",
    "indebtedness",
    "suggestions",
  ]);
  assert.deepEqual(summary.transaction, {
    providerStatus: "ACCEPTED",
    queryDate: "2026-08-19",
    queryTime: "12:00:00",
    responseCodes: [
      { key: "CC", value: "00" },
      { key: "TX", value: "05" },
    ],
  });
  assert.deepEqual(summary.validation, {
    hasInformation: true,
    basicDataHasInformation: true,
  });
  assert.equal(summary.identity.queriedDocumentNumber, "900123456");
  assert.equal(summary.identity.documentNumber, "900123456");
  assert.equal(summary.risk.score, 885);
  assert.equal(summary.indicatorValuesHaveInformation, true);
  assert.equal(summary.totals.delinquentBalance, 43000);
  assert.equal(summary.totals.activeCredits, 7);

  const telcos = summary.sectors.find((sector) => sector.isTelcos);
  assert.ok(telcos);
  assert.equal(telcos.sector, "Sector Telcos");
  assert.equal(telcos.activeCredits, 2);
  assert.equal(telcos.delinquentBalance, 35000);
  assert.deepEqual(summary.telcos, {
    available: true,
    sector: "Sector Telcos",
    activeCredits: 2,
    closedCredits: 3,
    principalCredits: 4,
    coDebtorOrOtherCredits: 1,
    initialAmount: 500000,
    currentBalance: 100000,
    installmentAmount: 15000,
    delinquentBalance: 35000,
    debtPercentage: 20,
    delinquencyStatus: "Con mora vigente agregada en Telcos",
  });
  assert.deepEqual(summary.paymentHistory, [
    { period: "2026-06", code: "N" },
    { period: "2026-07", code: "1" },
  ]);
  assert.deepEqual(summary.balanceEvolution[0], {
    period: "2026-06",
    totalBalance: 1200000,
    totalInstallment: 85000,
  });
  assert.equal(summary.revolvingEvolution[0].totalLimit, 1000000);
  assert.equal(summary.indebtedness.installmentToIncomePercentage, 31.5);
  assert.deepEqual(summary.suggestions, [
    {
      title: "Verificar ingresos",
      descriptions: ["Solicitar soporte reciente de ingresos."],
    },
  ]);
});

test("reconstruye el payload con allowlist y elimina secretos a cualquier nivel", () => {
  const sanitized = sanitizeDataCreditoProviderPayload(providerPayload());
  assert.ok(sanitized);
  assert.equal(
    sanitized.content.respuesta.informacionRiesgo.score,
    "885"
  );

  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    "access_token",
    "authorization",
    "client_secret",
    "password",
    "cookie",
    "api_key",
    "root-secret-token",
    "nested-secret",
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
  assert.equal(serialized.includes("ignored-provider-icon"), false);
});

test("limita arreglos y textos y cierra valores numericos o codigos invalidos", () => {
  const payload = providerPayload();
  const behavior =
    payload.content.respuesta.comportamientoCrediticio.comportamientoPago;
  const indicators =
    payload.content.respuesta.comportamientoCrediticio.indicadoresValores;

  behavior.vectorComportamiento = Array.from({ length: 50 }, (_, index) => ({
    anioMes: `2026-${index + 1}`,
    comportamiento: index === 0 ? "codigo-desconocido" : "N",
  }));
  indicators.sectores = Array.from({ length: 30 }, (_, index) => ({
    sector: `Sector ${index}`,
    saldoMora: index === 0 ? { unsafe: true } : "0",
  }));
  payload.content.respuesta.informacionRiesgo.txtProbabilidad = "x".repeat(5000);
  payload.content.respuesta.sugerencias.vectorSugerencias = Array.from(
    { length: 30 },
    (_, index) => ({
      titulo: `Sugerencia ${index}`,
      sugerencia: [],
    })
  );

  const sanitized = sanitizeDataCreditoProviderPayload(payload);
  const summary = buildDataCreditoAdminRiskSummary(payload);

  assert.ok(sanitized);
  assert.ok(summary);
  assert.equal(
    sanitized.content.respuesta.comportamientoCrediticio.comportamientoPago
      .vectorComportamiento.length,
    36
  );
  assert.equal(summary.paymentHistory[0].code, null);
  assert.equal(summary.sectors.length, 16);
  assert.equal(summary.sectors[0].delinquentBalance, null);
  assert.equal(summary.risk.probabilityText.length, 1000);
  assert.equal(summary.suggestions.length, 16);
  assert.equal(sanitizeDataCreditoProviderPayload(null), null);
  assert.equal(buildDataCreditoAdminRiskSummary({ status: "ACCEPTED" }), null);
});


test("clasifica la mora Telcos sin inferir pagos históricos", () => {
  const withoutDelinquency = providerPayload();
  const telcoWithoutDelinquency =
    withoutDelinquency.content.respuesta.comportamientoCrediticio.indicadoresValores
      .sectores[1];
  telcoWithoutDelinquency.saldoMora = "0";
  const zeroSummary = buildDataCreditoAdminRiskSummary(withoutDelinquency);
  assert.ok(zeroSummary);
  assert.equal(
    zeroSummary.telcos.delinquencyStatus,
    "Sin mora vigente agregada reportada"
  );
  assert.equal(zeroSummary.telcos.delinquentBalance, 0);

  const unknownDelinquency = providerPayload();
  const telcoUnknownDelinquency =
    unknownDelinquency.content.respuesta.comportamientoCrediticio.indicadoresValores
      .sectores[1];
  telcoUnknownDelinquency.saldoMora = null;
  const unknownSummary = buildDataCreditoAdminRiskSummary(unknownDelinquency);
  assert.ok(unknownSummary);
  assert.equal(unknownSummary.telcos.delinquencyStatus, "Mora no informada");
  assert.equal(unknownSummary.telcos.delinquentBalance, null);

  const invalidNegativeDelinquency = providerPayload();
  const telcoNegativeDelinquency =
    invalidNegativeDelinquency.content.respuesta.comportamientoCrediticio
      .indicadoresValores.sectores[1];
  telcoNegativeDelinquency.saldoMora = "-1";
  telcoNegativeDelinquency.creditosVigentes = "-2";
  telcoNegativeDelinquency.creditosCerrados = "2.5";
  const negativeSummary = buildDataCreditoAdminRiskSummary(
    invalidNegativeDelinquency
  );
  assert.ok(negativeSummary);
  assert.equal(negativeSummary.telcos.delinquencyStatus, "Mora no informada");
  assert.equal(negativeSummary.telcos.delinquentBalance, null);
  assert.equal(negativeSummary.telcos.activeCredits, null);
  assert.equal(negativeSummary.telcos.closedCredits, null);

  const withoutTelcos = providerPayload();
  withoutTelcos.content.respuesta.comportamientoCrediticio.indicadoresValores.sectores =
    withoutTelcos.content.respuesta.comportamientoCrediticio.indicadoresValores.sectores.filter(
      (sector) => sector.sector !== "Sector Telcos"
    );
  const absentSummary = buildDataCreditoAdminRiskSummary(withoutTelcos);
  assert.ok(absentSummary);
  assert.equal(absentSummary.telcos.available, false);
  assert.equal(absentSummary.telcos.delinquencyStatus, "Mora no informada");
  assert.equal(absentSummary.telcos.activeCredits, null);

  const explicitlyUnavailable = providerPayload();
  explicitlyUnavailable.content.respuesta.comportamientoCrediticio.indicadoresValores.conInformacion =
    false;
  const unavailableSummary = buildDataCreditoAdminRiskSummary(
    explicitlyUnavailable
  );
  assert.ok(unavailableSummary);
  assert.equal(unavailableSummary.indicatorValuesHaveInformation, false);
  assert.equal(unavailableSummary.totals, null);
  assert.deepEqual(unavailableSummary.sectors, []);
  assert.equal(unavailableSummary.telcos.available, false);
  assert.equal(unavailableSummary.telcos.delinquencyStatus, "Mora no informada");
});

test("conserva Telcos aunque el proveedor lo envíe después del límite sectorial", () => {
  const payload = providerPayload();
  const indicators =
    payload.content.respuesta.comportamientoCrediticio.indicadoresValores;
  const originalTelcos = indicators.sectores[1];
  indicators.sectores = [
    ...Array.from({ length: 18 }, (_, index) => ({
      sector: "Sector " + (index + 1),
      creditosVigentes: "1",
      saldoMora: "0",
    })),
    originalTelcos,
  ];

  const sanitized = sanitizeDataCreditoProviderPayload(payload);
  const summary = buildDataCreditoAdminRiskSummary(payload);
  assert.ok(sanitized);
  assert.ok(summary);
  assert.equal(
    sanitized.content.respuesta.comportamientoCrediticio.indicadoresValores
      .sectores.length,
    16
  );
  assert.equal(summary.sectors.length, 16);
  assert.equal(summary.telcos.available, true);
  assert.equal(summary.telcos.sector, "Sector Telcos");
});

test("ignora datos contradictorios cuando MiDecisor declara sin información", () => {
  const payload = providerPayload();
  const answer = payload.content.respuesta;
  answer.validacion.conInformacion = false;
  answer.comportamientoCrediticio.conInformacion = false;
  answer.informacionRiesgo.conInformacion = false;
  answer.endeudamiento.conInformacion = false;
  answer.sugerencias.conInformacion = false;

  const summary = buildDataCreditoAdminRiskSummary(payload);
  assert.ok(summary);
  assert.equal(summary.identity.queriedDocumentNumber, "900123456");
  assert.equal(summary.identity.queriedSurname, "APELLIDO");
  assert.equal(summary.identity.documentNumber, null);
  assert.equal(summary.identity.fullName, null);
  assert.equal(summary.indicatorValuesHaveInformation, false);
  assert.equal(summary.totals, null);
  assert.deepEqual(summary.sectors, []);
  assert.equal(summary.telcos.available, false);
  assert.deepEqual(summary.balanceEvolution, []);
  assert.deepEqual(summary.revolvingEvolution, []);
  assert.deepEqual(summary.paymentHistory, []);
  assert.equal(summary.risk.hasInformation, false);
  assert.equal(summary.risk.score, null);
  assert.equal(summary.risk.probabilityText, null);
  assert.equal(summary.risk.viability, null);
  assert.equal(summary.risk.collectionsRating, null);
  assert.equal(summary.risk.collectionsText, null);
  assert.equal(summary.risk.suggestedAmount, null);
  assert.deepEqual(summary.risk.alerts, []);
  assert.equal(summary.indebtedness, null);
  assert.deepEqual(summary.suggestions, []);
});

test("respeta flags false de subsecciones aunque incluyan filas", () => {
  const payload = providerPayload();
  const answer = payload.content.respuesta;
  answer.validacion.datosBasicos.conInformacion = false;
  answer.comportamientoCrediticio.evolucionSaldoCuotaPN.conInformacion = false;
  answer.comportamientoCrediticio.evolucionRoPN.conInformacion = false;
  answer.comportamientoCrediticio.comportamientoPago.conInformacion = false;

  const summary = buildDataCreditoAdminRiskSummary(payload);
  assert.ok(summary);
  assert.equal(summary.identity.queriedDocumentNumber, "900123456");
  assert.equal(summary.identity.documentNumber, null);
  assert.equal(summary.identity.firstName, null);
  assert.deepEqual(summary.balanceEvolution, []);
  assert.deepEqual(summary.revolvingEvolution, []);
  assert.deepEqual(summary.paymentHistory, []);
  assert.equal(summary.totals.currentBalance, 1200000);
});

test("la consola central presenta el expediente completo en secciones accesibles", () => {
  for (const heading of [
    "Resumen Telcos",
    "Identidad y validación",
    "Riesgo, recaudos y alertas",
    "Totales de obligaciones",
    "Obligaciones por sector",
    "Evolución de saldos y cuotas",
    "Evolución de productos rotativos",
    "Historial global de comportamiento de pago",
    "Endeudamiento",
    "Sugerencias de MiDecisor",
    "Información de la transacción",
  ]) {
    assert.ok(adminConsoleSource.includes(heading), heading);
  }

  assert.match(adminConsoleSource, /Operador[\s\S]*No informado por MiDecisor PN/);
  assert.match(adminConsoleSource, /Historial de incumplimiento Telco/);
  assert.match(
    adminConsoleSource,
    /Una mora de \$0 solo indica ausencia[\s\S]*no prueba pagos históricos ni[\s\S]*ausencia de mora histórica/
  );
  assert.match(
    adminConsoleSource,
    /Este vector es global: no corresponde específicamente a Telcos/
  );
  assert.match(adminConsoleSource, /Significado no disponible/);
  assert.match(
    adminConsoleSource,
    /Los montos, unidades y códigos son valores informados por[\s\S]*No deben usarse para automatizar un rechazo/
  );
  assert.match(
    adminConsoleSource,
    /Reutilizada · sin nueva consulta\/cobro/
  );
  assert.match(adminConsoleSource, /Original · consulta al proveedor/);
  assert.match(
    adminConsoleSource,
    /Las reutilizadas conservan una consulta vigente y no generan[\s\S]*una nueva consulta ni cobro/
  );
  assert.match(adminConsoleSource, /<span>Origen<\/span>/);
  assert.equal(
    (adminConsoleSource.match(/<AssessmentOriginStatus/g) || []).length,
    2,
    "El origen debe verse tanto en la lista como en el expediente"
  );
  assert.match(adminConsoleSource, /<caption className="sr-only">/);
  assert.match(adminConsoleSource, /aria-describedby="payment-code-legend"/);
  assert.match(
    adminConsoleSource,
    /Ver detalle técnico sanitizado de MiDecisor/
  );
  assert.ok(
    adminConsoleSource.includes("JSON.stringify(detail.providerData, null, 2)")
  );
});
