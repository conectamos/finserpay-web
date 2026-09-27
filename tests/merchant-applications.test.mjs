import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const {
  validateMerchantApplication, getMerchantMailConfig, buildMerchantMail,
  createMerchantApplicationHandler, receiveMerchantApplication,
  notifyMerchantApplication, merchantRetryAuthorized,
} = await jiti.import("../lib/merchant-applications.ts");
const env = { RESEND_API_KEY: "re_test_only_fixture", MERCHANT_APPLICATION_FROM: "FINSER PAY <postulaciones@finserpay.com>" };
const input = (overrides = {}) => ({
  requestId: randomUUID(), nombreComercio: "Comercio de prueba", nit: "900123456-7",
  nombreContacto: "Persona de Prueba", telefono: "+57 300 1234567", email: "pruebas@example.com",
  ciudad: "Bogotá", direccion: "Calle 1 # 2-3", presenciaDigital: "https://instagram.com/comercio_prueba",
  mensaje: "Prueba automática\nSin envío real.", aceptaPrivacidad: true, website: "", ...overrides,
});

test("valida y normaliza campos, NIT/dirección opcionales y rechaza entradas inválidas", () => {
  const valid = validateMerchantApplication(input({ nit: "", direccion: "", email: " TEST@EXAMPLE.COM " }));
  assert.equal(valid.data.email, "test@example.com");
  assert.equal(valid.data.privacyVersion, "2026-09-27");
  for (const fields of [
    { aceptaPrivacidad: false }, { telefono: "llámame" }, { email: "foo" },
    { presenciaDigital: "javascript:alert(1)" }, { nombreComercio: "Empresa\nFalsa" },
    { website: "bot.example.com" }, { requestId: "invalid" }, { mensaje: "a".repeat(2001) },
  ]) assert.throws(() => validateMerchantApplication(input(fields)), { status: 422 });
  assert.doesNotThrow(() => validateMerchantApplication(input({ presenciaDigital: "@comercio" })));
});

test("requiere secretos servidor y remitente finserpay.com; correo contiene todos los datos", () => {
  assert.equal(getMerchantMailConfig({}), null);
  assert.equal(getMerchantMailConfig({ ...env, MERCHANT_APPLICATION_FROM: "onboarding@resend.dev" }), null);
  assert.equal(getMerchantMailConfig({ ...env, MERCHANT_APPLICATION_FROM: "comercial@finserpay.com.evil.test" }), null);
  const { data } = validateMerchantApplication(input());
  const mail = buildMerchantMail({ id: randomUUID(), data, createdAt: new Date(), notificationStatus: "PENDING" }, env.MERCHANT_APPLICATION_FROM);
  assert.deepEqual(mail.to, ["comercial@finserpay.com"]);
  assert.equal(mail.reply_to, data.email);
  for (const [key, value] of Object.entries(data)) {
    if (key !== "aceptaPrivacidad") assert.ok(mail.text.includes(value), key);
  }
});

