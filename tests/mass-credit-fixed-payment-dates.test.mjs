import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { load, routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";

const { buildCreditPaymentPlan } = load("lib/credit-payment-plan.ts");

function fixture() {
  const credits = [];
  const db = {
    ...catalogs,
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('INSERT INTO "CreditSadminRegistration"')) return [{ creditoId: params[0] }];
      if (sql.includes('AS "requestHash"')) return credits.filter(credit => credit.contratoSnapshot.origen.requestId === params[0]).map(credit => ({
        id: credit.id, folio: credit.folio, row: credit.contratoSnapshot.origen.importReceipt,
        requestHash: credit.contratoSnapshot.origen.requestHash, batchId: credit.contratoSnapshot.origen.batchId,
      }));
      if (sql.includes("AS documento")) return credits.filter(credit => params[0].includes(credit.clienteDocumento))
        .map(credit => ({ documento: credit.clienteDocumento, folio: credit.folio }));
      return [];
    },
    $executeRawUnsafe: async () => 1,
    credito: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }) => {
        const credit = { ...data, id: credits.length + 1 }; credits.push(credit);
        return { id: credit.id, folio: credit.folio };
      },
    },
  };
  db.$transaction = work => work(db);
  return { route: routeFixture(db), credits };
}
const commit = () => ({ commit: true, sadminConfirmed: true, requestId: randomUUID() });
const dateKey = date => date.toISOString().slice(0, 10);

test("CSV and individual quincenal persist the 02/17 calendar without changing imported financial terms", async () => {
  for (const rows of [
    [sample(1, { frecuencia: "QUINCENAL", fecha: "2026-09-02", fechaPago: "2026-09-17", plazo: "35", cuota: "157050", valorCredito: "2800000" }),
      sample(2, { frecuencia: "QUINCENAL", fecha: "17/9/2026", fechaPago: "2/10/2026", plazo: "24" })],
    [sample(3, { frecuencia: "QUINCENAL", fecha: "2026-12-31", fechaPago: "2027-01-17", plazo: "30" })],
  ]) {
    const { route, credits } = fixture();
    const preview = await call(route, rows); assert.equal(preview.data.summary.invalid, 0);
    const request = commit(); const result = await call(route, rows, request);
    assert.equal(result.status, 200); assert.equal(result.data.created, rows.length);
    for (const [index, credit] of credits.entries()) {
      const row = rows[index]; const normalized = preview.data.rows[index].normalized;
      assert.equal(credit.frecuenciaPago, "QUINCENAL");
      assert.equal(dateKey(credit.fechaPrimerPago), normalized.fechaPago);
      assert.equal(dateKey(credit.fechaProximoPago), normalized.fechaPago);
      assert.equal(credit.contratoSnapshot.financiero.frecuenciaPago, "QUINCENAL");
      assert.equal(credit.contratoSnapshot.financiero.fechaPrimerPago.slice(0, 10), normalized.fechaPago);
      assert.equal(credit.valorCuota, Number(row.cuota)); assert.equal(credit.plazoMeses, Number(row.plazo));
      assert.equal(credit.saldoBaseFinanciado, Number(row.valorCredito));
      assert.equal(credit.montoCredito, Number(row.cuota) * Number(row.plazo));
      const plan = buildCreditPaymentPlan({ ...credit, today: "2026-01-01" });
      assert.equal(plan.installments.length, Number(row.plazo));
      assert.equal(plan.installments[0].fechaVencimiento, normalized.fechaPago);
      assert.ok(plan.installments.every(item => ["02", "17"].includes(item.fechaVencimiento.slice(-2))));
      assert.equal(plan.installments.reduce((sum, item) => sum + item.valorProgramado, 0), credit.montoCredito);
      assert.ok(plan.installments.every(item => item.valorProgramado === credit.valorCuota));
      const expectedHash = createHash("sha256").update(JSON.stringify({ rows, userId: 1 })).digest("hex");
      assert.equal(credit.contratoSnapshot.origen.requestHash, expectedHash);
    }
    assert.deepEqual((await call(route, rows, request)).data, result.data); assert.equal(credits.length, rows.length);
  }
});

test("a wrong quincenal first payment is reported per row before the complete CSV can create", async () => {
  const { route, credits } = fixture();
  const rows = [sample(1, { frecuencia: "QUINCENAL", fecha: "2026-09-05", fechaPago: "2026-09-19" }),
    sample(2, { frecuencia: "QUINCENAL", fecha: "2026-09-06", fechaPago: "2026-09-17" }),
    sample(3, { frecuencia: "QUINCENAL", fecha: "2026-09-21", fechaPago: "2026-10-17" })];
  const preview = await call(route, rows); assert.equal(preview.data.summary.invalid, 2);
  assert.match(preview.data.rows[0].errors.join(" "), /2026-09-17.*02 y 17/);
  assert.match(preview.data.rows[1].errors.join(" "), /2026-10-02.*02 y 17/);
  assert.equal(preview.data.rows[2].ok, true);
  assert.equal(preview.data.rows[0].normalized.fechaPago, "2026-09-19");
  const rejected = await call(route, rows, commit());
  assert.equal(rejected.data.commit, false); assert.equal(rejected.data.summary.invalid, 2); assert.equal(credits.length, 0);
});

test("explicit catorcenal aliases and monthly imports preserve their dates and original retry receipts", async () => {
  for (const [frequency, normalized, first, second] of [
    ["CATORCENAL", "CATORCENAL", "2026-09-15", "2026-09-29"],
    ["14", "CATORCENAL", "2026-09-15", "2026-09-29"],
    ["CADA 14 DIAS", "CATORCENAL", "2026-09-15", "2026-09-29"],
    ["MENSUAL", "MENSUAL", "2026-09-15", "2026-10-15"],
    ["30", "MENSUAL", "2026-09-15", "2026-10-15"],
    ["CADA 30 DIAS", "MENSUAL", "2026-09-15", "2026-10-15"],
  ]) {
    const { route, credits } = fixture(); const rows = [sample(1, { frecuencia: frequency })]; const request = commit();
    const result = await call(route, rows, request); assert.equal(result.data.created, 1);
    const credit = credits[0]; assert.equal(credit.frecuenciaPago, normalized); assert.equal(dateKey(credit.fechaPrimerPago), first);
    const plan = buildCreditPaymentPlan({ ...credit, today: "2026-01-01" });
    assert.equal(plan.installments[1].fechaVencimiento, second);
    const originalReceipt = JSON.stringify(credit.contratoSnapshot.origen.importReceipt);
    const hash = credit.contratoSnapshot.origen.requestHash;
    // A completed import returns its evidence even if the current row was administratively corrected later.
    credit.frecuenciaPago = "QUINCENAL"; credit.fechaPrimerPago = new Date("2026-09-17T12:00:00Z");
    assert.deepEqual((await call(route, rows, request)).data, result.data);
    assert.equal(credits.length, 1); assert.equal(credit.contratoSnapshot.origen.requestHash, hash);
    assert.equal(JSON.stringify(credit.contratoSnapshot.origen.importReceipt), originalReceipt);
  }
});