import assert from "node:assert/strict";
import test from "node:test";
import { fixture, credit, requestId, requestId2 } from "./cuotavencida-whatsapp-fixture.mjs";
import { cuotaVencidaWhatsAppSchemaStatements } from "../scripts/cuotavencida-whatsapp-schema.mjs";

test("read-only preview scans every page beyond 5000 without PII, writes, or messages", async t => {
  const credits = Array.from({ length: 5001 }, (_, index) => credit(index + 1, index === 5000 ? {} : { estado: "PAGADO" }));
  const f = await fixture(t, { credits });
  const result = await f.store.previewCuotaVencidaWhatsApp();
  assert.equal(result.stats.scanned, 5001); assert.equal(result.stats.eligibleCredits, 1); assert.equal(result.stats.clients, 1);
  assert.equal(f.writes(), 0); assert.equal((await f.events()).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /CLIENTE|300000|100000|telefono|nombre|document/);
  const batch = await f.create(); assert.equal(batch.batch.total, 1);
  assert.equal((await f.events())[0].representativeCreditoId, 5001);
});

test("same-key replay and concurrent different clicks share exactly one audited daily batch and immutable cohort", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2)] });
  const results = await Promise.all([f.create(), f.create(), f.create({ requestId: requestId2 })]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(new Set(results.map(result => result.batch.id)).size, 1);
  assert.equal((await f.events()).length, 2);
  const rows = (await f.db.query('SELECT * FROM "CuotaVencidaWhatsAppBatch"')).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].actorId, 51);
  await f.db.query('INSERT INTO "Credito" ("id","data") VALUES(3,$1::jsonb)', [JSON.stringify(credit(3))]);
  assert.equal((await f.create({ requestId: "1df2ddc9-b0bb-4148-baa0-050000000003" })).created, false);
  assert.equal((await f.events()).length, 2, "A replay must not silently extend the confirmed cohort");
  await assert.rejects(f.create({ actorId: 52, requestId: rows[0].requestId }), error => error.code === "REQUEST_SCOPE_MISMATCH");
  const writes = f.writes(); const summary = await f.store.getCuotaVencidaWhatsAppBatch({ batchId: rows[0].id });
  assert.equal(summary.status, "QUEUED"); assert.equal(summary.pending, 2); assert.equal(summary.dateKey, "2026-10-18");
  assert.equal(f.writes(), writes); assert.doesNotMatch(JSON.stringify(summary), /CLIENTE|phone|recipientKey|debtorKey|actorId|requestId/);
});

test("invalid inputs and a disabled feature never reserve; a rollback restores the entire batch and grouped coverage", async t => {
  const f = await fixture(t);
  for (const changes of [{ requestId: "bad" }, { actorId: 0 }, { actorId: 1.5 }]) await assert.rejects(f.create(changes), error => error.code === "INVALID_REQUEST");
  assert.equal(f.queries(), 0);
  f.rollback(); await assert.rejects(f.create(), /Synthetic batch rollback/);
  for (const name of ["Batch", "Event", "Coverage"]) assert.equal((await f.db.query(`SELECT count(*)::int n FROM "CuotaVencidaWhatsApp${name}"`)).rows[0].n, 0);
  assert.equal((await f.create()).created, true);
  const disabled = await fixture(t, { enabled: false });
  await assert.rejects(disabled.create(), error => error.code === "DISABLED");
  assert.equal((await disabled.store.claimCuotaVencidaWhatsApp()).length, 0); assert.equal(disabled.queries(), 0);
});

