import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadApprovalModule, approvalErrors, roles } from "./credit-approval-test-loader.mjs";
import { analystMoraSchemaStatements, installAnalystMoraSchema } from "../scripts/analyst-mora-schema.mjs";

const types = loadApprovalModule("lib/analyst-mora-types.ts");
const dates = loadApprovalModule("lib/colombia-date.ts");
const numbers = loadApprovalModule("lib/credit-display-number.ts");
const actor = { id: 7, nombre: "Analista", centralAdmin: false };
const now = new Date("2026-10-06T20:00:00Z");
const valid = () => ({ action: "LLAMADA", actedAt: "2026-10-06T14:30:00-05:00", responsibleUserId: 7,
  result: "Cliente promete pagar", comment: "Se confirma fecha de abono", nextFollowUpAt: "2026-10-07T14:30:00-05:00",
  managementStatus: "PROMESA_PAGO", idempotencyKey: randomUUID() });
function management(prisma = {}, credit = {}) {
  return loadApprovalModule("lib/analyst-mora-management.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-approval-errors": approvalErrors,
    "@/lib/analyst-mora-access": { assertMoraActor: async (_db, input) => ({ ...input, nombre: `Usuario ${input.id}` }) },
    "@/lib/analyst-mora-credit": { moraCreditSelect: {}, moraCreditSummary: value => value, ...credit },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-types": types, "@/lib/colombia-date": dates,
  });
}
test("la gestión exige acción, responsable, resultado, comentario y seguimiento posterior con zona horaria", () => {
  const service = management();
  const parsed = service.parseMoraManagement(valid(), now);
  assert.equal(parsed.actedAt, "2026-10-06T19:30:00.000Z");
  for (const patch of [{ action: "BORRAR" }, { responsibleUserId: 0 }, { result: "" }, { comment: "" },
    { nextFollowUpAt: "2026-10-06T19:30:00Z" }, { actedAt: "2026-10-07T19:30:00Z" },
    { actedAt: "2026-10-06T14:30" }, { idempotencyKey: "falso" }, { montoCredito: 1 }]) {
    assert.throws(() => service.parseMoraManagement({ ...valid(), ...patch }, now), approvalErrors.CreditApprovalError);
  }
});
test("los filtros de gestión se aplican antes de paginar y el seguimiento usa fecha de Colombia", async () => {
  const credits = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, enMora: true, diasMora: i + 1,
    folio: `FC-${i + 1}`, numeroCreditoVisible: `SA-${i + 1}`, clienteNombre: "Cliente", clienteDocumento: "123",
    imei: "imei", aliadoId: 2, aliadoNombre: "Aliado" }));
  const events = credits.map(item => ({ ...valid(), id: randomUUID(), creditoId: item.id, responsibleName: "Analista",
    actorUserId: 7, actorName: "Analista", actedAt: now, nextFollowUpAt: new Date("2026-10-08T02:00:00Z"), createdAt: now }));
  const service = management({ credito: { findMany: async () => credits }, $queryRawUnsafe: async sql => sql.includes("DISTINCT ON") ? events : [{ id: 7, nombre: "Analista" }] });
  const first = await service.listMoraPortfolio(new URLSearchParams("followUp=2026-10-07&status=PROMESA_PAGO"));
  assert.equal(first.total, 30); assert.equal(first.items.length, 25); assert.equal(first.items[0].id, 30);
  const second = await service.listMoraPortfolio(new URLSearchParams("followUp=2026-10-07&page=2"));
  assert.equal(second.items.length, 5);
  assert.equal((await service.listMoraPortfolio(new URLSearchParams("followUp=2026-10-08"))).total, 0);
  for (const query of ["minDays=10&maxDays=1", "followUp=2026-02-30", "responsible=-1", "status=BORRADO", "page=0"]) {
    await assert.rejects(service.listMoraPortfolio(new URLSearchParams(query)), approvalErrors.CreditApprovalError);
  }
});
test("reenviar una gestión no la duplica y no permite reutilizar el envío con otro contenido", async () => {
  let stored; let inserts = 0; let locked = false;
  const db = { credito: { findUnique: async () => ({ enMora: true }) }, $queryRawUnsafe: async (sql, ...p) => {
    if (sql.includes('FROM "Credito"')) { locked = true; return [{ id: 81 }]; }
    if (sql.includes('WHERE "idempotencyKey"')) return stored ? [stored] : [];
    if (sql.startsWith("INSERT")) {
      assert.ok(locked); inserts++;
      stored = { id: p[0], creditoId: p[1], action: p[2], actedAt: new Date(p[3]), responsibleUserId: p[4], responsibleName: p[5], result: p[6], comment: p[7],
        nextFollowUpAt: new Date(p[8]), managementStatus: p[9], actorUserId: p[10], actorName: p[11], idempotencyKey: p[12], requestHash: p[13], createdAt: now };
      return [stored];
    }
    throw new Error(sql);
  } };
  const service = management({ $transaction: callback => callback(db) });
  const input = service.parseMoraManagement(valid(), now);
  assert.equal((await service.createMoraManagement(81, input, actor)).unchanged, false);
  const replay = await service.createMoraManagement(81, input, actor);
  assert.equal(replay.unchanged, true); assert.equal(inserts, 1); assert.equal("requestHash" in replay.item, false);
  await assert.rejects(service.createMoraManagement(81, { ...input, comment: "Otra observación" }, actor), error => error.code === "IDEMPOTENCY_CONFLICT");
});
test("un crédito sin mora conserva historial pero no admite nueva gestión de cobro", async () => {
  const db = { credito: { findUnique: async () => ({ enMora: false }) }, $queryRawUnsafe: async () => [] };
  await assert.rejects(management({ $transaction: callback => callback(db) }).createMoraManagement(81, valid(), actor), error => error.code === "NOT_OVERDUE");
});

