import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { runProductionVerification, verificationRequestKey, verifyReport, verifyWorkbook } from "../scripts/verify-cut-collection-production.mjs";

const jiti = createJiti(import.meta.url);
const { buildCutCollectionWorkbook } = await jiti.import("../lib/cut-collection-excel.ts");
function fixture() {
  const rows = ["1.234", "1234"].map((document, index) => ({
    key: `${index + 1}:2`, creditId: index + 1, installment: 2, clientName: "Cliente de prueba", document, folio: `CR-${index}`,
    aliadoId: 1, aliado: "Aliado", sedeId: 1, sede: "Sede", dueDate: "2026-10-17", installmentAmount: 100,
    priorPayments: 20, expected: 80, received: 0, pending: 80, priorReversals: 0, lastPaymentAt: null,
    status: "parcial", warning: null, payments: [], previousRecovery: 0, futureAdvances: 0,
  }));
  return { ok: true, cutDate: "2026-10-17", asOf: "2026-10-14T16:00:00.000Z", projection: null,
    filters: { day: 17, month: 10, year: 2026, status: "todos", aliadoId: null, sedeId: null }, rows,
    summary: { expected: 160, received: 0, pending: 160, completion: 0, pendingClients: 1,
      priorPayments: 40, priorReversals: 0, previousRecovery: 0, futureAdvances: 0 },
    history: [], historyPage: 0, historyHasMore: false, options: { aliados: [], sedes: [] }, warnings: [] };
}

test("verificador valida tarjetas, detalle, normalización de cliente y archivo Excel real", async () => {
  const report = fixture();
  assert.equal(verifyReport(report), report);
  const bytes = await buildCutCollectionWorkbook(report).xlsx.writeBuffer();
  await verifyWorkbook(bytes, report);
  const wrong = structuredClone(report);
  wrong.summary.expected++;
  assert.throws(() => verifyReport(wrong), /card_detail_total_mismatch/);
  await assert.rejects(verifyWorkbook(bytes, wrong), /excel_summary_mismatch/);
});

test("verificador detecta filtros ignorados y movimientos duplicados sin revelar valores", () => {
  const report = fixture();
  assert.throws(() => verifyReport(report, { status: "pagado" }), /status_filter_ignored/);
  assert.throws(() => verifyReport(report, { status: "todos", sedeId: 2 }), /foreign_site_in_rows/);
  report.rows[1].key = report.rows[0].key;
  assert.throws(() => verifyReport(report), /wrong_or_duplicate_installment/);
});

test("clave idempotente es UUID estable por destino, sin secretos ni datos personales", () => {
  const first = verificationRequestKey("https://finserpay.com");
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, verificationRequestKey("https://finserpay.com"));
  assert.notEqual(first, verificationRequestKey("https://example.up.railway.app"));
});

test("configuración falla antes de red y nunca imprime credenciales ni errores internos", async () => {
  const messages = [];
  const original = console.log;
  console.log = value => messages.push(value);
  try {
    assert.equal(await runProductionVerification(["--help"], {}), 0);
    assert.equal(await runProductionVerification([], {}), 1);
    assert.equal(await runProductionVerification(["--write-all"], {}), 1);
    assert.equal(await runProductionVerification([], { DATABASE_URL: "postgres://secret-connection", SESSION_SECRET: "secret-signing",
      FINSERPAY_VERIFY_BASE_URL: "https://outside.example" }), 1);
    assert(messages.some(value => value.includes("unapproved_base_host")));
    assert.doesNotMatch(messages.join("\n"), /secret-connection|secret-signing|outside\.example/);
  } finally { console.log = original; }
});
