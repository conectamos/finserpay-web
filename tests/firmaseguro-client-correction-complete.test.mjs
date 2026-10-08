import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { clientCorrectionCase, clone, core, load, seals, statuses } from "./firmaseguro-client-correction-fixture.mjs";

async function fixture(t) {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(`CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY,"payload" JSONB NOT NULL,"estado" TEXT NOT NULL DEFAULT 'ABIERTO',
      "creditoId" INTEGER,"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "FirmaSeguroProcess" ("processUuid" TEXT PRIMARY KEY,"draftId" INTEGER,
      "supersededAt" TIMESTAMPTZ,"completedAt" TIMESTAMPTZ,"signedDocumentBase64" TEXT);`);
  const state = clientCorrectionCase({ signed: true });
  const calls = { locks: 0, writes: 0 };
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => { calls.writes++; return (await connection.query(sql, values)).affectedRows; },
  });
  const prisma = { ...adapter(database), $transaction: work => database.transaction(db => work(adapter(db))) };
  const service = load("lib/firmaseguro-client-correction-complete.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/firmaseguro-storage": { lockSolicitudOperationMutation: async () => { calls.locks++; } },
    "@/lib/approval-request-correction-core": core,
    "@/lib/credit-amortization-contract": seals,
    "@/lib/firmaseguro-status": statuses,
  });
  async function reset({ payload = state.updatedPayload, process = state.process, estado = "ABIERTO", creditoId = null } = {}) {
    await database.exec('TRUNCATE TABLE "CreditoBorrador", "FirmaSeguroProcess"');
    await database.query('INSERT INTO "CreditoBorrador"("id","payload","estado","creditoId") VALUES ($1,$2::jsonb,$3,$4)',
      [state.draft.id, JSON.stringify(payload), estado, creditoId]);
    await database.query('INSERT INTO "FirmaSeguroProcess" VALUES ($1,$2,$3,$4,$5)',
      [process.processUuid, process.draftId, process.supersededAt, process.completedAt, process.signedDocumentBase64]);
    calls.locks = 0; calls.writes = 0;
  }
  async function read() { return (await database.query('SELECT "payload" FROM "CreditoBorrador"')).rows[0].payload; }
  await reset();
  return { ...state, calls, reset, read, run: service.completeDraftClientCorrection };
}

test("el PDF corregido firmado y vigente libera la corrección una sola vez sin borrar sus datos ni fotos", async t => {
  const f = await fixture(t);
  assert.equal(await f.run(f.process), true);
  const saved = await f.read();
  assert.equal("firmaSeguroClientCorrectionPending" in saved, false);
  assert.equal(saved.firmaSeguroClientCorrectionReissueProcessUuid, f.process.processUuid);
  assert.ok(Date.parse(saved.firmaSeguroClientCorrectionReissuedAt));
  for (const field of [...core.REQUEST_CORRECTION_FIELDS, "clienteNombre", "clientePrimerApellido", "clienteDocumento",
    "fotoEntregaDataUrl", "fotoRemisionDataUrl", "contratoCedulaFrenteDataUrl", "valorEquipoTotal", "cuotaInicial", "fechaPrimerPago"])
    assert.equal(saved[field], f.updatedPayload[field], field);
  assert.deepEqual(saved.financialTermsSeal, f.updatedPayload.financialTermsSeal);
  assert.equal(await f.run(f.process), false);
  assert.equal(f.calls.writes, 1);
});

test("un recibo o estado sin PDF firmado no libera la corrección", async t => {
  const f = await fixture(t);
  for (const mutation of [
    { status: "CREATED", signedDocumentBase64: null, completedAt: null },
    { status: "COMPLETED", signedDocumentBase64: null },
    { completedAt: null }, { status: "CREATED" }, { status: "EXPIRED" },
    { status: "NOT_SIGNED" }, { status: "FAILED_SIGNED" }, { status: "PENDING_COMPLETE" },
    { signedDocumentBase64: Buffer.from("respuesta del proveedor").toString("base64") },
  ]) {
    await f.reset(); const previous = await f.read();
    assert.equal(await f.run({ ...f.process, ...mutation }), false, JSON.stringify(mutation));
    assert.deepEqual(await f.read(), previous);
    assert.equal(f.calls.writes, 0);
  }
});

test("la firma archivada, el proceso viejo y los identificadores de otra corrección no liberan la nueva", async t => {
  const f = await fixture(t);
  for (const mutation of [
    { supersededAt: new Date() }, { creditoId: 10 }, { processUuid: f.source.processUuid },
    { draftId: 999 }, { draftPayload: { ...f.process.draftPayload, firmaSeguroClientCorrectionId: randomUUID() } },
  ]) {
    await f.reset();
    assert.equal(await f.run({ ...f.process, ...mutation }), false);
    assert.equal((await f.read()).firmaSeguroClientCorrectionPending, true);
    assert.equal(f.calls.writes, 0);
  }
  await f.reset({ process: { ...f.process, supersededAt: new Date() } });
  assert.equal(await f.run(f.process), false, "se vuelve a verificar el archivo desde la base, no solo desde el objeto en memoria");
  await f.reset({ payload: { ...f.updatedPayload, firmaSeguroClientCorrectionId: randomUUID() } });
  assert.equal(await f.run(f.process), false);
});

test("las diferencias en cualquier dato corregido, cédula o primer apellido conservan el bloqueo", async t => {
  const f = await fixture(t);
  for (const field of [...core.REQUEST_CORRECTION_FIELDS, "clienteNombre", "clientePrimerApellido", "clienteDocumento"]) {
    const changed = { ...f.updatedPayload, [field]: "DATO DIFERENTE" };
    await f.reset({ payload: changed });
    assert.equal(await f.run(f.process), false, field);
    assert.deepEqual(await f.read(), changed);
    assert.equal(f.calls.writes, 0);
  }
});

test("no libera una solicitud cerrada, convertida en crédito o cuyo proceso dejó de estar firmado", async t => {
  const f = await fixture(t);
  for (const setup of [{ estado: "CERRADO" }, { creditoId: 8 },
    { process: { ...f.process, signedDocumentBase64: null } }, { process: { ...f.process, completedAt: null } }]) {
    await f.reset(setup);
    assert.equal(await f.run(f.process), false);
    assert.equal((await f.read()).firmaSeguroClientCorrectionPending, true);
  }
});

test("exige el mismo sello financiero íntegro de la nueva firma y conserva la fecha del contrato", async t => {
  const f = await fixture(t);
  for (const payload of [
    { ...f.updatedPayload, financialTermsSeal: f.seal },
    { ...f.updatedPayload, financialTermsSeal: null },
    { ...f.updatedPayload, financialTermsSeal: { ...f.built.seal, checksum: "0".repeat(64) } },
  ]) {
    await f.reset({ payload });
    assert.equal(await f.run(f.process), false);
    assert.equal(f.calls.writes, 0);
  }
  await f.reset(); const invalid = clone(f.process);
  invalid.draftPayload.financialTermsSeal.snapshot.fechaPrimerPago = "2026-11-17";
  assert.equal(await f.run(invalid), false);
  assert.equal(f.calls.writes, 0);
  assert.equal((await f.read()).fechaPrimerPago, f.original.fechaPrimerPago);
});
