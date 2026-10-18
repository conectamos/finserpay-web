import assert from "node:assert/strict";
import test from "node:test";
import { fixture, credit, env } from "./cuotavencida-whatsapp-fixture.mjs";

test("configuration is exact true and HTTPS Dapta only; missing config performs no database work", async t => {
  const f = await fixture(t);
  assert.equal(f.dispatcher.isCuotaVencidaWhatsAppConfigured(env), true);
  for (const patch of [{ DAPTA_CUOTAVENCIDA_ENABLED: "false" }, { DAPTA_CUOTAVENCIDA_ENABLED: "TRUE" },
    { DAPTA_CUOTAVENCIDA_WEBHOOK_URL: "https://api.dapta.ai.evil.invalid/path" },
    { DAPTA_CUOTAVENCIDA_WEBHOOK_URL: "http://api.dapta.ai/path" },
    { DAPTA_CUOTAVENCIDA_WEBHOOK_URL: "https://user:secret@api.dapta.ai/path" },
    { DAPTA_CUOTAVENCIDA_WEBHOOK_URL: "https://api.dapta.ai/path#fragment" }]) {
    assert.equal(f.dispatcher.isCuotaVencidaWhatsAppConfigured({ ...env, ...patch }), false);
    const { worker, sent } = f.run({ env: { ...env, ...patch } });
    assert.equal((await worker()).selected, 0); assert.equal(sent.length, 0);
  }
  assert.equal(f.queries(), 0);
});

test("only an explicit correlated provider receipt is acceptance; contradictory siblings and malformed receipts stay unknown", async t => {
  const f = await fixture(t);
  const id = "1df2ddc9-b0bb-4148-baa0-050000000010";
  const success = { ok: true, accepted: true, event_id: id, provider_message_id: "wamid.safe-0123_+=", code: null };
  const receipt = payload => f.dispatcher.cuotaVencidaWhatsAppReceipt(payload, id);
  assert.equal(receipt(success).status, "ACCEPTED"); assert.equal(receipt({ response: success }).status, "ACCEPTED");
  const rejected = { ok: false, accepted: false, event_id: id, provider_message_id: null, code: "PROVIDER_REJECTED" };
  assert.equal(receipt(rejected).status, "FAILED"); assert.equal(receipt({ response: rejected }).status, "FAILED");
  for (const payload of [null, {}, { ok: true }, { response: { response: success } },
    { ...success, event_id: "wrong" }, { ...success, provider_message_id: "" }, { ...success, provider_message_id: "a".repeat(201) },
    { ...success, provider_message_id: "unsafe\nvalue" }, { ...success, provider_message_id: "<script>" },
    { ...success, accepted: "true" }, { ...success, code: "UNEXPECTED" },
    { ...success, success: false }, { ...success, scheduled: true }, { ...success, suppressed: true },
    { response: success, error: "node failed" }, { response: success, errors: ["execution failed"] },
    { response: success, errors: { detail: "execution failed" } }, { response: success, node_error: "execution failed" },
    { response: success, status: "failed" }, { response: success, sibling: { ok: false } },
    { response: success, nodes: [{ success: false }] }, { response: success, sibling: { status: "node_error" } },
    { ...rejected, code: "PROVIDER_RECEIPT_UNCONFIRMED" }]) assert.equal(receipt(payload).status, "UNKNOWN");
});

