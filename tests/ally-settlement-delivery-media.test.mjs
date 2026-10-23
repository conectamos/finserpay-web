import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { allySettlementDeliverySchemaStatements } from "../scripts/ally-settlement-delivery-schema.mjs";

const media = loadReissueModule("lib/ally-settlement-delivery-media.ts");
const now = Date.parse("2026-10-23T15:00:00.000Z");
const endpoint = "https://finserpay.com/api/integraciones/liquidaciones/documento";
const env = Object.freeze({ ALLY_SETTLEMENT_DELIVERY_ENABLED: "true", ALLY_SETTLEMENT_MEDIA_SECRET: "offline-media-secret-not-for-production-12345" });
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const missingId = "33333333-3333-4333-8333-333333333333";
const firstPdf = Buffer.from("%PDF-1.4\nLIQUIDACION FICTICIA ALIADO UNO\n%%EOF");
const secondPdf = Buffer.from("%PDF-1.4\nOTRO ALIADO NO COMPARTIR\n%%EOF");
const signed = (id = firstId, time = now, config = env) => media.createSettlementMediaUrl(id, config, time);
const changed = (url, key, value) => { const parsed = new URL(url); parsed.searchParams.set(key, value); return parsed.href; };
const pg = new PGlite();

before(async () => {
  await pg.exec('CREATE TABLE "LiquidacionAliado" (id integer PRIMARY KEY, "aliadoId" integer NOT NULL)');
  for (const sql of allySettlementDeliverySchemaStatements) await pg.exec(sql);
});
beforeEach(async () => {
  await pg.exec('TRUNCATE "LiquidacionAliado" CASCADE; INSERT INTO "LiquidacionAliado" VALUES (101,1),(202,2)');
});
after(async () => { await pg.close(); });

async function seed({ id = firstId, settlementId = 101, channel = "WHATSAPP", status = "PROCESSING", started = true, pdf = firstPdf, filename = "liquidacion-aliado-LA-101.pdf" } = {}) {
  await pg.query('INSERT INTO "AllySettlementDelivery" ("settlementId","channel") VALUES ($1,$2)', [settlementId, channel]);
  await pg.query(`INSERT INTO "AllySettlementDeliveryAttempt"
    (id,"settlementId",channel,sequence,"requestId",recipient,payload,status,"sendStartedAt")
    VALUES ($1,$2,$3,1,$4,$5,'{}',$6,$7)`,
  [id, settlementId, channel, randomUUID(), channel === "EMAIL" ? "ally@example.invalid" : "573001000001", status, started ? new Date(now) : null]);
  if (pdf) await pg.query('INSERT INTO "AllySettlementDocument" ("settlementId",pdf,sha256,filename) VALUES ($1,$2,$3,$4)',
    [settlementId, pdf, createHash("sha256").update(pdf).digest("hex"), filename]);
}

function fixture(config = env, query) {
  const calls = [];
  const fail = () => assert.fail("A media download must not build a PDF, write, enqueue, dispatch or call the network");
  const db = {
    $queryRawUnsafe: async (sql, ...values) => {
      assert.match(sql.trim(), /^SELECT\b/);
      calls.push({ sql, values });
      return query ? query(sql, ...values) : (await pg.query(sql, values)).rows;
    },
    $executeRawUnsafe: fail,
    $transaction: fail,
  };
  class FixedDate extends Date { static now() { return now; } }
  const globals = { process: { env: config }, Date: FixedDate, fetch: fail };
  const actualMedia = loadReissueModule("lib/ally-settlement-delivery-media.ts", {}, globals);
  const route = loadReissueModule("app/api/integraciones/liquidaciones/documento/route.ts", {
    "@/lib/prisma": { default: db },
    "@/lib/ally-settlement-delivery-media": actualMedia,
  }, globals);
  return { calls, get: (url, headers) => route.GET(new Request(url, { headers })) };
}