test("one customer with several credits gets one destination and grouped coverage, while shared owners are excluded", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2, { clienteDocumento: credit().clienteDocumento }),
    credit(3, { clienteDocumento: null }), credit(4, { clienteDocumento: null, clienteTelefono: credit(3).clienteTelefono }),
    credit(5), credit(6, { clienteTelefono: credit(5).clienteTelefono })] });
  const { batch } = await f.create(); assert.equal(batch.total, 2); assert.equal(batch.stats.sharedPhoneCredits, 2);
  const coverage = (await f.db.query('SELECT "creditoId" FROM "CuotaVencidaWhatsAppCoverage" ORDER BY "creditoId"')).rows;
  assert.deepEqual(coverage.map(row => row.creditoId), [1, 2, 3, 4]);
  const claims = (await Promise.all([f.store.claimCuotaVencidaWhatsApp({ limit: 1 }), f.store.claimCuotaVencidaWhatsApp({ limit: 1 }), f.store.claimCuotaVencidaWhatsApp({ limit: 1 })])).flat();
  assert.equal(claims.length, 2); assert.equal(new Set(claims.map(row => row.eventId)).size, 2);
  const state = await f.store.getCuotaVencidaWhatsAppBatch({ batchId: batch.id });
  assert.equal(state.status, "RUNNING"); assert.equal(state.pending, 2); assert.equal(state.processing, 2);
});

test("payments and changed destination after claiming suppress actual dispatcher HTTP, preserving audit rows", async t => {
  for (const change of [{ abonos: [{ valor: 300, estado: "ACTIVO" }] }, { estado: "ANULADO" }, { clienteTelefono: "3000000099" }]) {
    const f = await fixture(t); await f.create();
    const [claim] = await f.store.claimCuotaVencidaWhatsApp({ limit: 1 }); await f.update(1, change);
    const { worker, sent } = f.run({ claim: async () => [claim] });
    const result = await worker({ limit: 1 }); assert.equal(result.skipped, 1); assert.equal(sent.length, 0);
    const [event] = await f.events(); assert.equal(event.status, "CANCELLED"); assert.equal(event.resultCode, "NO_LONGER_ELIGIBLE");
    assert.equal((await f.store.getCuotaVencidaWhatsAppBatch()).status, "COMPLETED");
  }
});

test("a paid representative can be replaced only by an eligible covered credit of the same titular and destination", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2, { clienteDocumento: credit().clienteDocumento, clienteTelefono: credit().clienteTelefono })] });
  await f.create(); const [claim] = await f.store.claimCuotaVencidaWhatsApp({ limit: 1 });
  await f.update(1, { estado: "PAGADO" });
  const { worker, sent } = f.run({ claim: async () => [claim] });
  assert.equal((await worker({ limit: 1 })).accepted, 1); assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["event_id", "nombre", "telefono"]);
  assert.equal(sent[0].nombre, credit(2).clienteNombre); assert.equal((await f.events())[0].representativeCreditoId, 2);
});

test("a destination newly shared by different eligible titulars after batch creation is excluded before real HTTP", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2)] }); await f.create();
  const claims = await f.store.claimCuotaVencidaWhatsApp({ limit: 2 });
  const firstEvent = (await f.events()).find(row => row.representativeCreditoId === 1);
  const firstClaim = claims.find(row => row.eventId === firstEvent.id);
  await f.update(2, { clienteTelefono: "+57 " + credit().clienteTelefono });
  const { worker, sent } = f.run({ claim: async () => [firstClaim] });
  assert.equal((await worker({ limit: 1 })).skipped, 1); assert.equal(sent.length, 0);
  assert.equal((await f.events()).find(row => row.id === firstEvent.id).resultCode, "SHARED_PHONE");
  const other = claims.find(row => row.eventId !== firstClaim.eventId);
  assert.equal(await f.store.prepareCuotaVencidaWhatsAppDispatch(other.eventId), null);
});

test("a different titular on the same phone does not block after their credit is genuinely paid", async t => {
  const f = await fixture(t, { credits: [credit(), credit(2)] }); await f.create();
  const [claim] = await f.store.claimCuotaVencidaWhatsApp({ limit: 1 });
  const claimed = (await f.events()).find(row => row.id === claim.eventId);
  const otherId = claimed.representativeCreditoId === 1 ? 2 : 1;
  await f.update(otherId, { clienteTelefono: claimed.phone, estado: "PAGADO" });
  assert.ok(await f.store.prepareCuotaVencidaWhatsAppDispatch(claim.eventId));
});

