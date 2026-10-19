import assert from "node:assert/strict";
import test from "node:test";
import { fixture, credit, requestId, requestId2 } from "./cuotavencida-whatsapp-fixture.mjs";
import { bloqueoWhatsAppSchemaStatements } from "../scripts/cuotavencida-whatsapp-schema.mjs";

async function protect(f, id, { type = "PRORROGA", status = "APPROVED", days = 0, indefinite = false } = {}) {
  await f.db.query(`INSERT INTO "CreditMoraExceptionRequest" VALUES($1,$2,$3,
    CASE WHEN $5::boolean THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'America/Bogota')::date+$4::int END)`,
  [id, type, status, days, indefinite]);
}
const sameOwner = (id, overrides = {}) => credit(id, { clienteDocumento: credit().clienteDocumento, ...overrides });

test("BLOQUEO selects only current mora at least one day with pending balance, primary mobile and unpaid installments", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(), credit(2, { fechaPrimerPago: "2026-10-18", fechaProximoPago: "2026-10-18" }),
    credit(3, { fechaPrimerPago: "2026-10-19", fechaProximoPago: "2026-10-19" }), credit(4, { estado: "PAGADO" }),
    credit(5, { abonos: [{ valor: 300, estado: "ACTIVO" }] }), credit(6, { clienteTelefono: "invalid" })] });
  const { batch } = await f.create(); assert.equal(batch.total, 1); assert.equal(batch.stats.eligibleCredits, 1);
  const { worker, sent } = f.run(); assert.equal((await worker()).accepted, 1);
  assert.equal(sent[0].telefono, "57" + credit().clienteTelefono);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["event_id", "nombre", "telefono"]);
  assert.equal((await f.store.getCuotaVencidaWhatsAppBatch()).status, "COMPLETED");
});

test("BLOQUEO and CUOTAVENCIDA keep independent daily batches, same-key replay, events and unknown outcomes", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO" });
  const cuota = f.storeFor("CUOTAVENCIDA");
  const results = await Promise.all([f.create(), f.create(), cuota.createCuotaVencidaWhatsAppBatch({ requestId, actorId: 51 })]);
  assert.equal(results[0].batch.id, results[1].batch.id); assert.notEqual(results[0].batch.id, results[2].batch.id);
  assert.equal(results.filter(result => result.created).length, 2);
  assert.equal((await f.events()).length, 1); assert.equal((await f.eventsFor("CUOTAVENCIDA")).length, 1);
  assert.equal(await f.store.getCuotaVencidaWhatsAppBatch({ batchId: results[2].batch.id }), null);
  assert.equal(await cuota.getCuotaVencidaWhatsAppBatch({ batchId: results[0].batch.id }), null);
  const [claim] = await f.store.claimCuotaVencidaWhatsApp(); await f.store.markCuotaVencidaWhatsAppUnknown(claim.eventId);
  assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  assert.equal((await cuota.claimCuotaVencidaWhatsApp()).length, 1);
  for (const sql of bloqueoWhatsAppSchemaStatements) await f.db.exec(sql);
  assert.equal((await f.events())[0].status, "UNKNOWN", "Reinstalling or another campaign never resets this ledger");
});

test("any protected credit of the titular excludes BLOQUEO, including another phone and a credit without mora", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(), sameOwner(2, {
    clienteDocumento: "1.000.000.001", fechaPrimerPago: "2026-11-02", fechaProximoPago: "2026-11-02",
  }), credit(3)] });
  await protect(f, 2);
  const before = (await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows;
  const preview = await f.store.previewCuotaVencidaWhatsApp();
  assert.equal(preview.stats.clients, 1); assert.equal(preview.stats.eligibleCredits, 1);
  assert.equal(preview.stats.excludedActiveMoraProtection, 1);
  const { batch } = await f.create(); assert.equal(batch.total, 1);
  assert.equal((await f.events())[0].representativeCreditoId, 3);
  const cuotaPreview = await f.storeFor("CUOTAVENCIDA").previewCuotaVencidaWhatsApp();
  assert.equal(cuotaPreview.stats.clients, 2, "Cuotavencida keeps its established per-credit protection rule");
  assert.deepEqual((await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows, before);
});

