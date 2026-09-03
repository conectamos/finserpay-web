import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  aggregateDataCreditoQuerySalesReport,
  DataCreditoQuerySalesReportInputError,
  parseDataCreditoQuerySalesReportInput,
} from "../lib/datacredito/admin-query-sales-report-core.ts";

const reportSource = readFileSync(
  new URL("../lib/datacredito/admin-query-sales-report.ts", import.meta.url),
  "utf8"
);
const routeSource = readFileSync(
  new URL("../app/api/reportes/datacredito-ventas/route.ts", import.meta.url),
  "utf8"
);
const reportPageSource = readFileSync(
  new URL("../app/dashboard/reportes/datacredito-ventas/page.tsx", import.meta.url),
  "utf8"
);
const reportClientSource = readFileSync(
  new URL(
    "../app/dashboard/reportes/datacredito-ventas/datacredito-ventas-client.tsx",
    import.meta.url
  ),
  "utf8"
);
const reportCenterSource = readFileSync(
  new URL("../app/dashboard/reportes/page.tsx", import.meta.url),
  "utf8"
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

test("construye el dia Bogota como intervalo semiabierto exacto", () => {
  const result = parseDataCreditoQuerySalesReportInput({
    mode: "day",
    day: "2026-09-03",
    allyId: "17",
  });

  assert.equal(result.start.toISOString(), "2026-09-03T05:00:00.000Z");
  assert.equal(result.endExclusive.toISOString(), "2026-09-04T05:00:00.000Z");
  assert.deepEqual(result.period, {
    timezone: "America/Bogota",
    start: "2026-09-03T05:00:00.000Z",
    endExclusive: "2026-09-04T05:00:00.000Z",
    label: "03/09/2026",
  });
  assert.equal(result.filters.allyId, 17);
});

test("rechaza fechas imposibles y rangos invertidos", () => {
  for (const day of ["2026-02-29", "2026-02-30", "2026-13-01"]) {
    assert.throws(
      () => parseDataCreditoQuerySalesReportInput({ mode: "day", day }),
      DataCreditoQuerySalesReportInputError
    );
  }

  assert.throws(
    () =>
      parseDataCreditoQuerySalesReportInput({
        mode: "range",
        from: "2026-09-04",
        to: "2026-09-03",
      }),
    {
      name: "DataCreditoQuerySalesReportInputError",
      message: "La fecha inicial no puede ser posterior a la fecha final",
    }
  );
});

test("acepta rango inclusivo y lo cierra al inicio del dia siguiente", () => {
  const result = parseDataCreditoQuerySalesReportInput({
    mode: "range",
    from: "2028-02-29",
    to: "2028-03-02",
  });

  assert.equal(result.start.toISOString(), "2028-02-29T05:00:00.000Z");
  assert.equal(result.endExclusive.toISOString(), "2028-03-03T05:00:00.000Z");
  assert.deepEqual(result.filters, {
    mode: "range",
    allyId: null,
    day: null,
    month: null,
    from: "2028-02-29",
    to: "2028-03-02",
  });
});

test("calcula correctamente febrero bisiesto y el salto de diciembre", () => {
  const leapMonth = parseDataCreditoQuerySalesReportInput({
    mode: "month",
    month: "2028-02",
  });
  assert.equal(leapMonth.start.toISOString(), "2028-02-01T05:00:00.000Z");
  assert.equal(leapMonth.endExclusive.toISOString(), "2028-03-01T05:00:00.000Z");

  const december = parseDataCreditoQuerySalesReportInput({
    mode: "month",
    month: "2026-12",
  });
  assert.equal(december.start.toISOString(), "2026-12-01T05:00:00.000Z");
  assert.equal(december.endExclusive.toISOString(), "2027-01-01T05:00:00.000Z");
});

test("agrega aliados activos, historicos y Sin aliado excluyendo la central", () => {
  const result = aggregateDataCreditoQuerySalesReport({
    selectedAllyId: null,
    centralAllyIds: [2],
    allies: [
      { id: 1, name: "Activo sin actividad", code: "ACTIVO", active: true },
      { id: 2, name: "FINSER PAY", code: "FINSERPAY", active: true },
      { id: 3, name: "Aliado historico", code: "HIST", active: false },
      { id: 4, name: "Inactivo vacio", code: "VACIO", active: false },
    ],
    queryMetrics: [
      { allyId: 2, originalQueries: 20, reusedAssessments: 2 },
      { allyId: 3, originalQueries: 2, reusedAssessments: 1 },
      { allyId: null, originalQueries: 1, reusedAssessments: 0 },
    ],
    salesMetrics: [
      { allyId: 2, sales: 30 },
      { allyId: 3, sales: 3 },
      { allyId: null, sales: 2 },
    ],
  });

  assert.deepEqual(
    result.rows.map((row) => row.allyId),
    [1, 3, null]
  );
  assert.equal(result.rows.some((row) => row.allyId === 2), false);
  assert.equal(result.rows.some((row) => row.allyId === 4), false);

  const active = result.rows.find((row) => row.allyId === 1);
  assert.deepEqual(active, {
    allyId: 1,
    allyName: "Activo sin actividad",
    allyCode: "ACTIVO",
    active: true,
    originalQueries: 0,
    reusedAssessments: 0,
    sales: 0,
    salesVsOriginalQueriesPercent: null,
  });

  const historical = result.rows.find((row) => row.allyId === 3);
  assert.equal(historical?.active, false);
  assert.equal(historical?.salesVsOriginalQueriesPercent, 150);

  const withoutAlly = result.rows.find((row) => row.allyId === null);
  assert.equal(withoutAlly?.allyName, "Sin aliado");
  assert.equal(withoutAlly?.active, null);
  assert.equal(withoutAlly?.salesVsOriginalQueriesPercent, 200);

  assert.deepEqual(result.summary, {
    originalQueries: 3,
    reusedAssessments: 1,
    sales: 5,
    salesVsOriginalQueriesPercent: 166.7,
  });
});

test("no crea Sin aliado cuando el bucket nulo no tiene actividad", () => {
  const result = aggregateDataCreditoQuerySalesReport({
    selectedAllyId: null,
    centralAllyIds: [],
    allies: [{ id: 1, name: "Comercial", code: "COM", active: true }],
    queryMetrics: [
      { allyId: null, originalQueries: 0, reusedAssessments: 0 },
    ],
    salesMetrics: [{ allyId: null, sales: 0 }],
  });

  assert.deepEqual(result.rows.map((row) => row.allyId), [1]);
  assert.deepEqual(result.summary, {
    originalQueries: 0,
    reusedAssessments: 0,
    sales: 0,
    salesVsOriginalQueriesPercent: null,
  });
});

test("la agregacion respeta el filtro de aliado aun con entradas amplias", () => {
  const result = aggregateDataCreditoQuerySalesReport({
    selectedAllyId: 2,
    centralAllyIds: [],
    allies: [
      { id: 1, name: "Uno", code: "UNO", active: true },
      { id: 2, name: "Dos", code: "DOS", active: true },
    ],
    queryMetrics: [
      { allyId: 1, originalQueries: 9, reusedAssessments: 0 },
      { allyId: 2, originalQueries: 1, reusedAssessments: 0 },
    ],
    salesMetrics: [
      { allyId: 1, sales: 9 },
      { allyId: 2, sales: 1 },
    ],
  });

  assert.deepEqual(result.rows.map((row) => row.allyId), [2]);
  assert.equal(result.summary.originalQueries, 1);
  assert.equal(result.summary.sales, 1);
});

test("produccion consume el parser y agregador puros", () => {
  assert.equal(
    reportSource.includes("@/lib/datacredito/admin-query-sales-report-core"),
    true
  );
  assert.equal(
    reportSource.includes("parseDataCreditoQuerySalesReportInput(input)"),
    true
  );
  assert.equal(
    reportSource.includes("aggregateDataCreditoQuerySalesReport({"),
    true
  );
});

test("el SQL conserva las reglas de consultas y ventas", () => {
  assert.match(reportSource, /"reusedFromAssessmentId" IS NULL/);
  assert.match(reportSource, /"status" <> 'PENDING'/);
  assert.match(reportSource, /"durationMs" IS NOT NULL/);
  assert.match(reportSource, /'PROVIDER_OUTCOME_AMBIGUOUS'/);
  assert.match(reportSource, /"reusedFromAssessmentId" IS NOT NULL/);
  assert.match(reportSource, /COUNT\(DISTINCT credit\."id"\)/);
  assert.match(reportSource, /credit\."estado" <> 'ANULADO'/);
  assert.match(reportSource, /assessment\."creditId" = credit\."id"/);
  assert.match(reportSource, /"providerEnvironment" = \$3/);
  assert.match(reportSource, /"createdAt" >= \$1::timestamp/);
  assert.match(reportSource, /"createdAt" < \$2::timestamp/);
});

test("el route mantiene guard central, ambiente actual y no-store", () => {
  assert.match(routeSource, /getDataCreditoCentralAdmin\(\)/);
  assert.equal(routeSource.includes("getDataCreditoPublicConfig()"), true);
  assert.equal(routeSource.includes("provider.environment"), true);
  assert.equal(routeSource.includes("getDataCreditoRetentionDays()"), true);
  assert.equal(routeSource.includes("private, no-store"), true);
});

test("la interfaz y su tarjeta son exclusivas del admin central y usan el API sin cache", () => {
  assert.equal(
    reportPageSource.includes("requireCentralAdminDashboardAccess()"),
    true
  );
  assert.match(
    reportCenterSource,
    /href: "\/dashboard\/reportes\/datacredito-ventas"[\s\S]{0,300}permission: "central"/
  );
  assert.equal(
    reportClientSource.includes('fetch("/api/reportes/datacredito-ventas"'),
    true
  );
  assert.equal(reportClientSource.includes('cache: "no-store"'), true);
  assert.match(reportClientSource, /type FilterMode = "day" \| "month" \| "range"/);
  assert.equal(reportClientSource.includes('role="tabpanel"'), true);
  assert.equal(reportClientSource.includes('scope="row"'), true);
});

test("la suite ejecuta TypeScript con strip-types explicito", () => {
  const command = packageJson.scripts["test:datacredito"];
  assert.equal(command.includes("--experimental-strip-types"), true);
  assert.equal(
    command.includes("tests/datacredito-query-sales-report.test.mjs"),
    true
  );
});
