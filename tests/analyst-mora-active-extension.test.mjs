import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";
import { loadApprovalModule, approvalErrors, plain } from "./credit-approval-test-loader.mjs";

const dates = loadApprovalModule("lib/colombia-date.ts");
const types = loadApprovalModule("lib/analyst-mora-types.ts");
const now = new Date("2026-10-18T20:00:00Z");
async function fixture(t, count = 12) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "CreditoAbono" ("creditoId" INTEGER, "valor" NUMERIC(20,2), "estado" TEXT, "fechaAbono" TIMESTAMP(3));
    INSERT INTO "Usuario" VALUES(7);
    INSERT INTO "Credito" SELECT generate_series(1,${count});`);
  await installMoraExceptionRequestSchema({ query: (sql, values = []) => database.query(sql, values) });
  const reads = [];
  const prisma = { $queryRawUnsafe: async (sql, ...values) => {
    reads.push({ sql, values });
    return (await database.query(sql, values)).rows;
  } };
  const extensions = loadApprovalModule("lib/analyst-mora-extension.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/colombia-date": dates,
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
  async function add(creditoId, patch = {}) {
    const row = { id: randomUUID(), type: "PRORROGA", status: "APPROVED", source: "ANALYST_REQUEST",
      expiresOn: "2026-10-18", promiseAmount: 200, promiseDate: "2026-10-18", ...patch };
    await database.query(`INSERT INTO "CreditMoraExceptionRequest"
      ("id","creditoId","type","status","source","installmentNumber","installmentDueDate","expiresOn",
       "promiseAmount","promiseDate","reason","observation","createdByUserId","createdByName",
       "decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash","updatedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Plazo autorizado','Observación',7,'Analista',$11,$12,$13,$14,$15,$16)`,
      [row.id, creditoId, row.type, row.status, row.source, row.source === "CENTRAL_DIRECT" ? null : 1,
        row.source === "CENTRAL_DIRECT" ? null : "2026-10-17", row.expiresOn,
        row.source === "CENTRAL_DIRECT" ? null : row.promiseAmount,
        row.source === "CENTRAL_DIRECT" ? null : row.promiseDate,
        row.status === "PENDING" ? null : 7, row.status === "PENDING" ? null : "Responsable central",
        row.status === "PENDING" ? null : "2026-10-18T15:00:00Z", randomUUID(), "a".repeat(64), "2026-10-18T15:00:00Z"]);
    return row;
  }
  return { database, prisma, reads, extensions, add };
}

test("prórroga vigente incluye todo el día de Bogotá y desaparece al vencer sin mutar su registro", async t => {
  const f = await fixture(t);
  const row = await f.add(1);
  const beforeMidnight = await f.extensions.readActiveMoraExtensions([1, 1, -1, NaN], new Date("2026-10-19T04:59:59.999Z"));
  assert.deepEqual(plain(beforeMidnight.get(1)), { id: row.id, expiresOn: "2026-10-18", reason: "Plazo autorizado",
    approvedAt: "2026-10-18T15:00:00.000Z", approvedByName: "Responsable central", installmentNumber: 1, installmentDueDate: "2026-10-17" });
  assert.deepEqual(Array.from(f.reads[0].values[0]), [1]);
  assert.equal((await f.extensions.readActiveMoraExtensions([1], new Date("2026-10-19T05:00:00Z"))).size, 0);
  assert.equal((await f.database.query('SELECT "status" FROM "CreditMoraExceptionRequest" WHERE "id"=$1', [row.id])).rows[0].status, "APPROVED");
  assert.ok(f.reads.every(read => read.sql.startsWith("SELECT")));
});

test("solo una prórroga aprobada vigente cuenta: pendientes, rechazadas, canceladas, reemplazadas y excepciones no", async t => {
  const f = await fixture(t);
  await f.add(1);
  await f.add(2, { status: "PENDING" });
  await f.add(3, { status: "REJECTED" });
  await f.add(4, { status: "CANCELLED" });
  await f.add(5, { status: "REPLACED" });
  await f.add(6, { status: "EXPIRED" });
  await f.add(7, { type: "EXCEPCION" });
  await f.add(8, { expiresOn: "2026-10-17", promiseDate: "2026-10-17" });
  await f.add(9, { source: "CENTRAL_DIRECT", expiresOn: null });
  await f.add(10, { source: "CENTRAL_DIRECT", expiresOn: "2026-12-31" });
  const active = await f.extensions.readActiveMoraExtensions(Array.from({ length: 10 }, (_, i) => i + 1), now);
  assert.deepEqual(Array.from(active.keys()), [1, 9, 10]);
  assert.equal(active.get(9).expiresOn, null);
  assert.equal(active.get(10).expiresOn, "2026-12-31");
  assert.equal(f.reads.length, 1, "la cartera usa una consulta para todas las prórrogas");
  assert.equal((await f.extensions.readActiveMoraExtensions([], now)).size, 0);
  assert.equal(f.reads.length, 1);
});

