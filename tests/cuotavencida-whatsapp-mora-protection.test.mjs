import assert from "node:assert/strict";
import test from "node:test";
import { fixture, credit } from "./cuotavencida-whatsapp-fixture.mjs";

async function protect(f, id, type = "PRORROGA", status = "APPROVED", days = 0) {
  await f.db.query(`INSERT INTO "CreditMoraExceptionRequest" VALUES($1,$2,$3,
    (clock_timestamp() AT TIME ZONE 'America/Bogota')::date+$4::int)`, [id, type, status, days]);
}

test("preview and batch exclude approved current prórrogas and exceptions, without changing historical decisions", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2), credit(3)] });
  await protect(f, 1, "PRORROGA"); await protect(f, 2, "EXCEPCION");
  const before = (await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows;
  const preview = await f.store.previewCuotaVencidaWhatsApp();
  assert.equal(preview.stats.excludedActiveMoraProtection, 2);
  assert.equal(preview.stats.eligibleCredits, 1); assert.equal(preview.stats.clients, 1);
  assert.equal(f.writes(), 0); assert.equal((await f.events()).length, 0);
  const { batch } = await f.create(); assert.equal(batch.total, 1);
  assert.equal(batch.stats.excludedActiveMoraProtection, 2);
  const { worker, sent } = f.run(); assert.equal((await worker()).accepted, 1);
  assert.equal(sent[0].telefono, "57" + credit(3).clienteTelefono);
  assert.deepEqual((await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows, before);
});

test("historical batch statistics preserve a missing protection count instead of inventing zero", async t => {
  const f = await fixture(t); const { batch } = await f.create();
  assert.equal(batch.stats.excludedActiveMoraProtection, 0, "Los lotes nuevos guardan el total real");
  await f.db.query(`UPDATE "CuotaVencidaWhatsAppBatch" SET "stats"="stats"-'excludedActiveMoraProtection' WHERE "id"=$1::uuid`, [batch.id]);
  const before = (await f.db.query('SELECT "stats" FROM "CuotaVencidaWhatsAppBatch" WHERE "id"=$1::uuid', [batch.id])).rows[0].stats;
  const historic = await f.store.getCuotaVencidaWhatsAppBatch({ batchId: batch.id });
  assert.equal(Object.hasOwn(historic.stats, "excludedActiveMoraProtection"), false);
  assert.equal(JSON.stringify(historic.stats).includes("excludedActiveMoraProtection"), false);
  assert.deepEqual((await f.db.query('SELECT "stats" FROM "CuotaVencidaWhatsAppBatch" WHERE "id"=$1::uuid', [batch.id])).rows[0].stats, before);
  for (const value of [-1, 1.5, "0", null]) {
    await f.db.query(`UPDATE "CuotaVencidaWhatsAppBatch" SET "stats"=jsonb_set("stats",'{excludedActiveMoraProtection}',$2::jsonb) WHERE "id"=$1::uuid`, [batch.id, JSON.stringify(value)]);
    assert.equal(Object.hasOwn((await f.store.getCuotaVencidaWhatsAppBatch({ batchId: batch.id })).stats, "excludedActiveMoraProtection"), false);
  }
});

test("expired, cancelled, rejected or pending requests do not suppress normal collection", async t => {
  const f = await fixture(t, { credits: Array.from({ length: 5 }, (_, index) => credit(index + 1)) });
  await protect(f, 1, "PRORROGA", "APPROVED", -1);
  await protect(f, 2, "PRORROGA", "CANCELLED"); await protect(f, 3, "EXCEPCION", "REJECTED");
  await protect(f, 4, "EXCEPCION", "PENDING"); await protect(f, 5, "EXCEPCION", "REPLACED");
  assert.equal((await f.store.previewCuotaVencidaWhatsApp()).stats.excludedActiveMoraProtection, 0);
  await f.create(); const { worker, sent } = f.run(); assert.equal((await worker()).accepted, 5); assert.equal(sent.length, 5);
});

test("approval after preview, batch or claim cancels queued notice without HTTP, removing no audit rows", async t => {
  for (const stage of ["preview", "batch", "claim"]) {
    const f = await fixture(t);
    assert.equal((await f.store.previewCuotaVencidaWhatsApp()).stats.clients, 1);
    if (stage === "preview") await protect(f, 1);
    const { batch } = await f.create();
    if (stage === "batch") await protect(f, 1);
    let overrides = {};
    if (stage === "claim") {
      const [claim] = await f.store.claimCuotaVencidaWhatsApp({ limit: 1 });
      await protect(f, 1); overrides = { claim: async () => [claim] };
    }
    const { worker, sent } = f.run(overrides); const report = await worker({ limit: 1 });
    assert.equal(sent.length, 0); assert.equal(report.accepted, 0);
    if (stage === "preview") assert.equal(batch.total, 0);
    else {
      const [event] = await f.events(); assert.equal(event.status, "CANCELLED");
      assert.equal(event.resultCode, "ACTIVE_MORA_PROTECTION");
      assert.equal((await f.db.query('SELECT count(*)::int n FROM "CuotaVencidaWhatsAppCoverage"')).rows[0].n, 1);
    }
  }
});

test("protection is per credit: another overdue credit of the same titular can still be collected", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2, {
    clienteDocumento: credit().clienteDocumento, clienteTelefono: credit().clienteTelefono,
  })] });
  await f.create(); await protect(f, 1);
  const { worker, sent } = f.run(); assert.equal((await worker()).accepted, 1);
  assert.equal(sent.length, 1); assert.equal(sent[0].nombre, credit(2).clienteNombre);
  assert.equal((await f.events())[0].representativeCreditoId, 2);
});

test("legacy document agreement still protects every credit under that complete document", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2, { clienteDocumento: credit().clienteDocumento })] });
  await f.db.query('INSERT INTO "ExcepcionBloqueoMora" VALUES($1,TRUE,NULL)', [credit().clienteDocumento]);
  const preview = await f.store.previewCuotaVencidaWhatsApp();
  assert.equal(preview.stats.excludedActiveMoraProtection, 2); assert.equal(preview.stats.clients, 0);
  await f.create(); assert.equal((await f.run().worker()).selected, 0);
});

test("dispatch starts while credit and event locks are still held, then persists one provider result", async t => {
  const f = await fixture(t); await f.create();
  const order = [];
  f.onQuery(sql => { if (/FROM "Credito"[\s\S]*FOR UPDATE/.test(sql)) order.push("credit-lock");
    if (/AS "protected"/.test(sql)) order.push("protection"); });
  const { worker } = f.run({ fetcher: async (_url, options) => {
    assert.equal(f.inTransaction(), true, "La transacción no libera locks entre comprobar la prórroga y comenzar HTTP");
    order.push("http"); const payload = JSON.parse(options.body);
    return Response.json({ ok: true, accepted: true, event_id: payload.event_id, provider_message_id: "wamid.protected-test", code: null });
  } });
  assert.equal((await worker()).accepted, 1);
  assert.ok(order.indexOf("credit-lock") < order.indexOf("protection"));
  assert.ok(order.indexOf("protection") < order.indexOf("http"));
  assert.equal((await f.events())[0].status, "ACCEPTED"); assert.equal((await worker()).selected, 0);
});
