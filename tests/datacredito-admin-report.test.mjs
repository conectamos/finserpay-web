import assert from "node:assert/strict";
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
    "identity",
    "risk",
    "totals",
    "sectors",
    "balanceEvolution",
    "revolvingEvolution",
    "paymentHistory",
    "indebtedness",
    "suggestions",
  ]);
  assert.equal(summary.identity.queriedDocumentNumber, "900123456");
  assert.equal(summary.identity.documentNumber, "900123456");
  assert.equal(summary.risk.score, 885);
  assert.equal(summary.totals.delinquentBalance, 43000);
  assert.equal(summary.totals.activeCredits, 7);

  const telcos = summary.sectors.find((sector) => sector.isTelcos);
  assert.ok(telcos);
  assert.equal(telcos.sector, "Sector Telcos");
  assert.equal(telcos.activeCredits, 2);
  assert.equal(telcos.delinquentBalance, 35000);
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
