import assert from "node:assert/strict";
import test from "node:test";
import { randomInt, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { blacklistSchemaStatements } from "../scripts/document-blacklist-schema.mjs";
import { store, core, loadBlacklistModule } from "./document-blacklist-test-loader.mjs";

const connectionString = process.env.BLACKLIST_CLEAR_TEST_DATABASE_URL;

test("PostgreSQL real: limpieza global, rollback, reintentos y concurrencia", { skip: !connectionString }, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Las pruebas sólo pueden ejecutarse contra localhost");
  assert.match(url.pathname, /^\/blacklist_test_clear$/, "Se requiere una base aislada blacklist_test");
  const pool = new pg.Pool({ connectionString });
  // The generated Next.js client uses extensionless TS imports; resolve only its
  // local generated modules for this direct Node test (never rewrite production).
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.includes("/app/generated/prisma/")) {
      try { return nextResolve(specifier, context); } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    }
    return nextResolve(specifier, context);
  } });
  const { PrismaClient } = await import("../app/generated/prisma/client.ts");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const actor = { id: 991001, nombre: "Administrador sintético de pruebas" };
  const document = () => `9${String(randomInt(0, 1_000_000_000)).padStart(12, "0")}`;
  const create = (doc, mutationId = randomUUID()) => store.parseBlacklistMutation("POST", { documento: doc, motivo: "Bloqueo sintético de prueba", mutationId });
  const mutate = (input, who = actor) => prisma.$transaction((tx) => store.mutateBlacklist(tx, input, who), { timeout: 15000 });
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  async function waitForAdvisoryWaiter() {
    for (let i = 0; i < 100; i++) {
      const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'");
      if (result.rows[0].n > 0) return;
      await delay(20);
    }
    assert.fail("La segunda transacción no esperó el lock del documento");
  }
  const clearStore = loadBlacklistModule("lib/document-blacklist-clear.ts", { "@/lib/document-blacklist-core": core });
  const bulkCore = loadBlacklistModule("lib/document-blacklist-bulk-core.ts", { "@/lib/document-blacklist-core": core });
  const bulk = loadBlacklistModule("lib/document-blacklist-bulk-store.ts", { "@/lib/document-blacklist-core": core, "@/lib/document-blacklist-bulk-core": bulkCore });
  const preview = () => clearStore.previewBlacklistClear(prisma, actor);
  const inputFor = async () => ({ motivo: "Limpieza sintética de prueba", mutationId: randomUUID(), confirmed: true, fingerprint: (await preview()).fingerprint });
  const clear = input => prisma.$transaction(tx => clearStore.clearBlacklist(tx, input, actor), { timeout: 15000 });
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS public."Usuario" ("id" INTEGER PRIMARY KEY)');
    await pool.query('CREATE TABLE IF NOT EXISTS public."Venta" ("id" INTEGER PRIMARY KEY)');
    await pool.query('INSERT INTO public."Usuario" ("id") VALUES ($1) ON CONFLICT DO NOTHING', [actor.id]);
    // Seed using only the original table columns, before the additive migration.
    await pool.query(blacklistSchemaStatements[0]);
    const legacyId = randomUUID();
    await pool.query(`INSERT INTO public."ListaNegraDocumento" ("id","documento","motivo","createdByUserId","createdByName","updatedByUserId","updatedByName")
      VALUES ($1,$2,'Registro previo a migración',$3,'Prueba',$3,'Prueba')`, [legacyId, document(), actor.id]);
    for (let run = 0; run < 2; run++) for (const sql of blacklistSchemaStatements) await pool.query(sql);
    const legacy = (await pool.query('SELECT * FROM public."ListaNegraDocumento" WHERE "id"=$1', [legacyId])).rows[0];
    assert.equal(legacy.activa, true); assert.equal(legacy.eliminadaAt, null); assert.equal(legacy.version, 1);
    if ((await preview()).total) await clear(await inputFor());

    await t.test("elimina todas las páginas, activas e inactivas; conserva historial y levanta bloqueos", async () => {
      const records = [];
      for (let n = 0; n < 32; n++) records.push((await mutate(create(document()))).item);
      await mutate(store.parseBlacklistMutation("PATCH", { ...records[0], activa: false, motivo: "Desactivación de prueba", mutationId: randomUUID() }));
      const before = await preview();
      assert.equal(before.total, 32); assert.equal(before.active, 31); assert.equal(before.inactive, 1);
      const input = await inputFor();
      const result = await clear(input);
      assert.equal(result.removed, 32); assert.equal(result.unblocked, 31);
      for (const estado of ["ACTIVA", "INACTIVA", "TODAS"]) {
        const list = await store.listBlacklist(prisma, { q: "", estado, page: 1 });
        assert.equal(list.total, 0); assert.equal(list.items.length, 0);
      }
      await store.assertDocumentAllowed(records[1].documento, prisma);
      const events = await pool.query('SELECT * FROM public."ListaNegraDocumentoEvento" WHERE "registroId"=$1 ORDER BY "createdAt"', [records[1].id]);
      assert.equal(events.rowCount, 2);
      assert.equal(events.rows[1].accion, "ELIMINAR");
      assert.equal(events.rows[1].before.activa, true);
      assert.equal(events.rows[1].after.activa, false);
      assert.ok(events.rows[1].after.eliminadaAt);
      await assert.rejects(pool.query('DELETE FROM public."ListaNegraLimpieza" WHERE "id"=$1', [input.mutationId]), /append-only/);
      await assert.rejects(pool.query('DELETE FROM public."ListaNegraDocumentoEvento" WHERE "registroId"=$1', [records[1].id]), /append-only/);
      const restored = await mutate(create(records[1].documento));
      assert.equal(restored.item.id, records[1].id); assert.equal(restored.item.eliminadaAt, null);
      const bulkInput = bulkCore.parseBlacklistBulkInput({ texto: records[2].documento, motivo: "Registro masivo de prueba" });
      const bulkPreview = await bulk.previewBlacklistBulk(prisma, bulkInput, actor);
      await prisma.$transaction(tx => bulk.commitBlacklistBulk(tx, { ...bulkInput, confirmed: true, mutationId: randomUUID(), fingerprint: bulkPreview.fingerprint }, actor));
      assert.equal((await preview()).active, 2);
      assert.equal((await clear(input)).idempotent, true);
      assert.equal((await preview()).total, 2, "el replay no elimina los registros posteriores");
      await assert.rejects(clear({ ...input, motivo: "Motivo distinto" }), { code: "MUTATION_CONFLICT" });
      await assert.rejects(store.assertDocumentAllowed(records[2].documento, prisma), { code: "DOCUMENT_BLACKLISTED" });
    });

    await t.test("preview obsoleta y dos administradores no eliminan datos no revisados", async () => {
      const stale = await inputFor();
      await mutate(create(document()));
      await assert.rejects(clear(stale), { code: "CLEAR_PREVIEW_CHANGED" });
      const input = await inputFor();
      const results = await Promise.allSettled([clear(input), clear({ ...input, mutationId: randomUUID() })]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.find(r => r.status === "rejected").reason.code, "CLEAR_PREVIEW_CHANGED");
    });

    await t.test("fallo de recibo revierte eliminación y auditoría; el reintento funciona", async () => {
      const record = (await mutate(create(document()))).item;
      const input = await inputFor();
      await assert.rejects(prisma.$transaction(tx => clearStore.clearBlacklist({
        $queryRawUnsafe: (...args) => tx.$queryRawUnsafe(...args),
        $executeRawUnsafe: (sql, ...params) => {
          if (sql.includes('INSERT INTO public."ListaNegraLimpieza"')) throw new Error("Fallo sintético de recibo");
          return tx.$executeRawUnsafe(sql, ...params);
        },
      }, input, actor)), /Fallo sintético/);
      assert.equal((await preview()).total, 1);
      await assert.rejects(store.assertDocumentAllowed(record.documento, prisma), { code: "DOCUMENT_BLACKLISTED" });
      assert.equal((await pool.query('SELECT * FROM public."ListaNegraDocumentoEvento" WHERE "registroId"=$1', [record.id])).rowCount, 1);
      const replays = await Promise.all([clear(input), clear(input)]);
      assert.equal(replays.filter(r => r.idempotent).length, 1);
      assert.equal((await preview()).total, 0);
    });

    await t.test("una alta en curso termina antes de revisar limpieza; no se pierde la nueva cédula", async () => {
      const input = await inputFor();
      const gate = deferred(), release = deferred();
      const writer = prisma.$transaction(async tx => {
        const item = await store.mutateBlacklist(tx, create(document()), actor);
        gate.resolve(); await release.promise; return item;
      }, { timeout: 15000 });
      await gate.promise;
      const cleanup = clear(input);
      const caught = assert.rejects(cleanup, { code: "CLEAR_PREVIEW_CHANGED" });
      try { await waitForAdvisoryWaiter(); } finally { release.resolve(); }
      await writer; await caught;
      assert.equal((await preview()).total, 1);
    });

    await t.test("una importación masiva concurrente invalida la vista previa de limpieza", async () => {
      const input = await inputFor();
      const bulkInput = bulkCore.parseBlacklistBulkInput({ texto: document(), motivo: "Prueba masiva concurrente" });
      const bulkPreview = await bulk.previewBlacklistBulk(prisma, bulkInput, actor);
      const gate = deferred(), release = deferred();
      const writer = prisma.$transaction(async tx => {
        const result = await bulk.commitBlacklistBulk(tx, { ...bulkInput, confirmed: true, mutationId: randomUUID(), fingerprint: bulkPreview.fingerprint }, actor);
        gate.resolve(); await release.promise; return result;
      }, { timeout: 15000 });
      await gate.promise;
      const caught = assert.rejects(clear(input), { code: "CLEAR_PREVIEW_CHANGED" });
      try { await waitForAdvisoryWaiter(); } finally { release.resolve(); }
      await writer; await caught;
      assert.equal((await preview()).total, 2);
    });

    await t.test("limpieza comparte cerrojo por documento con crédito; alta posterior sobrevive", async () => {
      const doc = document();
      await mutate(create(doc));
      const input = await inputFor();
      const gate = deferred(), release = deferred();
      const credit = prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `DOCUMENT_BLACKLIST:${doc}`);
        gate.resolve(); await release.promise;
      }, { timeout: 15000 });
      await gate.promise;
      const cleanup = clear(input);
      try { await waitForAdvisoryWaiter(); } finally { release.resolve(); }
      const writer = mutate(create(document()));
      await credit; await cleanup; await writer;
      assert.equal((await preview()).total, 1);
    });
  } finally { await prisma.$disconnect(); await pool.end(); hooks.deregister(); }
});