test("worker processes ten clients per tick, without creating more batches or leaking credit data into the webhook", async t => {
  const f = await fixture(t, { credits: Array.from({ length: 12 }, (_, i) => credit(i + 1)) });
  const { batch } = await f.create(); const { worker, sent } = f.run();
  assert.equal((await worker()).accepted, 10); assert.equal(sent.length, 10);
  let progress = await f.store.getCuotaVencidaWhatsAppBatch({ batchId: batch.id });
  assert.equal(progress.accepted, 10); assert.equal(progress.pending, 2); assert.equal(progress.status, "QUEUED");
  assert.equal((await worker()).accepted, 2); assert.equal(sent.length, 12);
  assert.equal((await worker()).selected, 0);
  progress = await f.store.getCuotaVencidaWhatsAppBatch();
  assert.equal(progress.status, "COMPLETED"); assert.equal(progress.total, 12); assert.equal(progress.accepted, 12);
  assert.equal(progress.pending + progress.accepted + progress.failed + progress.unknown + progress.skipped, progress.total);
  for (const body of sent) assert.deepEqual(Object.keys(body).sort(), ["event_id", "nombre", "telefono"]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CuotaVencidaWhatsAppBatch"')).rows[0].n, 1);
});

test("overlapping worker instances reserve a recipient once and process-local overlap performs no second scan", async t => {
  const f = await fixture(t); await f.create();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const { worker } = f.run({ fetcher: async (_url, options) => {
    requests++; entered(); await gate; const body = JSON.parse(options.body);
    return Response.json({ ok: true, accepted: true, event_id: body.event_id, provider_message_id: "wamid.overlap", code: null });
  } });
  const first = worker({ limit: 1 }); await started;
  assert.equal((await worker()).selected, 0);
  const other = f.run(); assert.equal((await other.worker()).selected, 0);
  release(); assert.equal((await first).accepted, 1); assert.equal(requests, 1);
});

test("worker stops before another eight-second request exceeds its 25-second budget and the next tick resumes", async t => {
  const f = await fixture(t, { credits: Array.from({ length: 6 }, (_, i) => credit(i + 1)) });
  await f.create(); let requests = 0;
  const { worker } = f.run({ fetcher: async (_url, options) => {
    requests++; f.advance(8000); const body = JSON.parse(options.body);
    return Response.json({ ok: true, accepted: true, event_id: body.event_id, provider_message_id: "wamid.budget-" + requests, code: null });
  } });
  const first = await worker(); assert.equal(first.accepted, 3); assert.equal(requests, 3);
  assert.equal((await f.events()).filter(row => row.status === "PENDING").length, 3);
  assert.equal((await worker()).accepted, 3);
});

test("budget closing during preparation releases only known-unsent work and never starts HTTP", async t => {
  const f = await fixture(t); await f.create();
  const { worker, sent } = f.run({ prepare: async id => {
    const prepared = await f.store.prepareCuotaVencidaWhatsAppDispatch(id); f.advance(25_000); return prepared;
  } });
  const result = await worker(); assert.equal(result.deferred, 1); assert.equal(sent.length, 0);
  assert.equal((await f.events())[0].status, "PENDING");
  assert.equal((await f.run().worker()).accepted, 1);
});

test("midnight crossed after preparation cannot send a prior-day batch or create a new daily batch", async t => {
  const f = await fixture(t); await f.create(); f.time("2026-10-19T04:59:59.900Z");
  const { worker, sent } = f.run({ prepare: async id => {
    const prepared = await f.store.prepareCuotaVencidaWhatsAppDispatch(id); f.advance(100); return prepared;
  } });
  assert.equal((await worker()).deferred, 1); assert.equal(sent.length, 0);
  assert.equal((await f.run().worker()).selected, 0);
  assert.equal((await f.events())[0].resultCode, "BATCH_DAY_ENDED");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CuotaVencidaWhatsAppBatch"')).rows[0].n, 1);
});

test("HTTP errors, timeouts and unconfirmed responses are durable UNKNOWN; only explicit rejection is FAILED", async t => {
  for (const [response, status] of [[null, "UNKNOWN"], [500, "UNKNOWN"], [{ ok: true }, "UNKNOWN"],
    ["unconfirmed", "UNKNOWN"], ["rejected", "FAILED"]]) {
    const f = await fixture(t); await f.create();
    let requests = 0;
    const { worker } = f.run({ fetcher: async (_url, options) => {
      requests++; if (response === null) throw new Error("Synthetic timeout");
      if (typeof response === "number") return new Response("failure", { status: response });
      const body = JSON.parse(options.body);
      return Response.json(typeof response === "string" ? { ok: false, accepted: false, event_id: body.event_id, provider_message_id: null,
        code: response === "rejected" ? "PROVIDER_REJECTED" : "PROVIDER_RECEIPT_UNCONFIRMED" } : response);
    } });
    await worker(); assert.equal((await f.events())[0].status, status);
    assert.equal((await worker()).selected, 0); assert.equal(requests, 1);
  }
});

test("provider acceptance followed by failed final persistence cannot become a duplicate after restart", async t => {
  const f = await fixture(t); await f.create(); let requests = 0;
  const { worker } = f.run({ fetcher: async (_url, options) => {
    requests++; const body = JSON.parse(options.body);
    return Response.json({ ok: true, accepted: true, event_id: body.event_id, provider_message_id: "wamid.received", code: null });
  }, accepted: async () => { throw new Error("Synthetic database outage after HTTP"); } });
  await assert.rejects(worker(), /Synthetic database outage/);
  f.advance(90_000); assert.equal((await f.run().worker()).selected, 0);
  assert.equal((await f.events())[0].status, "UNKNOWN"); assert.equal(requests, 1);
});
