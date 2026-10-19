import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { store } from "./second-credit-authorization-fixture.mjs";
import { load } from "./mass-credit-sadmin-fixture.mjs";

const { buildCreditPaymentPlan } = load("lib/credit-payment-plan.ts");
const { calculateCreditEarlyPayoff } = load("lib/credit-early-payoff.ts");
const { createPrincipalPaymentQuote } = load("lib/credit-principal-payment.ts");

test("renovación por cédula usa el saldo global vigente, incluidos pagos anticipados y abonos a capital", async (t) => {
  const pg = new PGlite();
  const db = {
    async $queryRawUnsafe(sql, ...values) { return (await pg.query(sql, values)).rows; },
    async $executeRawUnsafe(sql, ...values) { return (await pg.query(sql, values)).affectedRows ?? 0; },
  };
  let sequence = 0;
  const nextDocument = () => `99000${String(++sequence).padStart(5, "0")}`;
  const insertCredit = async (documento, changes = {}) => {
    const values = { montoCredito: 1000, cuotaInicial: 100, estado: "GENERADO", aliadoId: 1, sedeId: 1, vendedorId: 1, ...changes };
    const [row] = await db.$queryRawUnsafe(`INSERT INTO "Credito"
      ("folio", "clienteDocumento", "montoCredito", "cuotaInicial", "estado", "aliadoId", "sedeId", "vendedorId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING "id"`,
    `TEST-${++sequence}`, documento, values.montoCredito, values.cuotaInicial, values.estado,
    values.aliadoId, values.sedeId, values.vendedorId);
    return row.id;
  };
  const pay = (creditoId, valor, estado = "ACTIVO") => db.$executeRawUnsafe(
    `INSERT INTO "CreditoAbono" ("creditoId","valor","estado") VALUES ($1,$2,$3)`, creditoId, valor, estado,
  );
  const eligibility = async (documento) => (await store.getSecondCreditEligibility(db, [documento])).get(documento);

  try {
    await pg.exec(`CREATE TABLE "SecondCreditAuthorization" (
      "id" UUID, "documento" TEXT, "active" BOOLEAN, "version" INTEGER, "reason" TEXT,
      "createdAt" TIMESTAMPTZ, "updatedAt" TIMESTAMPTZ, "createdByName" TEXT, "updatedByName" TEXT
    );
    CREATE TABLE "Credito" (
      "id" SERIAL PRIMARY KEY, "folio" TEXT, "clienteDocumento" TEXT, "montoCredito" FLOAT8,
      "cuotaInicial" FLOAT8, "estado" TEXT, "aliadoId" INTEGER, "sedeId" INTEGER, "vendedorId" INTEGER
    );
    CREATE TABLE "CreditoAbono" (
      "creditoId" INTEGER REFERENCES "Credito"("id"), "valor" FLOAT8, "estado" TEXT
    );`);

    await t.test("pago total libera la cédula sin depender del estado histórico ni del comercio original", async () => {
      for (const estado of ["GENERADO", "PAZ_Y_SALVO", "PAGADO"]) {
        const documento = nextDocument();
        const id = await insertCredit(`CC-${documento}`, { estado, aliadoId: 100, sedeId: 200, vendedorId: 300 });
        await pay(id, 400);
        await pay(id, 600);
        const result = await eligibility(documento);
        assert.equal(result.activeCredits, 0);
        assert.equal(result.canCreate, true);
        assert.equal(await store.assertSecondCreditEligibility(db, documento), null);
      }
    });

    await t.test("estado pagado y cuota inicial no sustituyen recaudos; pagos anulados no liberan", async () => {
      const documento = nextDocument();
      const id = await insertCredit(documento, { estado: "PAGADO", cuotaInicial: 1000 });
      await pay(id, 1000, "ANULADO");
      await pay(id, 999);
      assert.equal((await eligibility(documento)).canCreate, false);
      await assert.rejects(store.assertSecondCreditEligibility(db, documento), { code: "ACTIVE_CREDIT_EXISTS" });
      await pay(id, 1);
      assert.equal((await eligibility(documento)).canCreate, true);
    });

    await t.test("un crédito más reciente pagado no oculta otro con saldo en un aliado distinto", async () => {
      const documento = nextDocument();
      const unpaid = await insertCredit(documento, { aliadoId: 500, sedeId: 501, vendedorId: 502 });
      const paid = await insertCredit(documento, { aliadoId: 600, sedeId: 601, vendedorId: 602 });
      await pay(unpaid, 999);
      await pay(paid, 1000);
      const result = await eligibility(documento);
      assert.deepEqual(Array.from(result.activeCreditIds), [unpaid]);
      await assert.rejects(store.assertSecondCreditEligibility(db, documento), { code: "ACTIVE_CREDIT_EXISTS" });
    });

    await t.test("liquidación anticipada confirmada usa el total liquidado guardado", async () => {
      const documento = nextDocument();
      const terms = { montoCredito: 1200, saldoBaseFinanciado: 1000, valorInteres: 200, valorFianza: 0,
        valorCuota: 100, plazoMeses: 12, frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-11-01", today: "2026-10-19" };
      const abonos = [{ valor: 100, fechaAbono: "2026-10-18" }];
      const quote = calculateCreditEarlyPayoff({ ...terms, abonos });
      assert.equal(quote.eligible, true);
      assert.ok(quote.montoCreditoLiquidado < terms.montoCredito);
      const id = await insertCredit(documento, { montoCredito: quote.montoCreditoLiquidado });
      await pay(id, abonos[0].valor);
      assert.equal((await eligibility(documento)).canCreate, false);
      await pay(id, quote.capitalPendiente);
      assert.equal((await eligibility(documento)).canCreate, true);
    });

    await t.test("abono a capital reduce la obligación vigente pero sólo el saldo restante pagado libera", async () => {
      const documento = nextDocument();
      const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
        frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
      const abonos = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
      const quote = createPrincipalPaymentQuote({ plan: buildCreditPaymentPlan({ ...terms, abonos }),
        valor: 700000, capitalOriginal: 3500000, cuotaHabitual: 149700, abonos,
        conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
          fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliación sintética de prueba" } });
      assert.ok(quote.montoCreditoActualizado < terms.montoCredito);
      const id = await insertCredit(documento, { montoCredito: quote.montoCreditoActualizado });
      for (const abono of [...abonos, { valor: quote.abonoCapital }]) await pay(id, abono.valor);
      assert.equal((await eligibility(documento)).canCreate, false);
      await pay(id, quote.saldoPendienteDespues);
      assert.equal((await eligibility(documento)).canCreate, true);
    });

    await t.test("la venta nueva por otro aliado vuelve a reservar el saldo global de la cédula", async () => {
      const documento = nextDocument();
      const original = await insertCredit(documento, { aliadoId: 10, sedeId: 11, vendedorId: 12 });
      await pay(original, 1000);
      assert.equal(await store.assertSecondCreditEligibility(db, documento), null);
      const renewal = await insertCredit(documento, { aliadoId: 20, sedeId: 21, vendedorId: 22 });
      assert.deepEqual(Array.from((await eligibility(documento)).activeCreditIds), [renewal]);
      await assert.rejects(store.assertSecondCreditEligibility(db, documento), { code: "ACTIVE_CREDIT_EXISTS" });
    });
  } finally { await pg.close(); }
});