function assertPrivate(response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("Expires"), "0");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(response.headers.get("X-Robots-Tag"), /noindex/);
}

test("media URL has a fixed HTTPS endpoint, binds one attempt and expires after at most 30 minutes", () => {
  const url = signed();
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, endpoint);
  assert.deepEqual([...parsed.searchParams.keys()], ["attemptId", "expires", "token"]);
  assert.equal(parsed.searchParams.get("attemptId"), firstId);
  assert.equal(Number(parsed.searchParams.get("expires")) * 1000, now + 30 * 60_000);
  assert.match(parsed.searchParams.get("token"), /^[a-f0-9]{64}$/);
  assert.equal(media.verifySettlementMediaUrl(url, env, now), firstId);
  assert.equal(signed(firstId, now, { ...env, APP_URL: "http://attacker.invalid", NEXT_PUBLIC_APP_URL: "https://attacker.invalid" }), url);
  assert.equal(signed(), url, "Signing is pure and deterministic for the attempt and timestamp");
});

test("media signatures reject altered attempts, expiry, signature and wrong keys", () => {
  const url = signed();
  const token = new URL(url).searchParams.get("token");
  for (const input of [
    changed(url, "attemptId", secondId),
    changed(url, "expires", String(now / 1000 + 10)),
    changed(url, "token", `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`),
    changed(url, "token", token.toUpperCase()),
    changed(url, "token", "f".repeat(63)), changed(url, "token", "g".repeat(64)),
    changed(url, "attemptId", "not-a-uuid"), changed(url, "expires", "1e12"),
    changed(url, "expires", "01792767600"), changed(url, "expires", "0"),
  ]) assert.equal(media.verifySettlementMediaUrl(input, env, now), null);
  assert.equal(media.verifySettlementMediaUrl(url, { ...env, ALLY_SETTLEMENT_MEDIA_SECRET: "another-offline-secret-not-for-production" }, now), null);
});

test("media verifies exact expiration and rejects excessive-lifetime links", () => {
  assert.equal(media.verifySettlementMediaUrl(signed(), env, now + 30 * 60_000 - 1), firstId);
  assert.equal(media.verifySettlementMediaUrl(signed(), env, now + 30 * 60_000), null);
  assert.equal(media.verifySettlementMediaUrl(signed(), env, now + 31 * 60_000), null);
  assert.equal(media.verifySettlementMediaUrl(signed(firstId, now + 60 * 60_000), env, now), null);
  assert.equal(media.verifySettlementMediaUrl(signed(), env, Number.NaN), null);
  assert.throws(() => signed(firstId, Number.NaN), /Fecha/);
});

test("media tolerates up to thirty seconds issuer clock lead without expiration grace", () => {
  for (const [skewSeconds, expected] of [[1, firstId], [30, firstId], [31, null]]) {
    const issuedAt = now + skewSeconds * 1000;
    const url = signed(firstId, issuedAt);
    const expiresAt = Number(new URL(url).searchParams.get("expires")) * 1000;
    assert.equal(expiresAt - issuedAt, 1800_000, "Signing lifetime stays exactly 1800 seconds");
    assert.equal(media.verifySettlementMediaUrl(url, env, now), expected, `Issuer ahead ${skewSeconds}s`);
    assert.equal(media.verifySettlementMediaUrl(url, env, expiresAt - 1), firstId);
    assert.equal(media.verifySettlementMediaUrl(url, env, expiresAt), null);
    assert.equal(media.verifySettlementMediaUrl(url, env, expiresAt + 1000), null);
  }
});

