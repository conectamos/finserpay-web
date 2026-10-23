import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { before, beforeEach, after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { allySettlementDeliverySchemaStatements } from "../scripts/ally-settlement-delivery-schema.mjs";

const contact = loadReissueModule("lib/ally-contact.ts");
const media = loadReissueModule("lib/ally-settlement-delivery-media.ts");
const bodyReader = loadReissueModule("lib/ally-settlement-delivery-body.ts");
const auth = loadReissueModule("lib/ally-settlement-delivery-dapta-auth.ts", { "./ally-contact": contact });
const deliveryTypes = loadReissueModule("lib/ally-settlement-delivery-types.ts");
const { createSettlementDeliveryStore } = loadReissueModule("lib/ally-settlement-delivery-store.ts", {
  "./ally-contact": contact, "./ally-settlement-delivery-types": deliveryTypes,
});
class DeliveryProviderError extends Error {
  constructor(message, uncertain = false) { super(message); this.uncertain = uncertain; }
}
const { dispatchSettlementDeliveries } = loadReissueModule("lib/ally-settlement-delivery-dispatch.ts", {
  "./ally-settlement-delivery-provider": {
    DeliveryProviderError, sendSettlementDelivery: () => assert.fail("No real provider in callback race tests"),
  },
});
const env = { ALLY_SETTLEMENT_DELIVERY_ENABLED: "true", ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "synthetic-callback-secret-at-least-32-bytes", ALLY_SETTLEMENT_MEDIA_SECRET: "synthetic-media-secret-at-least-32-bytes" };
function callbackModule(values = env) {
  return loadReissueModule("lib/ally-settlement-delivery-dapta-callback.ts", {
    "./ally-contact": contact, "./ally-settlement-delivery-media": media,
    "./ally-settlement-delivery-dapta-auth": auth,
  }, { process: { env: values } });
}
const callbacks = callbackModule();
const { parseDaptaCallback, DaptaCallbackInputError, DaptaCallbackConflictError, createDaptaSettlementCallbackStore } = callbacks;
const pg = new PGlite();
function adapter(client) {
  return {
    $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).affectedRows || 0,
  };
}
const db = { ...adapter(pg), $transaction: fn => pg.transaction(tx => fn(adapter(tx))) };
const store = createDaptaSettlementCallbackStore(db, env);
const plain = value => JSON.parse(JSON.stringify(value));
const receiptTimestamp = new Date().toISOString();
const claims = () => db.$queryRawUnsafe('SELECT * FROM "AllySettlementDaptaClaim" ORDER BY "attemptId"');
const attempt = async id => (await db.$queryRawUnsafe('SELECT * FROM "AllySettlementDeliveryAttempt" WHERE id=$1::uuid', id))[0];
const claimInput = (id, recipient = "573001234567") => parseDaptaCallback({ action: "claim", event_id: id, recipient });
const receiptInput = (id, overrides = {}) => parseDaptaCallback({
  action: "receipt", event_id: id, recipient: "573001234567", sender: "573124085562",
  status: "accepted", provider_message_id: "wamid.SYNTHETIC_MESSAGE_12345", timestamp: receiptTimestamp, ...overrides,
});

before(async () => {
  await pg.exec('CREATE TABLE "LiquidacionAliado" (id integer PRIMARY KEY)');
  for (const sql of allySettlementDeliverySchemaStatements) await pg.exec(sql);
  // Re-running the startup migration must preserve the same contract.
  for (const sql of allySettlementDeliverySchemaStatements) await pg.exec(sql);
});
beforeEach(async () => {
  await pg.exec('TRUNCATE "LiquidacionAliado" CASCADE; INSERT INTO "LiquidacionAliado" VALUES (101),(202)');
});
after(async () => { await pg.close(); });

