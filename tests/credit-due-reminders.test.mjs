import assert from "node:assert/strict";
import test from "node:test";
import { reminderFixture, sampleCredit } from "./credit-due-reminders-fixture.mjs";

// PGlite serializes transactions. The overlap tests execute the production
// PostgreSQL claim/unique constraint protocol, not independent server connections.
test("preview scans every page, aggregates exclusions, and performs no writes or sends", async t => {
  const credits = Array.from({ length: 501 }, (_, index) => sampleCredit(index + 1));
  credits[0].clienteTelefono = "1111";
  credits[1].estado = "ANULADO";
  credits[2].abonos = [{ valor: 300 }];
  const f = await reminderFixture(t, { credits, enabled: false });
  const report = await f.run();
  assert.equal(report.dryRun, true);
  assert.equal(report.summary.scanned, 501);
  assert.equal(report.summary.eligible, 498);
  assert.equal(report.summary.invalidPhone, 1);
  assert.equal(report.summary.excluded, 2);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal(f.counts.pages, 4);
  assert.equal((await f.rows()).length, 0);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /CLIENTE|3000000001|telefono|nombre|webhook/);
});

test("real runs are disabled by default, reject non-Dapta URLs and respect the Bogotá window", async t => {
  for (const options of [{ enabled: false }, { now: "2026-10-07T14:59:59Z" }, { now: "2026-10-07T16:00:00Z" },
    { url: "http://api.dapta.ai/test" }, { url: "https://attacker.invalid/test" }, { url: "https://api.dapta.ai.attacker.invalid/test" },
    { url: "https://user:password@api.dapta.ai/test" }]) {
    const f = await reminderFixture(t, options);
    const report = await f.run({ dryRun: false });
    assert.equal(report.summary.scanned, 0);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.sends, 0);
  }
});

test("overlapping dispatch and replay claim each installment/template once", async t => {
  const f = await reminderFixture(t);
  const reports = await Promise.all([f.run({ dryRun: false }), f.run({ dryRun: false })]);
  assert.equal(f.counts.sends, 1);
  assert.equal(reports.reduce((n, r) => n + r.summary.accepted, 0), 1);
  assert.equal(reports.reduce((n, r) => n + r.summary.duplicates, 0), 1);
  const replay = await f.run({ dryRun: false });
  assert.equal(replay.summary.duplicates, 1);
  assert.equal(f.counts.sends, 1);
  const [row] = await f.rows();
  assert.equal(row.status, "ACCEPTED");
  assert.equal(row.attempts, 1);
  assert.equal(row.httpStatus, 200);
  assert.deepEqual(f.payloads[0], { credito_id: "1", telefono: "573000000001", nombre: "CLIENTE PRUEBA", cuota_numero: "1", fecha_vencimiento: "2026-10-08" });
});

test("a rolled-back claim never dispatches and can be reserved in a later valid run", async t => {
  const f = await reminderFixture(t, { failTransactionOnce: true });
  await assert.rejects(f.run({ dryRun: false }));
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  await f.run({ dryRun: false });
  assert.equal(f.counts.sends, 1);
  assert.equal((await f.rows()).length, 1);
});

test("payment after claiming is revalidated before the request and suppresses dispatch", async t => {
  const f = await reminderFixture(t, { afterClaim: async ({ database }) => {
    await database.query('UPDATE "Credito" SET "data"="data" || $1::jsonb WHERE "id"=1', [JSON.stringify({ abonos: [{ valor: 300 }] })]);
  } });
  const report = await f.run({ dryRun: false });
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(report.summary.failed, 0);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
});

test("a window that closes after the claim suppresses dispatch", async t => {
  const f = await reminderFixture(t, { afterClaim: async ({ setClock }) => setClock("2026-10-07T16:00:00Z") });
  await f.run({ dryRun: false });
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
});

test("a paid/changed installment before the transaction creates no reservation", async t => {
  const f = await reminderFixture(t);
  const baseRead = f.client.credito.findMany;
  f.client.credito.findMany = async input => {
    const rows = await baseRead(input);
    if (rows.length) await f.updateCredit(1, { abonos: [{ valor: 300 }] });
    return rows;
  };
  const report = await f.run({ dryRun: false });
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal((await f.rows()).length, 0);
  assert.equal(f.counts.sends, 0);
});

test("a timeout is UNKNOWN and a restart never retries the ambiguous delivery", async t => {
  const f = await reminderFixture(t, { providerError: true });
  const report = await f.run({ dryRun: false });
  assert.equal(report.ok, false);
  assert.equal(report.summary.unknown, 1);
  assert.equal((await f.rows())[0].status, "UNKNOWN");
  assert.doesNotMatch(JSON.stringify(await f.rows()), /private|credential|phone/);
  await f.run({ dryRun: false });
  assert.equal(f.counts.sends, 1);
});