test("a protected identity found on a later page removes an earlier candidate without truncating or sending", async t => {
  const credits = Array.from({ length: 251 }, (_, i) => credit(i + 1, { estado: "PAGADO" }));
  credits[0] = credit(); credits[250] = sameOwner(251, { fechaPrimerPago: "2026-11-02", fechaProximoPago: "2026-11-02" });
  const f = await fixture(t, { campaign: "BLOQUEO", credits }); await protect(f, 251);
  const { batch } = await f.create(); assert.equal(batch.stats.scanned, 251); assert.equal(batch.total, 0);
  assert.equal(batch.stats.excludedActiveMoraProtection, 1);
  assert.equal((await f.run().worker()).selected, 0);
});

test("missing documents use the protected primary phone and leading document zeros never match a different titular", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(1, { clienteDocumento: null }),
    sameOwner(2, { clienteDocumento: null, clienteTelefono: credit().clienteTelefono, fechaPrimerPago: "2026-11-02", fechaProximoPago: "2026-11-02" }),
    credit(3, { clienteDocumento: "0012345" }), credit(4, { clienteDocumento: "12345" })] });
  await protect(f, 2); await protect(f, 4);
  const { batch } = await f.create(); assert.equal(batch.total, 1);
  assert.equal((await f.events())[0].representativeCreditoId, 3);
  assert.equal((await f.run().worker()).accepted, 1);
});

test("approved prórroga and exception remain protected through today or indefinitely; stale and undecided statuses do not", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: Array.from({ length: 9 }, (_, i) => credit(i + 1)) });
  await protect(f, 1); await protect(f, 2, { type: "EXCEPCION", indefinite: true });
  await protect(f, 3, { days: -1 });
  for (const [i, status] of ["PENDING", "REJECTED", "EXPIRED", "REPLACED", "CANCELLED"].entries()) await protect(f, i + 4, { status });
  const preview = await f.store.previewCuotaVencidaWhatsApp();
  assert.equal(preview.stats.clients, 7); assert.equal(preview.stats.excludedActiveMoraProtection, 2);
  await f.create(); assert.equal((await f.run().worker()).accepted, 7);
});

test("a protection approved after preview, batch or claim cancels the whole titular before HTTP", async t => {
  for (const stage of ["preview", "batch", "claim"]) {
    const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(), sameOwner(2, {
      fechaPrimerPago: "2026-11-02", fechaProximoPago: "2026-11-02",
    })] });
    assert.equal((await f.store.previewCuotaVencidaWhatsApp()).stats.clients, 1);
    if (stage === "preview") await protect(f, 2);
    const { batch } = await f.create();
    if (stage === "batch") await protect(f, 2);
    let overrides = {};
    if (stage === "claim") {
      const [claim] = await f.store.claimCuotaVencidaWhatsApp({ limit: 1 }); await protect(f, 2);
      overrides = { claim: async () => [claim] };
    }
    const { worker, sent } = f.run(overrides); assert.equal((await worker({ limit: 1 })).accepted, 0); assert.equal(sent.length, 0);
    if (stage === "preview") assert.equal(batch.total, 0);
    else {
      const [event] = await f.events(); assert.equal(event.status, "CANCELLED"); assert.equal(event.resultCode, "ACTIVE_MORA_PROTECTION");
      assert.equal((await f.db.query('SELECT count(*)::int n FROM "BloqueoWhatsAppCoverage"')).rows[0].n, 1);
    }
  }
});

test("a newly inserted protected credit on another phone is discovered outside the frozen batch coverage", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO" }); await f.create();
  const [claim] = await f.store.claimCuotaVencidaWhatsApp();
  await f.db.query('INSERT INTO "Credito" ("id","data") VALUES(2,$1::jsonb)', [JSON.stringify(sameOwner(2, {
    fechaPrimerPago: "2026-11-02", fechaProximoPago: "2026-11-02",
  }))]);
  await protect(f, 2);
  let calls = 0;
  assert.equal(await f.store.prepareCuotaVencidaWhatsAppDispatch(claim.eventId, async () => { calls++; }), null);
  assert.equal(calls, 0); assert.equal((await f.events())[0].resultCode, "ACTIVE_MORA_PROTECTION");
});