async function seed({ id = randomUUID(), settlementId = 101, channel = "WHATSAPP", recipient = "573001234567", status = "PROCESSING", started = true, leaseValid = true, document = true } = {}) {
  await db.$executeRawUnsafe('INSERT INTO "AllySettlementDelivery" ("settlementId","channel") VALUES ($1,$2) ON CONFLICT DO NOTHING', settlementId, channel);
  await db.$executeRawUnsafe(`INSERT INTO "AllySettlementDeliveryAttempt"
    (id,"settlementId",channel,sequence,"requestId",recipient,payload,status,"sendStartedAt","leaseUntil","claimToken")
    VALUES ($1::uuid,$2,$3,1,$4::uuid,$5,$6::jsonb,$7,$8,$9,$10::uuid)`,
  id, settlementId, channel, randomUUID(), recipient, JSON.stringify({ allyName: `Aliado congelado ${settlementId}`, periodStart: "01/10/2026", periodEnd: "15/10/2026", netAmount: "$ 75.000,25", subject: "Liquidación", text: "No confirma un desembolso." }),
  status, started ? new Date() : null, new Date(Date.now() + (leaseValid ? 300000 : -60000)), randomUUID());
  if (document) await db.$executeRawUnsafe('INSERT INTO "AllySettlementDocument" ("settlementId",pdf,sha256,filename) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    settlementId, Buffer.from("%PDF-1.4 synthetic"), "a".repeat(64), `liquidacion-${settlementId}.pdf`);
  return id;
}

test("ocho claims concurrentes autorizan exactamente un envío y retornan únicamente el snapshot guardado", async () => {
  const id = await seed();
  const input = parseDaptaCallback({ action: "claim", event_id: id.toUpperCase(), recipient: "+57 300 123 4567", ally_name: "Manipulado", net_amount: "$999", pdf_url: "https://attacker.invalid/other.pdf" });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(input)));
  assert.equal(results.filter(result => result.authorized).length, 1);
  for (const denied of results.filter(result => !result.authorized)) assert.deepEqual(plain(denied), { ok: true, authorized: false });
  const accepted = results.find(result => result.authorized);
  assert.equal(accepted.event_id, id);
  assert.equal(accepted.recipient, "573001234567");
  assert.equal(accepted.sender, "573124085562");
  assert.equal(accepted.ally_name, "Aliado congelado 101");
  assert.equal(accepted.net_amount, "$ 75.000,25");
  assert.equal(accepted.period_start, "01/10/2026");
  assert.equal(accepted.period_end, "15/10/2026");
  assert.equal(accepted.filename, "liquidacion-101.pdf");
  assert.equal(media.verifySettlementMediaUrl(accepted.pdf_url, env), id);
  assert.equal((await claims()).length, 1);
  assert.equal((await attempt(id)).status, "PROCESSING");
});

test("un claim repetido nunca se autoriza de nuevo ni depende de la configuración de firma posterior", async () => {
  const id = await seed();
  assert.equal((await store.claim(claimInput(id))).authorized, true);
  const missingMedia = createDaptaSettlementCallbackStore(db, { ...env, ALLY_SETTLEMENT_MEDIA_SECRET: undefined });
  assert.deepEqual(plain(await missingMedia.claim(claimInput(id))), { ok: true, authorized: false });
  assert.equal((await claims()).length, 1);
});

test("gate apagado, lease vencido, canal incorrecto, falta de inicio o PDF y estados no procesando no autorizan", async () => {
  const blocked = createDaptaSettlementCallbackStore(db, { ...env, ALLY_SETTLEMENT_DELIVERY_ENABLED: "false" });
  const id = await seed();
  assert.equal((await blocked.claim(claimInput(id))).authorized, false);
  assert.equal((await claims()).length, 0);
  for (const options of [
    { leaseValid: false }, { started: false }, { channel: "EMAIL" }, { document: false },
    ...["QUEUED", "FAILED", "SENT", "UNCERTAIN"].map(status => ({ status })),
  ]) {
    await pg.exec('TRUNCATE "LiquidacionAliado" CASCADE; INSERT INTO "LiquidacionAliado" VALUES (101),(202)');
    const invalid = await seed(options);
    assert.equal((await store.claim(claimInput(invalid))).authorized, false, JSON.stringify(options));
    assert.equal((await claims()).length, 0);
  }
});

test("un destinatario de otro aliado no puede reclamar ni reconciliar la liquidación", async () => {
  const a = await seed(), b = await seed({ settlementId: 202, recipient: "573009876543" });
  assert.equal((await store.claim(claimInput(a, "573009876543"))).authorized, false);
  assert.equal((await store.claim(claimInput(b))).authorized, false);
  await store.claim(claimInput(a));
  await assert.rejects(store.receipt(receiptInput(a, { recipient: "573009876543" })), DaptaCallbackConflictError);
  await assert.rejects(store.receipt(receiptInput(b, { recipient: "573009876543" })), DaptaCallbackConflictError);
  assert.equal((await attempt(a)).status, "PROCESSING");
  assert.equal((await attempt(b)).status, "PROCESSING");
});