test("media secret configuration fails closed and counts UTF-8 bytes", () => {
  for (const secret of [undefined, "", "x".repeat(31), " x".repeat(32), "x".repeat(32) + "\n", "x".repeat(4097)]) {
    const config = { ...env, ALLY_SETTLEMENT_MEDIA_SECRET: secret };
    assert.throws(() => signed(firstId, now, config), /ALLY_SETTLEMENT_MEDIA_SECRET/);
    assert.equal(media.verifySettlementMediaUrl(signed(), config, now), null);
  }
  const utf8 = { ...env, ALLY_SETTLEMENT_MEDIA_SECRET: "á".repeat(16) };
  assert.equal(media.verifySettlementMediaUrl(signed(firstId, now, utf8), utf8, now), firstId);
  for (const id of ["", "../secret", "11111111-1111-0111-0111-111111111111", `${firstId}\n`]) {
    assert.throws(() => signed(id), /identificador/);
  }
});

test("duplicate, missing or unknown query parameters are rejected before querying the database", async () => {
  const f = fixture();
  const url = signed();
  const parsed = new URL(url);
  for (const key of ["attemptId", "expires", "token"]) {
    const duplicate = new URL(url);
    duplicate.searchParams.append(key, parsed.searchParams.get(key));
    assert.equal((await f.get(duplicate.href)).status, 404);
    const missing = new URL(url);
    missing.searchParams.delete(key);
    assert.equal((await f.get(missing.href)).status, 404);
  }
  assert.equal((await f.get(url + "&aliadoId=2")).status, 404);
  assert.equal((await f.get(url + `&%61ttemptId=${secondId}`)).status, 404);
  assert.equal((await f.get(changed(url, "token", "malformed"))).status, 404);
  assert.deepEqual(f.calls, []);
});

test("media URL refuses other origins, paths, credentials and fragments", () => {
  for (const url of [
    signed().replace("https:", "http:"), signed().replace("finserpay.com", "evil.invalid"),
    signed().replace("finserpay.com", "finserpay.com:8443"), signed().replace("/documento?", "/otro?"),
    signed().replace("https://", "https://name:password@"), signed() + "#fragment", "not-a-url",
  ]) assert.equal(media.verifySettlementMediaUrl(url, env, now), null);
});

test("standalone proxy origins use the fixed signing origin and never trust forwarded headers", async () => {
  await seed();
  const internal = signed().replace("https://finserpay.com", "http://0.0.0.0:3000");
  assert.equal(media.verifySettlementMediaUrl(internal, env, now), null, "The public signed URL contract remains strict");
  const f = fixture();
  const headers = { Host: "attacker.invalid", "X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "https", Forwarded: 'host="attacker.invalid";proto=https' };
  const response = await f.get(internal, headers);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), firstPdf);
  assert.equal(f.calls.length, 1);
  for (const invalid of [
    changed(internal, "attemptId", secondId), changed(internal, "token", "a".repeat(64)),
    internal + `&attemptId=${firstId}`, internal.replace("/documento?", "/otro?"),
    internal.replace("/documento?", "/documento/?"),
  ]) assert.equal((await f.get(invalid, headers)).status, 404);
  assert.equal(f.calls.length, 1, "Neither altered queries nor alternate route paths may reach the document lookup");
});

test("GET returns only its already-frozen PDF and repeat downloads neither mutate nor send", async () => {
  await seed();
  await seed({ id: secondId, settlementId: 202, pdf: secondPdf, filename: "liquidacion-aliado-LA-202.pdf" });
  const beforeRows = (await pg.query('SELECT * FROM "AllySettlementDeliveryAttempt" ORDER BY id')).rows;
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const response = await f.get(signed());
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    assert.equal(response.headers.get("Content-Length"), String(firstPdf.length));
    assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="liquidacion-aliado-LA-101.pdf"');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, firstPdf);
    assert.ok(!bytes.includes(Buffer.from("OTRO ALIADO")));
  }
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.values), [[firstId], [firstId]]);
  assert.deepEqual((await pg.query('SELECT * FROM "AllySettlementDeliveryAttempt" ORDER BY id')).rows, beforeRows);
  assert.equal((await pg.query('SELECT COUNT(*)::integer AS count FROM "AllySettlementDocument"')).rows[0].count, 2);
});

