import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomInt } from "node:crypto";
import pg from "pg";
import { secondCreditAuthorizationSchemaStatements } from "../scripts/second-credit-authorization-schema.mjs";
import { store, core } from "./second-credit-authorization-fixture.mjs";

const connectionString = process.env.SECOND_CREDIT_TEST_DATABASE_URL;

test("PostgreSQL aislado: permisos, saldo, auditoría inmutable y carreras de segundo crédito", { skip: !connectionString }, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Las pruebas solamente admiten PostgreSQL local.");
  assert.match(url.pathname, /^\/second_credit_test(?:_[a-z0-9]+)?$/, "Se requiere una base aislada second_credit_test.");
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 10000, max: 8 });
  const actor = { id: randomInt(500000, 900000), nombre: "ADMIN sintético de integración" };
  const document = () => `9${String(randomInt(0, 1_000_000_000)).padStart(12, "0")}`;
  const database = (client) => ({
    $queryRawUnsafe: async (sql, ...args) => (await client.query(sql, args)).rows,
    $executeRawUnsafe: async (sql, ...args) => (await client.query(sql, args)).rowCount,
  });
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(database(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  const mutation = (documentNumber, changes = {}) => core.parseSecondCreditMutation({
    documentNumber, action: "AUTHORIZE", reason: "Autorización sintética verificada por central",
    mutationId: randomUUID(), expectedVersion: 0, ...changes,
  });
  const insertCredit = async (db, doc, money = 1000) => (await db.$queryRawUnsafe(
    `INSERT INTO public."Credito" ("folio","clienteDocumento","montoCredito","cuotaInicial","estado")
     VALUES ($1,$2,$3,100,'GENERADO') RETURNING "id"`, `TEST-${randomUUID()}`, doc, money,
  ))[0].id;
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const read = database(pool);
  try {
    await transaction(async (db) => {
      await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('second-credit-test-schema-setup'))");
      await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS public."Usuario" ("id" INTEGER PRIMARY KEY)');
      await db.$executeRawUnsafe('INSERT INTO public."Usuario" ("id") VALUES ($1) ON CONFLICT DO NOTHING', actor.id);
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS public."Credito" (
        "id" SERIAL PRIMARY KEY, "folio" TEXT NOT NULL UNIQUE, "clienteDocumento" TEXT,
        "montoCredito" FLOAT8 NOT NULL, "cuotaInicial" FLOAT8 NOT NULL, "estado" TEXT NOT NULL
      )`);
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS public."CreditoAbono" (
        "id" SERIAL PRIMARY KEY, "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id"),
        "valor" FLOAT8 NOT NULL, "estado" TEXT NOT NULL
      )`);
      for (let run = 0; run < 2; run++) for (const statement of secondCreditAuthorizationSchemaStatements) await db.$executeRawUnsafe(statement);
    });

    await t.test("esquema no crea autorizaciones y documento normalizado identifica crédito histórico", async () => {
      const doc = document();
      await transaction((db) => insertCredit(db, `CC-${doc}`));
      const item = (await store.getSecondCreditEligibility(read, [doc])).get(doc);
      assert.equal(item.authorization, null);
      assert.equal(item.activeCredits, 1);
      assert.equal(item.canCreate, false);
      await assert.rejects(transaction((db) => store.assertSecondCreditEligibility(db, doc, { lock: true })), { code: "ACTIVE_CREDIT_EXISTS" });
    });

    await t.test("abonos anulados no cierran crédito; pago total sí libera la cédula sin autorización", async () => {
      const doc = document();
      const id = await transaction((db) => insertCredit(db, doc));
      await pool.query('INSERT INTO public."CreditoAbono" ("creditoId","valor","estado") VALUES ($1,1000,\'ANULADO\')', [id]);
      await assert.rejects(transaction((db) => store.assertSecondCreditEligibility(db, doc, { lock: true })), { code: "ACTIVE_CREDIT_EXISTS" });
      await pool.query('INSERT INTO public."CreditoAbono" ("creditoId","valor","estado") VALUES ($1,1000,\'ACTIVO\')', [id]);
      assert.equal(await transaction((db) => store.assertSecondCreditEligibility(db, doc, { lock: true })), null);
    });

    await t.test("alta, replay, revocación, versión y evento append-only reales", async () => {
      const doc = document();
      await transaction((db) => insertCredit(db, doc));
      const input = mutation(doc);
      const grant = await transaction((db) => store.mutateSecondCreditAuthorization(db, input, actor));
      assert.equal(grant.authorization.active, true);
      assert.equal((await transaction((db) => store.mutateSecondCreditAuthorization(db, input, actor))).idempotent, true);
      assert.equal((await store.assertSecondCreditEligibility(read, doc)).documento, doc);
      await assert.rejects(transaction((db) => store.mutateSecondCreditAuthorization(db, mutation(doc), actor)), { code: "VERSION_CONFLICT" });
      const revoke = mutation(doc, { action: "REVOKE", expectedVersion: 1 });
      await transaction((db) => store.mutateSecondCreditAuthorization(db, revoke, actor));
      await assert.rejects(store.assertSecondCreditEligibility(read, doc), { code: "ACTIVE_CREDIT_EXISTS" });
      assert.equal((await transaction((db) => store.mutateSecondCreditAuthorization(db, input, actor))).authorization.active, false);
      const rows = await pool.query('SELECT "actorUserId","before","after" FROM public."SecondCreditAuthorizationEvent" WHERE "authorizationId"=$1 ORDER BY "createdAt"', [grant.authorization.id]);
      assert.equal(rows.rowCount, 2);
      assert.equal(rows.rows[0].actorUserId, actor.id);
      assert.equal(rows.rows[0].before, null);
      assert.equal(rows.rows[1].before.version, 1);
      assert.equal(rows.rows[1].after.active, false);
      await assert.rejects(pool.query('UPDATE public."SecondCreditAuthorizationEvent" SET "reason"=\'Cambio indebido\' WHERE "authorizationId"=$1', [grant.authorization.id]), /append-only/);
      await assert.rejects(pool.query('DELETE FROM public."SecondCreditAuthorizationEvent" WHERE "authorizationId"=$1', [grant.authorization.id]), /append-only/);
    });

    await t.test("dos solicitudes simultáneas comparten lock y solo una crea el segundo", async () => {
      const doc = document();
      await transaction((db) => insertCredit(db, doc));
      await transaction((db) => store.mutateSecondCreditAuthorization(db, mutation(doc), actor));
      const locked = deferred();
      const release = deferred();
      const first = transaction(async (db) => {
        const audit = await store.assertSecondCreditEligibility(db, doc, { lock: true });
        assert.equal(audit.activeCreditIds.length, 1);
        locked.resolve();
        await release.promise;
        return insertCredit(db, doc);
      });
      await locked.promise;
      const second = transaction(async (db) => {
        await store.assertSecondCreditEligibility(db, doc, { lock: true });
        return insertCredit(db, doc);
      });
      release.resolve();
      const results = await Promise.allSettled([first, second]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.find((result) => result.status === "rejected").reason.code, "SECOND_CREDIT_LIMIT_REACHED");
      assert.equal((await store.getSecondCreditEligibility(read, [doc])).get(doc).activeCredits, 2);
    });

    await t.test("revocación que gana el lock bloquea la venta que esperaba", async () => {
      const doc = document();
      await transaction((db) => insertCredit(db, doc));
      await transaction((db) => store.mutateSecondCreditAuthorization(db, mutation(doc), actor));
      const locked = deferred();
      const release = deferred();
      const revoke = transaction(async (db) => {
        await store.lockSecondCreditDocument(db, doc);
        locked.resolve();
        await release.promise;
        return store.mutateSecondCreditAuthorization(db, mutation(doc, { action: "REVOKE", expectedVersion: 1 }), actor);
      });
      await locked.promise;
      const creation = transaction(async (db) => {
        await store.assertSecondCreditEligibility(db, doc, { lock: true });
        return insertCredit(db, doc);
      });
      release.resolve();
      const results = await Promise.allSettled([revoke, creation]);
      assert.equal(results[0].status, "fulfilled");
      assert.equal(results[1].status, "rejected");
      assert.equal(results[1].reason.code, "ACTIVE_CREDIT_EXISTS");
      assert.equal((await store.getSecondCreditEligibility(read, [doc])).get(doc).activeCredits, 1);
    });

    await t.test("fallo al guardar auditoría revierte una autorización sin registro parcial", async () => {
      const doc = document();
      const input = mutation(doc);
      await assert.rejects(transaction((db) => store.mutateSecondCreditAuthorization({
        ...db,
        $executeRawUnsafe(sql, ...args) {
          if (sql.includes('INSERT INTO public."SecondCreditAuthorizationEvent"')) throw new Error("Fallo de auditoría sintético");
          return db.$executeRawUnsafe(sql, ...args);
        },
      }, input, actor)), /Fallo de auditoría/);
      assert.equal((await store.getSecondCreditEligibility(read, [doc])).get(doc).authorization, null);
    });
  } finally { await pool.end(); }
});