test("recibo accepted con wamid real concilia incluso después de expirar lease o apagar gate", async () => {
  const id = await seed();
  await store.claim(claimInput(id));
  await db.$executeRawUnsafe('UPDATE "AllySettlementDeliveryAttempt" SET status=$2,"leaseUntil"=now()-interval \'1 minute\' WHERE id=$1::uuid', id, "UNCERTAIN");
  const off = createDaptaSettlementCallbackStore(db, { ...env, ALLY_SETTLEMENT_DELIVERY_ENABLED: "false" });
  const response = await off.receipt(receiptInput(id));
  assert.equal(response.status, "SENT");
  const row = await attempt(id);
  assert.equal(row.status, "SENT");
  assert.equal(row.providerId, "wamid.SYNTHETIC_MESSAGE_12345");
  assert.equal(row.sentAt.toISOString(), receiptTimestamp);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.error, null);
  const claim = (await claims())[0];
  assert.equal(claim.receiptStatus, "SENT");
  assert.equal(claim.providerId, row.providerId);
  assert.ok(claim.receiptAt instanceof Date);
});

test("duplicados y resultados inciertos posteriores no degradan un enviado; otro wamid no lo sustituye", async () => {
  const id = await seed();
  await store.claim(claimInput(id));
  await store.receipt(receiptInput(id));
  const before = await attempt(id);
  assert.equal((await store.receipt(receiptInput(id))).duplicate, true);
  assert.equal((await store.receipt(receiptInput(id, { status: "uncertain", provider_message_id: null }))).duplicate, true);
  await assert.rejects(store.receipt(receiptInput(id, { provider_message_id: "wamid.SYNTHETIC_OTHER_MESSAGE" })), DaptaCallbackConflictError);
  assert.deepEqual(await attempt(id), before);
});

test("un resultado desconocido bloquea el reenvío y un recibo posterior con prueba puede conciliarlo", async () => {
  const id = await seed();
  await store.claim(claimInput(id));
  assert.equal((await store.receipt(receiptInput(id, { status: "failed", provider_message_id: null, code: "TIMEOUT" }))).status, "UNCERTAIN");
  const unknown = await attempt(id);
  assert.equal(unknown.status, "UNCERTAIN");
  assert.equal(unknown.providerId, null);
  assert.equal(unknown.sentAt, null);
  assert.match(unknown.error, /reenvío bloqueado/);
  assert.equal((await store.claim(claimInput(id))).authorized, false);
  assert.equal((await store.receipt(receiptInput(id))).status, "SENT");
});

test("solo una prueba explícita de rechazo Meta permite FAILED; fallos vagos y 5xx son UNCERTAIN", async () => {
  const id = await seed();
  await store.claim(claimInput(id));
  for (const override of [
    { code: "META_REJECTED" },
    { code: "META_REJECTED", provider_http_status: 500, provider_error_code: 131000 },
    { code: "META_REJECTED", provider_http_status: 400 },
    { code: "META_REJECTED", provider_http_status: 400, provider_error_code: 100, provider_message_id: "not-a-wamid" },
    { code: "PROVIDER_REJECTED", provider_http_status: 400, provider_error_code: 100 },
  ]) {
    const input = receiptInput(id, { status: "failed", provider_message_id: null, ...override });
    assert.equal(input.outcome, "UNCERTAIN");
    assert.equal((await store.receipt(input)).status, "UNCERTAIN");
  }
  const definite = receiptInput(id, { status: "failed", provider_message_id: null, code: "META_REJECTED", provider_http_status: 400, provider_error_code: 132001 });
  assert.equal((await store.receipt(definite)).status, "FAILED");
  assert.equal((await attempt(id)).sentAt, null);
  assert.equal((await claims())[0].errorCode, "META_REJECTED_132001");
});

test("sin claim persistido ni identidad válida no se registra un éxito y wamid no puede cruzar intentos", async () => {
  const a = await seed(), b = await seed({ settlementId: 202, recipient: "573009876543" });
  await assert.rejects(store.receipt(receiptInput(a)), DaptaCallbackConflictError);
  assert.throws(() => receiptInput(a, { sender: "573009999999" }), DaptaCallbackInputError);
  assert.equal(receiptInput(a, { provider_message_id: "dapta-job-123" }).outcome, "UNCERTAIN");
  await store.claim(claimInput(a));
  await store.claim(claimInput(b, "573009876543"));
  await store.receipt(receiptInput(a));
  await assert.rejects(store.receipt(receiptInput(b, { recipient: "573009876543" })), /duplicate key|unique constraint/);
  assert.equal((await attempt(b)).status, "PROCESSING", "Uniqueness failure rolls back the whole reconciliation transaction");
  assert.equal((await claims()).find(row => row.attemptId === b).receiptStatus, null);
});