test("a signed first-ally URL cannot fetch a second attempt even when that document exists", async () => {
  await seed();
  await seed({ id: secondId, settlementId: 202, pdf: secondPdf });
  const f = fixture();
  const denied = await f.get(changed(signed(), "attemptId", secondId));
  assert.equal(denied.status, 404);
  assert.deepEqual(f.calls, []);
  assertPrivate(denied);
  const allowed = await f.get(signed(secondId));
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), secondPdf);
});

test("only started WHATSAPP attempts in PROCESSING, SENT or UNCERTAIN can read the stored document", async () => {
  await seed();
  const f = fixture();
  for (const status of ["PROCESSING", "SENT", "UNCERTAIN", "QUEUED", "FAILED"]) {
    await pg.query('UPDATE "AllySettlementDeliveryAttempt" SET status=$1,"sendStartedAt"=$2 WHERE id=$3', [status, new Date(now), firstId]);
    assert.equal((await f.get(signed())).status, ["PROCESSING", "SENT", "UNCERTAIN"].includes(status) ? 200 : 404, status);
    await pg.query('UPDATE "AllySettlementDeliveryAttempt" SET "sendStartedAt"=NULL WHERE id=$1', [firstId]);
    assert.equal((await f.get(signed())).status, 404, `${status} must be denied before the send starts`);
  }
});

test("an EMAIL attempt is denied even with a valid signature, stored PDF and started send", async () => {
  await seed({ channel: "EMAIL", status: "SENT" });
  const f = fixture();
  assert.equal((await f.get(signed())).status, 404);
});

test("missing PDFs and missing attempts return the same generic private response", async () => {
  await seed({ pdf: null });
  const f = fixture();
  for (const id of [firstId, missingId]) {
    const response = await f.get(signed(id));
    assert.equal(response.status, 404);
    assertPrivate(response);
    assert.equal(await response.text(), "Documento no disponible.");
  }
  assert.equal((await pg.query('SELECT COUNT(*)::integer AS count FROM "AllySettlementDocument"')).rows[0].count, 0);
});

test("disabled delivery and invalid authentication fail before any database access", async () => {
  for (const flag of [undefined, "false", "TRUE", "1", ""]) {
    const f = fixture({ ...env, ALLY_SETTLEMENT_DELIVERY_ENABLED: flag });
    const response = await f.get(signed());
    assert.equal(response.status, 404);
    assertPrivate(response);
    assert.equal(await response.text(), "Documento no disponible.");
    assert.deepEqual(f.calls, []);
  }
  for (const [config, url] of [
    [{ ...env, ALLY_SETTLEMENT_MEDIA_SECRET: "" }, signed()],
    [env, signed(firstId, now - 30 * 60_000)], [env, signed(firstId, now + 60_000)],
  ]) {
    const f = fixture(config);
    assert.equal((await f.get(url)).status, 404);
    assert.deepEqual(f.calls, []);
  }
});

test("unsafe stored filenames cannot inject headers or paths", async () => {
  await seed({ filename: '../private.pdf"\r\nX-Injected: true' });
  const response = await fixture().get(signed());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="liquidacion-aliado.pdf"');
  assert.equal(response.headers.get("X-Injected"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), firstPdf);
});

test("invalid PDF bytes and database errors never disclose details or synthesize a PDF", async () => {
  await seed({ pdf: Buffer.from("not a stored PDF") });
  const invalid = await fixture().get(signed());
  assert.equal(invalid.status, 404);
  const broken = fixture(env, async () => { throw new Error("PRIVATE_DATABASE_URL_OR_QUERY must not leak"); });
  const response = await broken.get(signed());
  assert.equal(response.status, 404);
  assertPrivate(response);
  assert.equal(await response.text(), "Documento no disponible.");
  assert.equal(await invalid.text(), "Documento no disponible.");
});