function access({ shared, admin, analyst, rows = [] } = {}) {
  const service = loadApprovalModule("lib/analyst-mora-access.ts", {
    "@/lib/auth": { getSessionUser: async () => admin, getNominalApprovalAnalystSessionUser: async () => analyst },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/roles": roles, "@/lib/credit-approval-errors": approvalErrors,
  });
  const db = { $queryRawUnsafe: async sql => { assert.match(sql, /FINSERPAY/); assert.match(sql, /FOR SHARE OF u,s,a/); return rows; } };
  return { service, db };
}
test("mora solo admite analista nominal o administrador central; los enlaces no adquieren estas facultades", async () => {
  assert.equal((await access({ analyst: actor }).service.getMoraActor()).id, 7);
  assert.equal((await access({ admin: { id: 1, nombre: "Admin", activo: true, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" } }).service.getMoraActor()).centralAdmin, true);
  for (const options of [{}, { shared: null, analyst: actor }, { shared: { kind: "SHARED" }, analyst: actor }]) {
    await assert.rejects(access(options).service.getMoraActor(), error => error.status === 403);
  }
});
test("cada escritura revalida el rol activo y el analista no puede aprobar una excepción", async () => {
  const f = access({ rows: [{ nombre: "Nombre vigente", role: "ANALISTA_APROBACION" }] });
  assert.equal((await f.service.assertMoraActor(f.db, actor)).nombre, "Nombre vigente");
  await assert.rejects(f.service.assertMoraActor(f.db, actor, true), error => error.status === 403);
  const revoked = access();
  await assert.rejects(revoked.service.assertMoraActor(revoked.db, actor), error => error.status === 403);
});

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const paymentPlan = await jiti.import("../lib/credit-payment-plan.ts");
const summary = loadApprovalModule("lib/analyst-mora-credit.ts", {
  "@/lib/prisma": { default: {} }, "@/lib/credit-payment-plan": paymentPlan, "@/lib/colombia-date": dates,
  "@/lib/credit-display-number": numbers, "@/lib/credit-approval-errors": approvalErrors,
});
const credit = () => ({ id: 81, folio: "FC-81", clienteNombre: "Cliente", clienteDocumento: "123", clienteTelefono: "3001234567", estado: "ACTIVO",
  montoCredito: 1000000, valorCuota: 100000, plazoMeses: 10, frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date("2026-09-17T00:00:00Z"),
  fechaProximoPago: null, planCapitalVigente: null, pazYSalvoEmitidoAt: null, createdAt: now, fechaCredito: now, sede: { aliado: { id: 2, nombre: "Aliado" } },
  sadminRegistration: { numeroCredito: "010081", numeroCreditoConfirmado: true }, abonos: [{ valor: 125000, fechaAbono: new Date("2026-10-03T15:00:00Z") }],
  imei: "123456789012345", deviceUid: null, referenciaEquipo: "IPHONE 13", equipoMarca: "IPHONE", equipoModelo: "13" });
test("cartera muestra deuda real después de abonos y excluye créditos liquidados", () => {
  const source = credit(); const before = JSON.stringify(source);
  const row = summary.moraCreditSummary(source, now);
  assert.equal(row.valorVencido, 75000); assert.equal(row.diasMora, 4); assert.equal(row.numeroCreditoVisible, "010081");
  assert.equal(row.ultimoPago, "2026-10-03T15:00:00.000Z"); assert.equal(JSON.stringify(source), before);
  assert.equal(summary.moraCreditSummary({ ...source, pazYSalvoEmitidoAt: now }, now).enMora, false);
  assert.equal(summary.moraCreditSummary({ ...source, abonos: [] }, new Date("2026-09-17T14:00:00Z")).enMora, false, "la cuota no vence antes de finalizar su día");
});

function supports(prisma = {}) {
  return loadApprovalModule("lib/analyst-mora-support.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-approval-errors": approvalErrors,
    "@/lib/analyst-mora-access": { assertMoraActor: async (_db, input) => input },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/credit-approval-http": { isSameApprovalOrigin: request => !request.headers.get("origin") || request.headers.get("origin") === new URL(request.url).origin },
  });
}
test("los soportes verifican contenido, extensión y un sujeto válido", () => {
  const service = supports();
  assert.equal(service.moraSupportFileType(Buffer.from("%PDF-1.7"), "prueba.pdf"), "application/pdf");
  assert.equal(service.moraSupportFileType(Buffer.from([137,80,78,71,13,10,26,10]), "prueba.png"), "image/png");
  for (const [bytes, name] of [[Buffer.from("html"), "prueba.pdf"], [Buffer.from("%PDF-1.7"), "prueba.exe"]]) {
    assert.throws(() => service.moraSupportFileType(bytes, name), approvalErrors.CreditApprovalError);
  }
  assert.equal(service.parseMoraSupportSubject(new URLSearchParams({ creditoId: "81", subjectKind: "GESTION", subjectId: randomUUID() })).creditoId, 81);
  assert.throws(() => service.parseMoraSupportSubject(new URLSearchParams("creditoId=81&subjectKind=Credito&subjectId=falso")));
});
test("cargas vacías, mayores a 10 MB y de otro origen fallan antes de escribir", async () => {
  const service = supports({ $transaction: () => { throw new Error("No debe escribir"); } });
  const headers = { "x-credit-id": "81", "x-subject-kind": "GESTION", "x-subject-id": randomUUID(),
    "x-support-file-name": "documento.pdf", "x-support-reason": "Evidencia recibida", "idempotency-key": randomUUID() };
  for (const extra of [{}, { "content-length": "10485761" }, { origin: "https://otro.example" }]) {
    await assert.rejects(service.saveMoraSupport(new Request("https://finserpay.com/api/aprobaciones/soportes-mora", { method: "POST", headers: { ...headers, ...extra } }), actor), approvalErrors.CreditApprovalError);
  }
});
test("PostgreSQL embebido impide borrar historial o soportes y exige datos consistentes", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INT PRIMARY KEY); CREATE TABLE "Usuario" ("id" INT PRIMARY KEY); INSERT INTO "Credito" VALUES(81); INSERT INTO "Usuario" VALUES(7);');
  await installAnalystMoraSchema({ query: (sql, values) => db.query(sql, values) });
  await installAnalystMoraSchema({ query: (sql, values) => db.query(sql, values) });
  assert.ok(analystMoraSchemaStatements().length > 0);
  const id = randomUUID();
  await db.query(`INSERT INTO "CreditMoraManagementEvent" ("id","creditoId","action","actedAt","responsibleUserId","responsibleName","result","comment","nextFollowUpAt","managementStatus","actorUserId","actorName","idempotencyKey","requestHash")
    VALUES ($1,81,'LLAMADA','2026-10-06T19:30:00Z',7,'Analista','Contactado','Cliente promete pago','2026-10-07T19:30:00Z','PROMESA_PAGO',7,'Analista',$2,$3)`, [id, randomUUID(), "a".repeat(64)]);
  const supportId = randomUUID();
  await db.query(`INSERT INTO "CreditMoraSupport" ("id","creditoId","subjectKind","subjectId","fileName","mimeType","sizeBytes","bytes","reason","actorUserId","actorName","idempotencyKey","requestHash")
    VALUES ($1,81,'GESTION',$2,'prueba.pdf','application/pdf',8,$3,'Evidencia',7,'Analista',$4,$5)`, [supportId, id, Buffer.from("%PDF-1.7"), randomUUID(), "b".repeat(64)]);
  for (const table of ["CreditMoraManagementEvent", "CreditMoraSupport"]) {
    for (const mutation of [`DELETE FROM "${table}"`, `TRUNCATE "${table}"`, `UPDATE "${table}" SET "actorName"='Otra persona'`]) {
      await assert.rejects(db.query(mutation), error => error.code === "23514");
    }
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)).rows[0].n, 1);
  }
  await assert.rejects(db.query('DELETE FROM "Credito" WHERE id=81'), error => error.code === "23503");
});