test("expired claims become UNKNOWN durably and are excluded from a new attempt", async t => {
  const f = await reminderFixture(t);
  await f.database.query(`INSERT INTO "CreditDueReminder"
    ("id","creditoId","numeroCuota","templateKey","fechaVencimiento","status","claimedAt","claimExpiresAt")
    VALUES ('00000000-0000-4000-8000-000000000001',1,1,$1,'2026-10-08','CLAIMED','2026-10-07T14:00:00Z','2026-10-07T14:01:30Z')`,
  [f.core.CREDIT_DUE_REMINDER_TEMPLATE_KEY]);
  const report = await f.run({ dryRun: false });
  assert.equal(report.summary.staleClaims, 1);
  assert.equal(report.summary.duplicates, 1);
  assert.equal(f.counts.sends, 0);
  const [row] = await f.rows();
  assert.equal(row.status, "UNKNOWN");
  assert.equal(row.resultCode, "CLAIM_EXPIRED");
});

test("HTTP 200 with a node error fails; missing explicit confirmation stays UNKNOWN", async t => {
  for (const [options, status] of [
    [{ response: { ok: true, nodes: [{ error: "Provider failure with private data" }] } }, "FAILED"],
    [{ response: { ok: false } }, "FAILED"],
    [{ response: { success: false } }, "FAILED"],
    [{ response: { message: "accepted" } }, "UNKNOWN"],
    [{ rawResponse: "not JSON" }, "UNKNOWN"],
    [{ status: 401 }, "FAILED"],
  ]) {
    const f = await reminderFixture(t, options);
    await f.run({ dryRun: false });
    assert.equal((await f.rows())[0].status, status);
    await f.run({ dryRun: false });
    assert.equal(f.counts.sends, 1);
  }
});

test("preview date is permitted for read-only use and ignored for real dispatch", async t => {
  const f = await reminderFixture(t, { now: "2026-10-06T15:00:00Z" });
  const preview = await f.run({ dryRun: true, previewDate: "2026-10-07" });
  assert.equal(preview.summary.eligible, 1);
  const real = await f.run({ dryRun: false, previewDate: "2026-10-07" });
  assert.equal(real.summary.eligible, 0);
  assert.equal(f.counts.sends, 0);
});

test("next unpaid installment gets its own durable key after the previous one was paid", async t => {
  const f = await reminderFixture(t);
  await f.run({ dryRun: false });
  await f.updateCredit(1, { abonos: [{ valor: 100 }], fechaProximoPago: "2026-11-08" });
  f.setClock("2026-11-07T15:00:00Z");
  await f.run({ dryRun: false });
  assert.equal(f.counts.sends, 2);
  assert.deepEqual((await f.rows()).map(row => row.numeroCuota), [1, 2]);
});

test("the documented execution response wrapper requires explicit true and no nested errors", async t => {
  for (const [response, expected] of [
    [{ response: { ok: true } }, "ACCEPTED"],
    [{ response: { ok: true }, execution: { error: "WhatsApp failure" } }, "FAILED"],
    [{ request: { ok: true } }, "UNKNOWN"],
    [{ response: { ok: "true" } }, "UNKNOWN"],
  ]) {
    const f = await reminderFixture(t, { response });
    await f.run({ dryRun: false });
    assert.equal((await f.rows())[0].status, expected);
  }
});

test("a rescheduled installment releases the known-unsent claim and sends on its new eve", async t => {
  let changed = false;
  const f = await reminderFixture(t, { afterClaim: async ({ database }) => {
    if (changed) return;
    changed = true;
    await database.query('UPDATE "Credito" SET "data"="data" || $1::jsonb WHERE "id"=1', [JSON.stringify({ fechaProximoPago: "2026-10-09" })]);
  } });
  const original = await f.run({ dryRun: false });
  assert.equal(original.summary.revalidatedOut, 1);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
  f.setClock("2026-10-08T15:00:00Z");
  await f.run({ dryRun: false });
  assert.equal(f.counts.sends, 1);
  assert.equal((await f.rows())[0].status, "ACCEPTED");
});

test("a clock that closes during the active-claim query never dispatches HTTP", async t => {
  const f = await reminderFixture(t, { afterActiveClaim: async ({ setClock }) => setClock("2026-10-07T16:00:00Z") });
  const report = await f.run({ dryRun: false });
  assert.equal(report.summary.revalidatedOut, 1);
  assert.equal(f.counts.sends, 0);
  assert.equal((await f.rows()).length, 0);
});