test("unknown delivery blocks future-day titular and mobile without leaving a permanent queued progress bar", async t => {
  const f = await fixture(t); await f.create();
  const [claim] = await f.store.claimCuotaVencidaWhatsApp(); await f.store.markCuotaVencidaWhatsAppUnknown(claim.eventId);
  assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  f.time("2026-10-19T15:00:00Z"); await f.update(1, { clienteTelefono: "3000000022" });
  const { batch } = await f.create({ requestId: requestId2 }); assert.equal(batch.total, 1);
  assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  const latest = await f.store.getCuotaVencidaWhatsAppBatch({ batchId: batch.id });
  assert.equal(latest.status, "COMPLETED"); assert.equal(latest.pending, 0); assert.equal(latest.skipped, 1);
  const events = await f.events(); assert.equal(events[0].status, "UNKNOWN");
  assert.equal(events[1].resultCode, "PREVIOUS_OUTCOME_UNRESOLVED");
});

test("a later explicit daily batch is allowed after acceptance, while replay of the old UUID never creates it", async t => {
  const f = await fixture(t); const first = await f.create(); const { worker } = f.run(); assert.equal((await worker()).accepted, 1);
  f.time("2026-10-19T15:00:00Z"); const replay = await f.create(); assert.equal(replay.batch.id, first.batch.id);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CuotaVencidaWhatsAppBatch"')).rows[0].n, 1);
  const next = await f.create({ requestId: requestId2 }); assert.notEqual(next.batch.id, first.batch.id);
  assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 1);
});

test("restart expires ambiguous claims to UNKNOWN and never retries them or automatically starts another daily batch", async t => {
  const f = await fixture(t); await f.create(); const [claim] = await f.store.claimCuotaVencidaWhatsApp();
  f.advance(90_000); assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  assert.equal((await f.events())[0].status, "UNKNOWN");
  assert.equal(await f.store.markCuotaVencidaWhatsAppAccepted(claim.eventId, "wamid.late"), 0);
  f.time("2026-10-19T15:00:00Z"); assert.equal((await f.store.claimCuotaVencidaWhatsApp()).length, 0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CuotaVencidaWhatsAppBatch"')).rows[0].n, 1);
});

test("daily rollover or own pre-HTTP lease expiry suppresses the request without erasing any audit", async t => {
  const f = await fixture(t); await f.create(); const [claim] = await f.store.claimCuotaVencidaWhatsApp();
  f.advance(90_000); assert.equal(await f.store.prepareCuotaVencidaWhatsAppDispatch(claim.eventId), null);
  assert.equal((await f.events())[0].status, "CANCELLED");
  const g = await fixture(t); await g.create(); g.time("2026-10-19T05:00:00Z");
  assert.equal((await g.store.claimCuotaVencidaWhatsApp()).length, 0);
  assert.equal((await g.events())[0].resultCode, "BATCH_DAY_ENDED");
});

test("schema reinstalls without losing history and database keys reject duplicate date, titular and recipient", async t => {
  const f = await fixture(t); const { batch } = await f.create();
  for (const sql of cuotaVencidaWhatsAppSchemaStatements) await f.db.exec(sql);
  await assert.rejects(f.db.query('INSERT INTO "CuotaVencidaWhatsAppBatch" ("id","requestId","actorId","campaignDate") VALUES($1,$2,51,$3)',
    ["1df2ddc9-b0bb-4148-baa0-050000000003", requestId2, batch.campaignDate]), error => error.code === "23505");
  const [event] = await f.events();
  for (const change of ["debtorKey", "recipientKey"]) {
    const other = change === "debtorKey" ? "recipientKey" : "debtorKey";
    await assert.rejects(f.db.query(`INSERT INTO "CuotaVencidaWhatsAppEvent" ("id","batchId","campaignDate","debtorKey","recipientKey","phone","name","representativeCreditoId")
      SELECT $1,"batchId","campaignDate",${change === "debtorKey" ? '"debtorKey",$2' : '$2,"recipientKey"'},"phone","name","representativeCreditoId" FROM "CuotaVencidaWhatsAppEvent" WHERE "id"=$3`,
    ["1df2ddc9-b0bb-4148-baa0-050000000004", other.repeat(4), event.id]), error => error.code === "23505");
  }
  assert.equal((await f.events()).length, 1);
  await assert.rejects(f.store.getCuotaVencidaWhatsAppBatch({ batchId: "bad" }), error => error.code === "INVALID_REQUEST");
  assert.equal((await f.create({ requestId })).created, false);
});