test("BLOQUEO cancels all covered credits after one gains protection while CUOTAVENCIDA still targets the unprotected credit", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(), sameOwner(2, { clienteTelefono: credit().clienteTelefono })] });
  const cuota = f.storeFor("CUOTAVENCIDA");
  await f.create(); await cuota.createCuotaVencidaWhatsAppBatch({ requestId, actorId: 51 }); await protect(f, 1);
  assert.equal((await f.run().worker()).accepted, 0);
  const [claim] = await cuota.claimCuotaVencidaWhatsApp(); let calls = 0;
  const prepared = await cuota.prepareCuotaVencidaWhatsAppDispatch(claim.eventId, async () => { calls++; });
  assert.ok(prepared); assert.equal(calls, 1); assert.equal((await f.eventsFor("CUOTAVENCIDA"))[0].representativeCreditoId, 2);
});

test("legacy document agreements protect all credits until the actual expiry; inactive and expired agreements do not", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(), sameOwner(2), credit(3), credit(4)] });
  await f.db.query('INSERT INTO "ExcepcionBloqueoMora" VALUES($1,TRUE,NULL)', [credit().clienteDocumento]);
  await f.db.query(`INSERT INTO "ExcepcionBloqueoMora" VALUES($1,TRUE,(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second'),
    ($2,FALSE,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day')`, [credit(3).clienteDocumento, credit(4).clienteDocumento]);
  const { batch } = await f.create(); assert.equal(batch.total, 2); assert.equal(batch.stats.excludedActiveMoraProtection, 2);
  assert.equal((await f.run().worker()).accepted, 2);
});

test("all titular credit locks remain held in ascending order during the bounded HTTP callback", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO", credits: [credit(), sameOwner(2, {
    fechaPrimerPago: "2026-11-02", fechaProximoPago: "2026-11-02",
  })] });
  await f.create(); const locks = [], order = [];
  f.onQuery((sql, values) => {
    if (/FROM "Credito"[\s\S]*FOR UPDATE/.test(sql)) { locks.push(values[0]); order.push("lock"); }
    if (/AS "protected"/.test(sql)) order.push("protection");
  });
  const { worker } = f.run({ fetcher: async (_url, options) => {
    assert.equal(f.inTransaction(), true); assert.deepEqual(locks, [1, 2]); order.push("http");
    const body = JSON.parse(options.body);
    return Response.json({ ok: true, accepted: true, event_id: body.event_id, provider_message_id: "wamid.bloqueo-locks", code: null });
  } });
  assert.equal((await worker()).accepted, 1);
  assert.ok(order.lastIndexOf("lock") < order.indexOf("protection"));
  assert.ok(order.lastIndexOf("protection") < order.indexOf("http"));
});

test("BLOQUEO holds UNKNOWN across a later explicit daily batch and never replays it or starts a new batch itself", async t => {
  const f = await fixture(t, { campaign: "BLOQUEO" }); const first = await f.create();
  const [claim] = await f.store.claimCuotaVencidaWhatsApp(); await f.store.markCuotaVencidaWhatsAppUnknown(claim.eventId);
  f.time("2026-10-19T15:00:00Z"); assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  assert.equal((await f.create()).batch.id, first.batch.id);
  const next = await f.create({ requestId: requestId2 }); assert.notEqual(next.batch.id, first.batch.id);
  assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  const status = await f.store.getCuotaVencidaWhatsAppBatch({ batchId: next.batch.id });
  assert.equal(status.status, "COMPLETED"); assert.equal(status.pending, 0); assert.equal(status.skipped, 1);
  assert.equal((await f.events())[0].status, "UNKNOWN");
});