test("validación rechaza entradas malformadas y secreto insuficiente; no expone datos recibidos", () => {
  const id = randomUUID();
  for (const body of [null, [], {}, { action: "claim", event_id: "bad", recipient: "573001234567" }, { action: "claim", event_id: id, recipient: "not a phone" }]) {
    assert.throws(() => parseDaptaCallback(body), DaptaCallbackInputError);
  }
  for (const values of [{}, { ...env, ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "short" }, { ...env, ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: `${env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET} ` }]) {
    assert.equal(callbacks.daptaCallbackAuthorized(new Request("https://qa.invalid", { headers: { Authorization: "Bearer invalid" } }), claimInput(id), values), false);
  }
  const request = token => new Request("https://qa.invalid", { headers: { Authorization: `Bearer ${token}` } });
  const token = auth.createSettlementDaptaToken(id, "573001234567", env);
  assert.equal(callbacks.daptaCallbackAuthorized(request(token), claimInput(id), env), true);
  assert.equal(callbacks.daptaCallbackAuthorized(request(token), claimInput(randomUUID()), env), false);
  assert.equal(callbacks.daptaCallbackAuthorized(request(env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET), claimInput(id), env), false);
});

function routeFixture(values = env) {
  let dbCalls = 0;
  const logged = [];
  const trackedDb = { ...db, $transaction: fn => { dbCalls += 1; return db.$transaction(fn); } };
  const route = loadReissueModule("app/api/integraciones/liquidaciones/dapta/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/prisma": { default: trackedDb },
    "@/lib/ally-settlement-delivery-body": bodyReader,
    "@/lib/ally-settlement-delivery-dapta-callback": callbackModule(values),
  }, { process: { env: values }, console: { error: (...args) => logged.push(args) } });
  const request = (body, headers = {}, raw) => new Request("https://qa.invalid/api/integraciones/liquidaciones/dapta", {
    method: "POST", headers: { Authorization: `Bearer ${auth.createSettlementDaptaToken(body.event_id, body.recipient, env)}`, "Content-Type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
  return { route, request, dbCalls: () => dbCalls, logged };
}

test("ruta HTTP limita y valida cuerpo antes de autenticar el evento; sin auth no escribe", async () => {
  const f = routeFixture();
  const payload = { action: "claim", event_id: randomUUID(), recipient: "573001234567" };
  for (const [headers, raw, status] of [
    [{ Authorization: "Bearer invalid" }, undefined, 401],
    [{ "Content-Type": "text/plain" }, undefined, 415],
    [{}, "{invalid", 400],
    [{ "Content-Length": "16385" }, undefined, 413],
    [{}, "é".repeat(8193), 413],
  ]) {
    const response = await f.route.POST(f.request(payload, headers, raw));
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(f.dbCalls(), 0);
  assert.deepEqual(f.logged, []);
});

test("ruta HTTP completa claim/receipt con snapshot congelado y respuestas no cacheables", async () => {
  const f = routeFixture(), id = await seed();
  const payload = { action: "claim", event_id: id, recipient: "573001234567", ally_name: "No confiar" };
  const first = await f.route.POST(f.request(payload));
  assert.equal(first.status, 200);
  assert.match(first.headers.get("Cache-Control"), /no-store/);
  assert.equal((await first.json()).ally_name, "Aliado congelado 101");
  assert.deepEqual(await (await f.route.POST(f.request(payload))).json(), { ok: true, authorized: false });
  const receipt = { action: "receipt", event_id: id, recipient: "573001234567", sender: "573124085562", status: "accepted", provider_message_id: "wamid.SYNTHETIC_HTTP_MESSAGE", timestamp: receiptTimestamp };
  assert.equal((await f.route.POST(f.request({ ...receipt, recipient: "573009876543" }))).status, 409);
  const completed = await f.route.POST(f.request(receipt));
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, "SENT");
});

test("accepted y wamid con flags o errores contradictorios quedan UNCERTAIN sin habilitar reenvío", async () => {
  const id = await seed();
  await store.claim(claimInput(id));
  for (const contradiction of [
    { ok: false }, { accepted: false }, { success: false }, { suppressed: true }, { scheduled: true },
    { error: "Meta no confirmó" }, { error: { code: 131000 } }, { errors: ["provider failure"] },
    { errors: { message: "provider failure" } }, { success: "true" }, { suppressed: "false" },
  ]) {
    const input = receiptInput(id, contradiction);
    assert.equal(input.outcome, "UNCERTAIN", JSON.stringify(contradiction));
    assert.equal(input.providerId, null);
    assert.equal((await store.receipt(input)).status, "UNCERTAIN");
    assert.equal((await attempt(id)).sentAt, null);
    assert.equal((await store.claim(claimInput(id))).authorized, false);
  }
  const valid = receiptInput(id, { ok: true, accepted: true, success: true, suppressed: false, scheduled: false, error: null, errors: [] });
  assert.equal(valid.outcome, "SENT");
  assert.equal((await store.receipt(valid)).status, "SENT");
});

test("fechas futuras injustificadas o anteriores al despacho no concilian el intento", async () => {
  const id = await seed();
  await store.claim(claimInput(id));
  assert.throws(() => receiptInput(id, { timestamp: new Date(Date.now() + 6 * 60 * 1000).toISOString() }), DaptaCallbackInputError);
  const startedAt = (await attempt(id)).sendStartedAt;
  await assert.rejects(store.receipt(receiptInput(id, { timestamp: new Date(startedAt.getTime() - 6 * 60 * 1000).toISOString() })), DaptaCallbackConflictError);
  assert.equal((await attempt(id)).status, "PROCESSING");
  assert.equal((await claims())[0].receiptAt, null);
});

test("dispatcher conserva recibos concurrentes y permite conciliar después de timeout sin error espurio ni reenvío", async () => {
  for (const mode of ["sent-before-timeout", "uncertain-before-timeout", "receipt-after-timeout", "sent-before-accepted"]) {
    await pg.exec('TRUNCATE "LiquidacionAliado" CASCADE; INSERT INTO "LiquidacionAliado" VALUES (101),(202)');
    const id = await seed({ status: "QUEUED", started: false });
    const deliveryStore = createSettlementDeliveryStore(db);
    let requests = 0;
    let callbackSnapshot;
    const run = () => dispatchSettlementDeliveries({
      store: deliveryStore, settlementId: 101,
      document: settlementId => deliveryStore.document(settlementId, () => assert.fail("The frozen PDF must already exist")),
      send: async (data, options) => {
        requests++;
        assert.equal(data.attemptId, id);
        await options.beforeSend();
        assert.equal((await store.claim(claimInput(id))).authorized, true);
        if (mode !== "receipt-after-timeout") {
          await store.receipt(receiptInput(id, mode === "uncertain-before-timeout" ? { status: "uncertain", provider_message_id: null } : {}));
          callbackSnapshot = await attempt(id);
        }
        if (mode === "sent-before-accepted") return { providerId: "wamid.SYNTHETIC_MESSAGE_12345" };
        throw new DeliveryProviderError("Dapta transport timeout after dispatch boundary", true);
      },
    });
    assert.equal((await run()).processed, 1, mode);
    const completed = await attempt(id);
    if (callbackSnapshot) {
      assert.equal(completed.status, callbackSnapshot.status, mode);
      assert.equal(completed.providerId, callbackSnapshot.providerId, mode);
      assert.equal(completed.error, callbackSnapshot.error, mode);
      assert.equal(completed.sentAt?.getTime(), callbackSnapshot.sentAt?.getTime(), mode);
    } else {
      assert.equal(completed.status, "UNCERTAIN");
      assert.equal((await store.receipt(receiptInput(id))).status, "SENT");
      assert.equal((await attempt(id)).providerId, "wamid.SYNTHETIC_MESSAGE_12345");
    }
    assert.equal((await run()).processed, 0, "No terminal or uncertain attempt is automatically sent again");
    assert.equal(requests, 1);
    const status = (await deliveryStore.list(101)).deliveries.find(item => item.channel === "WHATSAPP");
    if (mode === "uncertain-before-timeout") {
      assert.equal(status.uncertain, true);
      assert.equal(status.canRetry, false);
    } else {
      assert.equal(status.status, "SENT");
      assert.equal(status.error, null);
    }
  }
});