test("token reintento exige secreto suficiente y compara bytes UTF-8 sin excepciones", () => {
  const configured = { MERCHANT_APPLICATION_RETRY_TOKEN: "a".repeat(32) };
  const req = (token) => new Request("https://finserpay.com/api/postulaciones/reintentar", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(merchantRetryAuthorized(req("a".repeat(32)), configured), true);
  assert.equal(merchantRetryAuthorized(req("é".repeat(32)), configured), false);
  assert.equal(merchantRetryAuthorized(req("a".repeat(32)), {}), false);
  assert.equal(merchantRetryAuthorized(req("short"), { CRON_SECRET: "short" }), false);
});

test("HTTP rechaza JSON inválido, payload excesivo y origen ajeno antes de persistir", async () => {
  const handler = createMerchantApplicationHandler({ receive() { throw new Error("No debe persistir"); } });
  const req = (body, headers = {}) => new Request("https://finserpay.com/api/postulaciones", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body,
  });
  assert.equal((await handler(req("{"))).status, 400);
  assert.equal((await handler(req(JSON.stringify(input()), { origin: "https://attacker.example" }))).status, 403);
  assert.equal((await handler(req(" ".repeat(17_000)))).status, 413);
  assert.equal((await handler(req("{}", { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handler(req(JSON.stringify(input({ aceptaPrivacidad: false }))))).status, 422);
});

test("HTTP permite aliases loopback de igual puerto/protocolo solo en desarrollo", async () => {
  const store = {
    receive: async ({ requestId, data }) => ({ record: { id: requestId, data, createdAt: new Date(), notificationStatus: "PENDING" }, created: true }),
    configurationPending: async () => undefined,
  };
  const request = (origin, url = "http://localhost:3100/api/postulaciones") => new Request(url, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(input()),
  });
  const dev = createMerchantApplicationHandler(store, { env: { NODE_ENV: "development" } });
  const production = createMerchantApplicationHandler(store, { env: { NODE_ENV: "production" } });
  assert.equal((await dev(request("http://127.0.0.1:3100"))).status, 201);
  assert.equal((await dev(request("http://localhost:3100", "http://127.0.0.1:3100/api/postulaciones"))).status, 201);
  assert.equal((await dev(request("http://[::1]:3100"))).status, 201);
  assert.equal((await dev(request("http://127.0.0.1:3101"))).status, 403);
  assert.equal((await dev(request("https://127.0.0.1:3100"))).status, 403);
  assert.equal((await dev(request("http://127.0.0.1.evil.example:3100"))).status, 403);
  assert.equal((await production(request("http://127.0.0.1:3100"))).status, 403);
  assert.equal((await production(request("http://localhost:3100", "http://127.0.0.1:3100/api/postulaciones"))).status, 403);
  assert.equal((await production(request("https://finserpay.com"))).status, 201);
});

test("PostgreSQL: persistencia, outbox, reintentos, concurrencia e idempotencia completos", async (t) => {
  const { createMerchantApplicationStore } = await jiti.import("../lib/merchant-applications-storage.ts");
  const pg = new PGlite();
  const sql = await readFile(new URL("../scripts/setup-merchant-applications.sql", import.meta.url), "utf8");
  await pg.exec(sql);
  await pg.exec(sql); // repeatable predeploy
  const facade = (connection) => {
    const run = async (strings, values) => {
      const statement = strings.reduce((all, part, i) => all + (i ? `$${i}` : "") + part, "");
      // Advisory locking has no effect in a single connection; real row/index constraints do.
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      return connection.query(statement, values);
    };
    return {
      $queryRaw: async (strings, ...values) => (await run(strings, values)).rows,
      $executeRaw: async (strings, ...values) => (await run(strings, values)).affectedRows,
    };
  };
  const database = { ...facade(pg), $transaction: (callback) => pg.transaction((tx) => callback(facade(tx))) };
  const store = createMerchantApplicationStore(database);
  const row = async (id) => (await pg.query('SELECT * FROM "MerchantApplication" WHERE id = $1', [id])).rows[0];
  const count = async () => Number((await pg.query('SELECT COUNT(*) AS count FROM "MerchantApplication"')).rows[0].count);
  const calls = [];
  const providerIds = new Map();
  const mockSend = async (_url, init) => {
    calls.push(init);
    const key = init.headers["Idempotency-Key"];
    if (!providerIds.has(key)) { const id = randomUUID(); providerIds.set(key, `${id.slice(0, 14)}7${id.slice(15)}`); }
    return Response.json({ id: providerIds.get(key) });
  };
  try {
    await t.test("confirmación solo después de guardar; falta correo deja PENDING y reintenta sin duplicar", async () => {
      const body = input();
      const handler = createMerchantApplicationHandler(store, { env: {}, fetch: () => { throw new Error("No debe enviar"); } });
      const response = await handler(new Request("https://finserpay.com/api/postulaciones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const saved = await response.json();
      assert.equal(saved.ok, true);
      assert.equal((await row(saved.solicitudId)).lastErrorCode, "MISSING_EMAIL_CONFIGURATION");
      assert.equal(await count(), 1);
      await notifyMerchantApplication(store, saved.solicitudId, { env, fetch: mockSend, force: true });
      assert.equal((await row(saved.solicitudId)).notificationStatus, "ACCEPTED");
      const again = await receiveMerchantApplication(body, store, { env, fetch: mockSend, force: true });
      const newBrowserKey = await receiveMerchantApplication({ ...body, requestId: randomUUID() }, store, { env, fetch: mockSend, force: true });
      assert.equal(again.solicitudId, saved.solicitudId);
      assert.equal(newBrowserKey.solicitudId, saved.solicitudId);
      assert.equal(await count(), 1);
      assert.equal(calls.length, 1);
      await assert.rejects(receiveMerchantApplication({ ...body, ciudad: "Medellín" }, store, { env, fetch: mockSend, force: true }), { code: "IDEMPOTENCY_CONFLICT" });
    });

    await t.test("una respuesta 503 conserva datos; recuperación usa mismo correo y key", async () => {
      const body = input({ email: "fallo@example.com" });
      const attempts = [];
      const failed = await receiveMerchantApplication(body, store, { env, fetch: async (_url, init) => { attempts.push(init); return new Response("error sensible", { status: 503 }); } });
      const pending = await row(failed.solicitudId);
      assert.equal(pending.notificationStatus, "PENDING");
      assert.equal(pending.lastErrorCode, "PROVIDER_HTTP_503");
      assert.equal(pending.data.nombreComercio, body.nombreComercio);
      await notifyMerchantApplication(store, failed.solicitudId, { force: true, env: { ...env, MERCHANT_APPLICATION_FROM: "Otro <ventas@finserpay.com>" }, fetch: async (url, init) => { attempts.push(init); return mockSend(url, init); } });
      assert.equal(attempts[0].body, attempts[1].body);
      assert.equal(attempts[0].headers["Idempotency-Key"], attempts[1].headers["Idempotency-Key"]);
    });

    await t.test("dos procesadores concurrentes no envían dos notificaciones", async () => {
      const saved = await receiveMerchantApplication(input({ email: "parallel@example.com" }), store, { env: {} });
      const before = calls.length;
      await Promise.all([notifyMerchantApplication(store, saved.solicitudId, { env, fetch: mockSend, force: true }), notifyMerchantApplication(store, saved.solicitudId, { env, fetch: mockSend, force: true })]);
      assert.equal(calls.length - before, 1);
    });

    await t.test("caída después del envío recupera lease y conserva key proveedor", async () => {
      const saved = await receiveMerchantApplication(input({ email: "crash@example.com" }), store, { env: {} });
      await assert.rejects(notifyMerchantApplication({ ...store, accepted: async () => { throw new Error("DB interrumpida"); } }, saved.solicitudId, { env, fetch: mockSend, force: true }));
      assert.equal((await row(saved.solicitudId)).notificationStatus, "SENDING");
      await pg.query(`UPDATE "MerchantApplication" SET "leaseUntil" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [saved.solicitudId]);
      await notifyMerchantApplication(store, saved.solicitudId, { env, fetch: mockSend, force: true });
      const same = calls.filter((call) => call.headers["Idempotency-Key"] === `merchant-application/${saved.solicitudId}`);
      assert.equal(same.length, 2);
      assert.equal(same[0].body, same[1].body);
      assert.equal((await row(saved.solicitudId)).providerEmailId, providerIds.get(`merchant-application/${saved.solicitudId}`));
    });

    await t.test("resultado incierto >23h requiere conciliación para evitar duplicados", async () => {
      const saved = await receiveMerchantApplication(input({ email: "uncertain@example.com" }), store, { env, fetch: async () => { throw new Error("timeout"); } });
      await pg.query(`UPDATE "MerchantApplication" SET "firstAttemptAt" = NOW() - INTERVAL '25 hours' WHERE id = $1`, [saved.solicitudId]);
      const before = calls.length;
      assert.equal(await notifyMerchantApplication(store, saved.solicitudId, { env, fetch: mockSend, force: true }), "SKIPPED");
      assert.equal(calls.length, before);
      assert.equal((await row(saved.solicitudId)).notificationStatus, "REVIEW");
    });

    await t.test("dominio rechazado conserva pendiente sin ambigüedad y permite corregir luego", async () => {
      const saved = await receiveMerchantApplication(input({ email: "domain@example.com" }), store, { env, fetch: async () => new Response("not verified", { status: 403 }) });
      const failed = await row(saved.solicitudId);
      assert.equal(failed.ambiguousAttempt, false);
      assert.equal(failed.firstAttemptAt, null);
      await notifyMerchantApplication(store, saved.solicitudId, { env, fetch: mockSend, force: true });
      assert.equal((await row(saved.solicitudId)).notificationStatus, "ACCEPTED");
    });

    await t.test("límite diario persistido permite reintentar la solicitud existente", async () => {
      const first = input({ email: "limit@example.com" });
      await receiveMerchantApplication(first, store, { env: {} });
      for (let i = 1; i < 5; i++) await receiveMerchantApplication(input({ email: "limit@example.com", nombreComercio: `Comercio ${i}` }), store, { env: {} });
      await assert.rejects(receiveMerchantApplication(input({ email: "limit@example.com", nombreComercio: "Comercio sexto" }), store, { env: {} }), { status: 429 });
      assert.equal((await receiveMerchantApplication(first, store, { env: {} })).created, false);
    });
  } finally { await pg.close(); }
});