test("la promesa cumplida deja de mostrarse activa, sin contar abonos anulados, anteriores o futuros", async t => {
  const f = await fixture(t);
  await f.add(1);
  await f.database.exec(`INSERT INTO "CreditoAbono" VALUES
    (1,100,'APROBADO','2026-10-18 16:00:00'),
    (1,200,'ANULADO','2026-10-18 17:00:00'),
    (1,200,'APROBADO','2026-10-17 17:00:00'),
    (1,200,'APROBADO','2026-10-18 22:00:00');`);
  assert.equal((await f.extensions.readActiveMoraExtensions([1], now)).size, 1);
  await f.database.exec(`INSERT INTO "CreditoAbono" VALUES(1,100,'APROBADO','2026-10-18 19:00:00');`);
  assert.equal((await f.extensions.readActiveMoraExtensions([1], now)).size, 0);
});

test("estado Prórroga es derivado, filtra antes de paginar y coincide en detalle sin reemplazar gestiones", async t => {
  const f = await fixture(t, 60);
  for (let id = 1; id <= 30; id++) await f.add(id);
  const credits = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, enMora: true, diasMora: 60 - index,
    folio: `FC-${index + 1}`, numeroCreditoVisible: `SA-${index + 1}`, clienteNombre: "Cliente sintético",
    clienteDocumento: "000000000", imei: "000000000000000", aliadoId: 2, aliadoNombre: "Aliado sintético" }));
  const events = credits.map(credit => ({ id: randomUUID(), creditoId: credit.id, action: "LLAMADA", managementStatus: "SIN_RESPUESTA",
    actedAt: now, createdAt: now, nextFollowUpAt: new Date("2026-10-19T18:00:00Z"), responsibleUserId: 7,
    responsibleName: "Analista", actorUserId: 7, actorName: "Analista", result: "No contesta", resultCode: "SIN_RESPUESTA" }));
  const service = loadApprovalModule("lib/analyst-mora-management.ts", {
    "@/lib/prisma": { default: { credito: { findMany: async () => credits }, $queryRawUnsafe: async (sql, id) =>
      sql.includes('FROM "CreditMoraManagementEvent"') ? id ? events.filter(event => event.creditoId === id) : events : [{ id: 7, nombre: "Analista" }] } },
    "@/lib/credit-approval-errors": approvalErrors, "@/lib/analyst-mora-access": {},
    "@/lib/analyst-mora-credit": { moraCreditSelect: {}, moraCreditSummary: value => value, readMoraCredit: async id => credits.find(credit => credit.id === id) },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-types": types, "@/lib/colombia-date": dates,
    "@/lib/analyst-mora-extension": f.extensions,
  });
  const first = await service.listMoraPortfolio(new URLSearchParams("status=PRORROGA"), now);
  assert.equal(first.total, 30); assert.equal(first.items.length, 25); assert.equal(first.hasMore, true);
  assert.ok(first.items.every(item => item.estadoGestion === "PRORROGA" && item.prorrogaActiva));
  assert.ok(first.items.every(item => item.ultimaGestion.managementStatus === "SIN_RESPUESTA"));
  const second = await service.listMoraPortfolio(new URLSearchParams("status=PRORROGA&page=2"), now);
  assert.equal(second.items.length, 5); assert.equal(second.hasMore, false);
  const without = await service.listMoraPortfolio(new URLSearchParams("status=SIN_RESPUESTA"), now);
  assert.equal(without.total, 30); assert.ok(without.items.every(item => item.id > 30 && !item.prorrogaActiva));
  const detail = await service.getMoraManagement(1, now);
  assert.equal(detail.credit.estadoGestion, "PRORROGA");
  assert.deepEqual(plain(detail.credit.prorrogaActiva), plain(first.items[0].prorrogaActiva));
  assert.equal(detail.history[0].managementStatus, "SIN_RESPUESTA");
  const expired = await service.listMoraPortfolio(new URLSearchParams("status=PRORROGA"), new Date("2026-10-19T05:00:00Z"));
  assert.equal(expired.total, 0);
  const reverted = await service.getMoraManagement(1, new Date("2026-10-19T05:00:00Z"));
  assert.equal(reverted.credit.estadoGestion, "SIN_RESPUESTA");
  assert.equal(reverted.credit.prorrogaActiva, null);
  // A manual outcome cannot fabricate a current authorization.
  events[31].resultCode = "PRORROGA_APROBADA";
  const mentioned = await service.getMoraManagement(32, now);
  assert.equal(mentioned.credit.estadoGestion, "SIN_RESPUESTA");
  assert.equal(mentioned.credit.prorrogaActiva, null);
});
